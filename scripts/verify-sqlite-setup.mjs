// SQLite + first-run bootstrap check for the delivered image.
//
// It proves, on one throwaway instance without Redis and without Postgres:
//   1. the /setup wizard path creates a working administrator;
//   2. the per-day token budget and the per-day request budget are both saved
//      and both enforced on the plain database selection path;
//   3. image requests (which report no usage) are stopped by the request budget.
//
// Usage: docker run -d --name nap-sqlite -p 127.0.0.1:3811:3000 new-api-daily-limit:0.2.0
//        node scripts/verify-sqlite-setup.mjs [base_url] [container]
const BASE = process.argv[2] || 'http://localhost:3811';
const CONTAINER = process.argv[3] || 'nap-sqlite';
const ADMIN_USER = 'setuproot';
const ADMIN_PASS = 'Setup-Verify-123';
const MOCK_BASE = 'http://host.docker.internal:3999';
const TEXT_MODEL = 'verify-sqlite-text';
const IMAGE_MODEL = 'verify-sqlite-image';

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

async function relay(path, key, model, payload) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer sk-${key}` },
    body: JSON.stringify({ model, ...payload }),
  });
  const text = await res.text();
  let code = '';
  try {
    code = JSON.parse(text)?.error?.code || '';
  } catch {
    /* keep empty */
  }
  return { status: res.status, code, body: text.slice(0, 140) };
}

async function createChannel(name, model, setting) {
  const created = await api('/api/channel/', {
    method: 'POST',
    body: {
      mode: 'single',
      channel: {
        name,
        type: 1,
        base_url: MOCK_BASE,
        key: 'mock-key',
        models: model,
        group: 'default',
        priority: 0,
        weight: 0,
        status: 1,
        setting,
      },
    },
  });
  if (created.json.success !== true) {
    return { channel: null, message: JSON.stringify(created.json).slice(0, 160) };
  }
  const list = await api('/api/channel/');
  const items = Array.isArray(list.json.data) ? list.json.data : list.json.data?.items || [];
  return { channel: items.find((c) => c.name === name) || null, message: '' };
}

// SQLite stores the plaintext token key and the API only ever returns a mask,
// so the PoC reads the freshly copied database file to obtain it.
async function readTokenKeyFromSqlite(name) {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  // The live database runs in WAL mode: the main file can stay a few kilobytes
  // while every recent write sits in -wal. Copy all three, or the read sees an
  // empty database.
  const dir = `${await (await import('node:os')).tmpdir()}/verify-sqlite-${process.pid}`;
  fs.mkdirSync(dir, { recursive: true });
  try {
    execFileSync('docker', ['cp', `${CONTAINER}:/data/one-api.db`, `${dir}/one-api.db`]);
    for (const suffix of ['-wal', '-shm']) {
      try {
        execFileSync('docker', ['cp', `${CONTAINER}:/data/one-api.db${suffix}`, `${dir}/one-api.db${suffix}`]);
      } catch {
        /* the side files disappear once the database checkpoints */
      }
    }
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(`${dir}/one-api.db`);
    try {
      const row = db.prepare('select key from tokens where name = ? limit 1').get(name);
      return row?.key || '';
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const before = await api('/api/setup');
  record(
    'fresh instance reports sqlite and no root yet',
    before.json.data?.database_type === 'sqlite' && before.json.data?.root_init === false,
    `database_type=${before.json.data?.database_type} root_init=${before.json.data?.root_init}`
  );

  const setup = await api('/api/setup', {
    method: 'POST',
    body: {
      username: ADMIN_USER,
      password: ADMIN_PASS,
      confirmPassword: ADMIN_PASS,
      SelfUseModeEnabled: true,
      DemoSiteEnabled: false,
    },
  });
  record('setup wizard creates the administrator', setup.json.success === true, JSON.stringify(setup.json).slice(0, 120));

  const after = await api('/api/setup');
  record(
    'setup marked complete after wizard',
    after.json.data?.status === true,
    `status=${after.json.data?.status}（接口在 Setup=true 时提前返回，root_init 不再回填）`
  );

  const login = await api('/api/user/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } });
  accessToken = login.json.data?.access_token || '';
  adminId = String(login.json.data?.user?.id || '');
  record('wizard account can log in', !!accessToken, `id=${adminId} role=${login.json.data?.user?.role}`);

  const channels = await api('/api/channel/');
  record('wizard account has admin channel access', channels.json.success === true, `status=${channels.status}`);

  await api('/api/option/', {
    method: 'PUT',
    body: { key: 'ModelPrice', value: JSON.stringify({ [TEXT_MODEL]: 0.01, [IMAGE_MODEL]: 0.01 }) },
  });
  await api('/api/token/', { method: 'POST', body: { name: 'verify-sqlite', expired_time: -1, unlimited_quota: true } });
  let apiKey = '';
  let keyError = '';
  try {
    const raw = await readTokenKeyFromSqlite('verify-sqlite');
    apiKey = raw.startsWith('sk-') ? raw.slice(3) : raw;
  } catch (err) {
    keyError = err.message.slice(0, 120);
  }
  record('plaintext token key readable from sqlite', !!apiKey, keyError || `len=${apiKey.length}`);
  if (!apiKey) {
    console.log('\ncannot continue without a relay key');
    process.exit(1);
  }

  const text = await createChannel('verify-sqlite-text', TEXT_MODEL, JSON.stringify({ daily_token_limit: 10 }));
  const image = await createChannel('verify-sqlite-image', IMAGE_MODEL, JSON.stringify({ daily_request_limit: 1 }));
  record('both budget channels created on sqlite', !!text.channel && !!image.channel, `text=${text.channel?.id} image=${image.channel?.id} ${text.message}${image.message}`);

  const echoSetting = (row) => row?.setting || '';
  record(
    'settings persisted verbatim',
    echoSetting(text.channel).includes('daily_token_limit') && echoSetting(image.channel).includes('daily_request_limit'),
    `text=${echoSetting(text.channel)} image=${echoSetting(image.channel)}`
  );

  // No memory cache and no Redis on this instance: selection reads the database
  // and counters live in-process, which is exactly the smallest supported setup.
  const t1 = await relay('/v1/chat/completions', apiKey, TEXT_MODEL, { messages: [{ role: 'user', content: 'hi' }] });
  await new Promise((r) => setTimeout(r, 2000));
  const t2 = await relay('/v1/chat/completions', apiKey, TEXT_MODEL, { messages: [{ role: 'user', content: 'hi' }] });
  record(
    'token budget enforced on sqlite without Redis',
    t1.status === 200 && t2.status === 429 && t2.code === 'channel:daily_token_limit_exceeded',
    `${t1.status}/${t2.status} code=${t2.code || '-'}`
  );

  const i1 = await relay('/v1/images/generations', apiKey, IMAGE_MODEL, { prompt: 'a cat', n: 1 });
  await new Promise((r) => setTimeout(r, 2000));
  const i2 = await relay('/v1/images/generations', apiKey, IMAGE_MODEL, { prompt: 'a cat', n: 1 });
  record(
    'request budget stops no-usage image calls',
    i1.status === 200 && i2.status === 429 && i2.code === 'channel:daily_request_limit_exceeded',
    `${i1.status}/${i2.status} code=${i2.code || '-'}`
  );

  for (const row of [text.channel, image.channel]) {
    if (row) await api(`/api/channel/${row.id}`, { method: 'DELETE' });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('error:', err.message);
  process.exit(1);
});
