// Live boundary check for the channel daily token limit.
// Usage: node scripts/verify-daily-limit.mjs [base_url]
const BASE = process.argv[2] || 'http://localhost:3800';
const ADMIN_USER = process.env.NEW_API_ADMIN_USER || 'root';
const ADMIN_PASS = process.env.NEW_API_ADMIN_PASS || 'rootpass123';
const CHANNEL_NAME = 'verify-daily-limit';
const TOKEN_NAME = 'verify-daily-limit';
const MODEL = 'mock-model';

let cookie = '';
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const jar = new Map();
let accessToken = '';
let adminId = '';

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}`, 'new-api-user': adminId } : {}),
      ...(jar.size ? { cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const pair of res.headers.getSetCookie?.() || []) {
    const [k, ...rest] = pair.split('=');
    jar.set(k.trim(), rest.join('=').split(';')[0]);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
}

async function relay(token, label) {
  const key = String(token).startsWith('sk-') ? token : `sk-${token}`;
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: label }] }),
  });
  const text = await res.text();
  let code = '';
  try {
    code = JSON.parse(text)?.error?.code || '';
  } catch {
    /* keep empty */
  }
  return { status: res.status, code, body: text.slice(0, 160) };
}

function waitCache() {
  return new Promise((r) => setTimeout(r, 7000));
}

async function listChannels() {
  const list = await api('/api/channel/');
  const d = list.json.data;
  return Array.isArray(d) ? d : d?.items || [];
}

async function findChannel() {
  return (await listChannels()).find((c) => c.name === CHANNEL_NAME) || null;
}

async function main() {
  const login = await api('/api/user/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } });
  if (!login.json.success) {
    console.error('login failed:', JSON.stringify(login.json).slice(0, 200));
    process.exit(1);
  }
  record('admin login', login.json.success === true, `user=${ADMIN_USER} id=${login.json.data?.user?.id}`);
  accessToken = login.json.data?.access_token || '';
  adminId = String(login.json.data?.user?.id || '');
  if (!accessToken) {
    console.error('no access token in login response');
    process.exit(1);
  }

  const tokenRes = await api('/api/token/', {
    method: 'POST',
    body: { name: TOKEN_NAME, expired_time: -1, unlimited_quota: true },
  });
  if (tokenRes.json.success !== true) {
    console.error('token create failed:', JSON.stringify(tokenRes.json).slice(0, 300));
    process.exit(1);
  }
  // The API only ever returns masked keys, so the PoC reads the plaintext key
  // from the database. Never do this outside a throwaway stack.
  const { execFileSync } = await import('node:child_process');
  const container = process.env.POC_POSTGRES_CONTAINER || 'new-api-poc-postgres';
  const raw = execFileSync(
    'docker',
    ['exec', container, 'psql', '-U', 'newapi', '-d', 'new-api', '-tAc', `select key from tokens where name = '${TOKEN_NAME}' limit 1`],
    { encoding: 'utf8' },
  ).trim();
  if (!raw) {
    console.error(`token ${TOKEN_NAME} not found in database (container ${container})`);
    process.exit(1);
  }
  const apiKey = raw.startsWith('sk-') ? raw.slice(3) : raw;
  record('api token created', true, `masked=${tokenRes.json.message || 'ok'} db-key=len${apiKey.length}`);

  // The relay needs a price for the model, otherwise every request stops at
  // model_price_error before channel selection happens.
  const priced = await api('/api/option/', {
    method: 'PUT',
    body: { key: 'ModelPrice', value: JSON.stringify({ [MODEL]: 0.01 }) },
  });
  record('model price configured', priced.json.success === true, 'option=ModelPrice');

  let channel = await findChannel();
  if (!channel) {
    const created = await api('/api/channel/', {
      method: 'POST',
      body: {
        mode: 'single',
        channel: {
          name: CHANNEL_NAME,
          type: 1,
          base_url: 'http://host.docker.internal:3999',
          key: 'mock-key',
          models: MODEL,
          group: 'default',
          priority: 0,
          weight: 0,
          status: 1,
          setting: JSON.stringify({ daily_token_limit: 10 }),
        },
      },
    });
    if (!created.json.success) {
      console.error('channel create failed:', JSON.stringify(created.json).slice(0, 300));
      process.exit(1);
    }
    channel = await findChannel();
  }
  if (!channel) {
    console.error('channel not visible after create');
    process.exit(1);
  }
  record('channel created', true, `id=${channel.id} setting=${channel.setting}`);

  // Case 1: limit exactly equals one request's billable usage (10 tokens).
  await api(`/api/channel/${channel.id}/status`, { method: 'PUT', body: { status: 1 } });
  await api('/api/channel/', { method: 'PUT', body: { id: channel.id, setting: JSON.stringify({ daily_token_limit: 10 }) } });
  const first = await relay(apiKey, 'first');
  record('limit=10 first request', first.status === 200, `status=${first.status}`);
  // Usage is recorded at settlement, which runs after the response is flushed,
  // so allow the write to land before probing the cap.
  await new Promise((r) => setTimeout(r, 2000));
  const second = await relay(apiKey, 'second');
  record(
    'limit=10 second request blocked with 429',
    second.status === 429 && second.code === 'channel:daily_token_limit_exceeded',
    `status=${second.status} code=${second.code || '-'} body=${second.body.slice(0, 90)}`,
  );

  // Case 2: limit=0 means unlimited again.
  await api('/api/channel/', { method: 'PUT', body: { id: channel.id, setting: JSON.stringify({ daily_token_limit: 0 }) } });
  await waitCache();
  const unlimited = await relay(apiKey, 'unlimited');
  const unlimited2 = await relay(apiKey, 'unlimited-2');
  record(
    'limit=0 unlimited after cap was reached',
    unlimited.status === 200 && unlimited2.status === 200,
    `status=${unlimited.status}/${unlimited2.status}`,
  );

  // Case 3: re-arming a lower cap blocks immediately (usage already above it).
  await api('/api/channel/', { method: 'PUT', body: { id: channel.id, setting: JSON.stringify({ daily_token_limit: 10 }) } });
  await waitCache();
  const rearmed = await relay(apiKey, 'rearmed');
  record('lower cap re-arms on existing usage', rearmed.status === 429, `status=${rearmed.status} code=${rearmed.code || '-'}`);

  // Case 4: raising the cap unblocks without restart (cache refresh window).
  await api('/api/channel/', { method: 'PUT', body: { id: channel.id, setting: JSON.stringify({ daily_token_limit: 100000 }) } });
  await waitCache();
  const raised = await relay(apiKey, 'raised');
  record('raise cap unblocks within cache sync', raised.status === 200, `status=${raised.status} body=${raised.body.slice(0, 80)}`);

  const cleanup = await api(`/api/channel/${channel.id}`, { method: 'DELETE' });
  record('cleanup channel deleted', cleanup.json.success === true, JSON.stringify(cleanup.json).slice(0, 80));
  for (const stray of await listChannels()) {
    if (stray.name === 'price-probe' || stray.name === CHANNEL_NAME) {
      await api(`/api/channel/${stray.id}`, { method: 'DELETE' });
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error('error:', err.message);
  process.exit(1);
});
