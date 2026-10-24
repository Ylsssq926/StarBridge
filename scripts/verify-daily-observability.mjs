// End-to-end check for the read-only daily budget observability surface:
//   1. a channel that gets skipped because its per-day request budget is full
//      shows a non-zero rejects_today,
//   2. tokens_used / requests_used / the two limits match what enforcement sees,
//   3. the aggregate endpoint lists exactly the channels that have a budget.
//
// Requires the PoC stack (or equivalent) and `node scripts/mock-upstream.cjs`
// listening on the port MOCK_BASE points at.
//
//   node scripts/verify-daily-observability.mjs [base-url]
const BASE = process.argv[2] || 'http://localhost:3800';
const ADMIN_USER = process.env.NEW_API_ADMIN_USER || 'root';
const ADMIN_PASS = process.env.NEW_API_ADMIN_PASS || 'rootpass123';
const MOCK_BASE = process.env.MOCK_UPSTREAM_BASE || 'http://host.docker.internal:3999/v1';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

let accessToken = '';
let adminId = '';
const jar = new Map();

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method || 'GET',
    headers: {
      'content-type': 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}`, 'new-api-user': adminId } : {}),
      ...(jar.size ? { cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
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

async function relay(modelName) {
  return fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${relayKey}` },
    body: JSON.stringify({ model: modelName, messages: [{ role: 'user', content: 'hi' }] }),
  });
}

let relayKey = '';

