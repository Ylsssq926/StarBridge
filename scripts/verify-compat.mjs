// Protocol and wiring compatibility check against the running PoC stack.
// Usage: node scripts/verify-compat.mjs [base_url]
const BASE = process.argv[2] || 'http://localhost:3800';
const ADMIN_USER = process.env.NEW_API_ADMIN_USER || 'root';
const ADMIN_PASS = process.env.NEW_API_ADMIN_PASS || 'rootpass123';
const TOKEN_NAME = 'verify-compat';
const MODEL = 'mock-model';
const MOCK_BASE = 'http://host.docker.internal:3999';
const SIDECAR_BASE = 'http://aiclient2api:3000';

const jar = new Map();
let accessToken = '';
let adminId = '';
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

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
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: { raw: text.slice(0, 200) } };
  }
}

async function relay(path, key, payload) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer sk-${key}` },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = {};
  }
  return { status: res.status, body: text.slice(0, 200), code: parsed?.error?.code || '', message: parsed?.error?.message || '' };
}

async function ensureChannel(name, baseUrl, extra = {}) {
  const list = await api('/api/channel/');
  const items = Array.isArray(list.json.data) ? list.json.data : list.json.data?.items || [];
  const existing = items.find((c) => c.name === name);
  if (existing) return existing;
  await api('/api/channel/', {
    method: 'POST',
    body: {
      mode: 'single',
      channel: {
        name,
        type: 1,
        base_url: baseUrl,
        key: 'mock-key',
        models: MODEL,
        group: 'default',
        priority: 0,
        weight: 0,
        status: 1,
        setting: '{}',
        ...extra,
      },
    },
  });
  const after = await api('/api/channel/');
  const items2 = Array.isArray(after.json.data) ? after.json.data : after.json.data?.items || [];
  return items2.find((c) => c.name === name) || null;
}

async function removeChannel(id) {
  await api(`/api/channel/${id}`, { method: 'DELETE' });
}

async function main() {
  const login = await api('/api/user/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } });
  accessToken = login.json.data?.access_token || '';
  adminId = String(login.json.data?.user?.id || '');
  if (!accessToken) {
    console.error('login failed:', JSON.stringify(login.json).slice(0, 200));
    process.exit(1);
  }

  await api('/api/option/', { method: 'PUT', body: { key: 'ModelPrice', value: JSON.stringify({ [MODEL]: 0.01 }) } });

  const { execFileSync } = await import('node:child_process');
  const container = process.env.POC_POSTGRES_CONTAINER || 'new-api-poc-postgres';
  let key = '';
  try {
    await api('/api/token/', { method: 'POST', body: { name: TOKEN_NAME, expired_time: -1, unlimited_quota: true } });
    const raw = execFileSync(
      'docker',
      ['exec', container, 'psql', '-U', 'newapi', '-d', 'new-api', '-tAc', `select key from tokens where name = '${TOKEN_NAME}' order by id desc limit 1`],
      { encoding: 'utf8' },
    ).trim();
    key = raw.startsWith('sk-') ? raw.slice(3) : raw;
  } catch {
    /* handled below */
  }
  if (!key) {
    console.error(`no plaintext key for token ${TOKEN_NAME}; set POC_POSTGRES_CONTAINER`);
    process.exit(1);
  }

  const mock = await ensureChannel('verify-compat-mock', MOCK_BASE);
  if (!mock) {
    console.error('mock channel not created');
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 6000));

  const chat = await relay('/v1/chat/completions', key, { model: MODEL, messages: [{ role: 'user', content: 'hi' }] });
  record('openai chat completions passthrough', chat.status === 200, `status=${chat.status}`);

  const claude = await relay('/v1/messages', key, { model: MODEL, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] });
  record('claude messages format on openai channel', claude.status === 200, `status=${claude.status} ${claude.message.slice(0, 60)}`);

  const gemini = await relay('/v1beta/models/mock-model:generateContent', key, {
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
  });
  record('gemini generateContent route reachable', gemini.status < 500, `status=${gemini.status} ${(gemini.message || gemini.code).slice(0, 60)}`);

  const images = await relay('/v1/images/generations', key, { model: MODEL, prompt: 'a cat', n: 1 });
  record('images generations on openai channel', images.status === 200, `status=${images.status} ${(images.message || 'ok').slice(0, 60)}`);

  const unknown = await relay('/v1/chat/completions', key, { model: 'model-nobody-serves', messages: [] });
  // Upstream semantics: no candidate channel is 503, and must stay distinct
  // from the daily cap's 429.
  record(
    'unknown model is 503 not 429',
    unknown.status === 503 && /no available channel/i.test(unknown.message),
    `status=${unknown.status} ${(unknown.message || unknown.code).slice(0, 70)}`,
  );

  const badAuth = await relay('/v1/chat/completions', 'not-a-real-token', { model: MODEL, messages: [] });
  record('invalid api key rejected', badAuth.status === 401, `status=${badAuth.status}`);

  const sidecar = await ensureChannel('verify-compat-sidecar', `${SIDECAR_BASE}/v1`);
  let sidecarProbe = null;
  if (sidecar) {
    await new Promise((r) => setTimeout(r, 6000));
    sidecarProbe = await relay('/v1/chat/completions', key, { model: MODEL, messages: [{ role: 'user', content: 'hi' }] });
    const reached = !/dial tcp|no such host|connection refused/i.test(sidecarProbe.message + sidecarProbe.body);
    record('gateway reaches AIClient2API over the docker network', reached, `status=${sidecarProbe.status} ${(sidecarProbe.message || sidecarProbe.code).slice(0, 70)}`);
    await removeChannel(sidecar.id);
  } else {
    record('gateway reaches AIClient2API over the docker network', false, 'sidecar channel not created');
  }

  await removeChannel(mock.id);

  // Same cleanup convention as the other two harnesses: the token list endpoint
  // is paginated ({page,page_size,total,items}), so resolve ids through
  // keyword search and delete them, then re-check. Note the delete is a soft
  // delete (tokens.deleted_at), so count live rows with deleted_at is null.
  const tokenHits = await api(`/api/token/search?keyword=${encodeURIComponent(TOKEN_NAME)}`);
  for (const stale of tokenHits.json.data?.items || []) {
    if (stale?.name === TOKEN_NAME) await api(`/api/token/${stale.id}`, { method: 'DELETE' });
  }
  const tokenLeft = await api(`/api/token/search?keyword=${encodeURIComponent(TOKEN_NAME)}`);
  const liveTokens = (tokenLeft.json.data?.items || []).filter((t) => t?.name === TOKEN_NAME);
  record('token cleaned up', liveTokens.length === 0, `left=${liveTokens.length}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('note: run scripts/verify-daily-limit.mjs for the per-channel cap matrix');
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('error:', err.message);
  process.exit(1);
});