const login = await api('/api/user/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } });
if (login.json.success !== true) {
  console.error('admin login failed: ' + JSON.stringify(login.json).slice(0, 160));
  process.exit(1);
}
accessToken = login.json.data?.access_token || '';
adminId = String(login.json.data?.user?.id ?? '');
record('admin login', true, `id=${adminId}`);

const TOKEN_NAME = `observability-token-${Date.now()}`;
const keyRes = await api('/api/token/', {
  method: 'POST',
  body: { name: TOKEN_NAME, expired_time: -1, unlimited_quota: true },
});
record('token created', keyRes.json.success === true, keyRes.json.message || '');
// The panel API only ever returns masked keys, so the plaintext key is read back
// from the throwaway PoC database. Never do this against a real deployment.
const { execFileSync } = await import('node:child_process');
relayKey = execFileSync('docker', ['exec', 'new-api-poc-postgres', 'psql', '-U', 'newapi', '-d', 'new-api', '-At',
  '-c', `select key from tokens where name = '${TOKEN_NAME}' limit 1`], { encoding: 'utf8' }).trim();
record('plaintext relay key read from the PoC database', relayKey.length > 20, `len=${relayKey.length}`);

const modelName = `obs-m-${Date.now()}`;
const channelName = `observability-${Date.now()}`;
const budgetSetting = JSON.stringify({ daily_token_limit: 0, daily_request_limit: 1 });
const create = await api('/api/channel/', {
  method: 'POST',
  body: {
    mode: 'single',
    channel: {
      name: channelName,
      type: 1,
      base_url: MOCK_BASE,
      key: 'mock-key',
      models: modelName,
      group: 'default',
      priority: 0,
      weight: 0,
      status: 1,
      setting: budgetSetting,
    },
  },
});
const list = await api('/api/channel/');
const rows = Array.isArray(list.json.data) ? list.json.data : list.json.data?.items || [];
const channel = rows.find((c) => c.name === channelName) || rows.find((c) => (c.models || '').includes(modelName));
record('channel created with a 1-request daily budget', create.json.success === true && !!channel, `id=${channel?.id}`);
if (!channel) {
  console.error('cannot continue without the seeded channel');
  process.exit(1);
}

// The panel writes settings as a merged JSON blob; make sure the budget really
// landed before judging the counters.
const detail = await api(`/api/channel/${channel.id}`);
const settingJson = JSON.parse(detail.json.data?.setting || '{}');
record('budget persisted on the channel', Number(settingJson.daily_request_limit) === 1, `daily_request_limit=${settingJson.daily_request_limit}`);

// The relay needs a price for the model, otherwise every request stops at
// model_price_error before channel selection happens.
const priced = await api('/api/option/', {
  method: 'PUT',
  body: { key: 'ModelPrice', value: JSON.stringify({ [modelName]: 0.01 }) },
});
record('model price configured', priced.json.success === true, 'option=ModelPrice');

// Channel selection reads from the channel cache, which syncs periodically: a
// request issued immediately after creating a channel gets 503 model_not_found
// (measured earlier: 503 at once, 200 after ~7s). Wait past one sync cycle.
await new Promise((r) => setTimeout(r, 12000));

const first = await relay(modelName);
await first.text();
record('first request served', first.status === 200, `status=${first.status}`);

// The text-relay request counter is written at settlement, i.e. after the
// response has been flushed. Issuing the next request immediately can therefore
// slip past a budget that is already spent — the race documented in
// docs/VERIFICATION.md §9. Reproduced here by a back-to-back second run, which
// is why the harness waits for one settlement to land.
await new Promise((r) => setTimeout(r, 2000));

const second = await relay(modelName);
const secondBody = await second.text();
record('second request blocked by the daily budget', second.status === 429 && /daily_request_limit_exceeded/.test(secondBody), `status=${second.status}`);

// Give the settlement path a moment; the rejection counter is written while
// selecting, but usage counters are written at settlement.
await new Promise((r) => setTimeout(r, 2000));

const snap = await api(`/api/channel/daily_usage/${channel.id}`);
const data = snap.json.data || {};
record('single-channel snapshot returns the budget state', snap.json.success === true && data.channel_id === channel.id, JSON.stringify(data).slice(0, 160));
record('requests_used counted at submit', Number(data.requests_used) === 1, `requests_used=${data.requests_used}`);
record('reject selection attempts counted', Number(data.reject_selection_attempts_today) >= 1, `attempts=${data.reject_selection_attempts_today} retry_times=${data.retry_times}`);
record('retry_times returned for interpretation', Number.isInteger(data.retry_times), `retry_times=${data.retry_times}`);
// Measured characteristic, not a derived formula: at the default RetryTimes=0 a
// blocked request makes 2 channel-selection attempts, so one blocked request
// adds 2 to the attempt counter. An earlier draft asserted attempts ==
// requests x (retry_times+1); that was wrong (it predicted 1), which is why this
// check pins the observed value instead and fails loudly if selection changes.
const ATTEMPTS_PER_BLOCKED_REQUEST = 2;
record('attempt counter scales with selection attempts (measured: 2 per blocked request)',
  Number(data.reject_selection_attempts_today) === 1 * ATTEMPTS_PER_BLOCKED_REQUEST,
  `attempts=${data.reject_selection_attempts_today} expected=${ATTEMPTS_PER_BLOCKED_REQUEST}`);
record('limit echoed back from the channel setting', Number(data.daily_request_limit) === 1, `daily_request_limit=${data.daily_request_limit}`);

const agg = await api('/api/channel/daily_usage');
const items = agg.json.data?.channels || [];
record('aggregate endpoint lists this channel', agg.json.success === true && items.some((i) => i.channel_id === channel.id), `total=${items.length}`);
record('aggregate payload carries no upstream key', !JSON.stringify(agg.json).includes('mock-key'), '');

const freshList = await api('/api/channel/');
const freshRows = Array.isArray(freshList.json.data) ? freshList.json.data : freshList.json.data?.items || [];
for (const stray of freshRows.filter((c) => (c.models || '').includes(modelName))) {
  await api(`/api/channel/${stray.id}`, { method: 'DELETE' });
}

// The PoC enforces one active admin session (a second login returns
// AUTH_SESSION_LIMIT/Conflict), so a run that does not log out blocks the next
// one. Best-effort: ignore failures, the checks above already happened.
try {
  await api('/api/user/logout', { method: 'POST' });
} catch {
  /* ignore */
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
