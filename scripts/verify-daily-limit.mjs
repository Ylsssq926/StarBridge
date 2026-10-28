// Live boundary check for the channel daily token limit.
// Usage: node scripts/verify-daily-limit.mjs [base_url]
const BASE = process.argv[2] || 'http://localhost:3800';
import { adminCredentials } from './poc-credentials.mjs';
const { user: ADMIN_USER, pass: ADMIN_PASS } = adminCredentials('verify-daily-limit.mjs');
const CHANNEL_NAME = 'verify-daily-limit';
const IMAGE_CHANNEL_NAME = 'verify-request-limit-image';
const REQUEST_CHANNEL_NAME = 'verify-request-limit-text';
const UG_CHANNEL_NAME = 'verify-user-group-budget';
const MK_CHANNEL_NAME = 'verify-multi-key-budget';
const MK_AUTO_NAME = 'verify-multi-key-auto';
const MK_RPM_NAME = 'verify-multi-key-rpm';
const MK_RATE_NAME = 'verify-multi-key-429';
const MK_AFFINITY_NAME = 'verify-multi-key-affinity';
const IMAGE_MODEL = 'verify-image-model';
const REQUEST_MODEL = 'verify-request-model';
const RPM_MODEL = 'verify-rpm-model';
const RATE_MODEL = 'verify-rate-model';
const AFFINITY_MODEL = 'verify-affinity-model';
const AUTO_MODEL = 'verify-auto-model';
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

async function createChannel(name, model, setting) {
  await api('/api/channel/', {
    method: 'POST',
    body: {
      mode: 'single',
      channel: {
        name,
        type: 1,
        base_url: 'http://host.docker.internal:3999',
        key: 'mock-key',
        models: model,
        group: 'default',
        priority: 0,
        weight: 0,
        status: 1,
        setting: JSON.stringify(setting),
      },
    },
  });
  const items = await listChannels();
  return items.find((c) => c.name === name) || null;
}

async function createMultiKeyChannel(name, keys, model) {
  for (const stray of await listChannels()) {
    if (stray.name === name) await api(`/api/channel/${stray.id}`, { method: 'DELETE' });
  }
  await api('/api/channel/', {
    method: 'POST',
    body: {
      mode: 'multi_to_single',
      multi_key_mode: 'polling',
      channel: {
        name,
        type: 1,
        base_url: 'http://host.docker.internal:3999',
        key: keys,
        models: model,
        group: 'default',
        priority: 0,
        weight: 0,
        status: 1,
      },
    },
  });
  await waitCache();
  const items = await listChannels();
  return items.find((c) => c.name === name) || null;
}

async function relayModel(path, key, model, payload) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer sk-${key}` },
    body: JSON.stringify(payload),
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

async function relayChat(key, model) {
  return relayModel('/v1/chat/completions', key, model, { model, messages: [{ role: 'user', content: 'hi' }] });
}

async function relayImage(key, model) {
  return relayModel('/v1/images/generations', key, model, { model, prompt: 'a cat', n: 1 });
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
  // The mock keeps "fails once" credentials in memory, so a second run against
  // the same process would never see the failure that case 11 depends on.
  const mockBase = process.env.MOCK_BASE || 'http://localhost:3999';
  const mockReset = await fetch(`${mockBase}/__reset`, { method: 'POST' })
    .then((r) => r.json())
    .catch(() => null);
  if (!mockReset?.ok) {
    console.log('WARN  mock upstream reset failed; the auto-disable case may not reproduce');
  }
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
    ['exec', container, 'psql', '-U', 'newapi', '-d', 'new-api', '-tAc', `select key from tokens where name = '${TOKEN_NAME}' and deleted_at is null order by id desc limit 1`],
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
    body: {
      key: 'ModelPrice',
      value: JSON.stringify({ [MODEL]: 0.01, [IMAGE_MODEL]: 0.01, [REQUEST_MODEL]: 0.01, [RPM_MODEL]: 0.01, [RATE_MODEL]: 0.01, [AFFINITY_MODEL]: 0.01, [AUTO_MODEL]: 0.01 }),
    },
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

  // Case 5: image generation is billed per call and reports no tokens at all,
  // so only the request budget can hold an account-type image channel.
  const imageChannel = await createChannel(IMAGE_CHANNEL_NAME, IMAGE_MODEL, { daily_request_limit: 1 });
  if (!imageChannel) {
    record('image channel created', false, 'create returned nothing');
  } else {
    record('image channel created', true, `id=${imageChannel.id}`);
    await waitCache();
    const image1 = await relayImage(apiKey, IMAGE_MODEL);
    await new Promise((r) => setTimeout(r, 2000));
    const image2 = await relayImage(apiKey, IMAGE_MODEL);
    record(
      'no-token image request blocked by request budget',
      image1.status === 200 && image2.status === 429 && image2.code === 'channel:daily_request_limit_exceeded',
      `first=${image1.status} second=${image2.status} code=${image2.code || '-'}`
    );

    // Case 6: dropping the request budget restores service even with no token budget.
    await api('/api/channel/', { method: 'PUT', body: { id: imageChannel.id, setting: '{}' } });
    await waitCache();
    const image3 = await relayImage(apiKey, IMAGE_MODEL);
    record('clearing request budget restores image channel', image3.status === 200, `status=${image3.status}`);
  }

  // Case 7: the text path counts requests too, independently of tokens.
  const requestChannel = await createChannel(REQUEST_CHANNEL_NAME, REQUEST_MODEL, { daily_request_limit: 2 });
  if (requestChannel) {
    await waitCache();
    const t1 = await relayChat(apiKey, REQUEST_MODEL);
    const t2 = await relayChat(apiKey, REQUEST_MODEL);
    await new Promise((r) => setTimeout(r, 2000));
    const t3 = await relayChat(apiKey, REQUEST_MODEL);
    record(
      'text requests counted against request budget',
      t1.status === 200 && t2.status === 200 && t3.status === 429 && t3.code === 'channel:daily_request_limit_exceeded',
      `statuses=${t1.status}/${t2.status}/${t3.status} code=${t3.code || '-'}`
    );
  } else {
    record('text request-budget channel created', false, 'create returned nothing');
  }

  // Cases 8-9: the same daily budgets exist one level up — per user and per
  // group. Enforcement must answer with its own error codes (user:/group:), and
  // the admin endpoints must report the same counters enforcement reads.
  // A fresh channel with no channel-level budget keeps these cases independent.
  const ugChannel = await createChannel(UG_CHANNEL_NAME, REQUEST_MODEL, {});
  if (ugChannel) {
    await waitCache();
    const userBudgetPath = `/api/user/${adminId}/daily_budget`;
    const readUser = await api(userBudgetPath);
    const userBase = Number(readUser.json?.data?.requests_used ?? 0);
    await api(userBudgetPath, { method: 'PUT', body: { daily_token_limit: 0, daily_request_limit: userBase + 1 } });
    const u1 = await relayChat(apiKey, REQUEST_MODEL);
    await new Promise((r) => setTimeout(r, 2000));
    const u2 = await relayChat(apiKey, REQUEST_MODEL);
    record(
      'user daily request budget blocks with user: code',
      u1.status === 200 && u2.status === 429 && u2.code === 'user:daily_request_limit_exceeded',
      `statuses=${u1.status}/${u2.status} code=${u2.code || '-'}`
    );
    await api(userBudgetPath, { method: 'PUT', body: { daily_token_limit: 0, daily_request_limit: 0 } });
    const u3 = await relayChat(apiKey, REQUEST_MODEL);
    record('clearing the user budget unblocks', u3.status === 200, `status=${u3.status}`);

    // The listing endpoint only returns groups that HAVE a budget configured, so
    // configure an unlimited one first, then read the real usage before capping it.
    await api('/api/group/daily_budget', {
      method: 'PUT',
      body: { group: 'default', daily_token_limit: 0, daily_request_limit: 0 },
    });
    const groupsBefore = await api('/api/group/daily_budget');
    const rows = Array.isArray(groupsBefore.json?.data) ? groupsBefore.json.data : [];
    const defaultRow = rows.find((r) => r.group === 'default');
    const groupBase = Number(defaultRow?.requests_used ?? 0);
    await api('/api/group/daily_budget', {
      method: 'PUT',
      body: { group: 'default', daily_token_limit: 0, daily_request_limit: groupBase + 1 },
    });
    const g1 = await relayChat(apiKey, REQUEST_MODEL);
    await new Promise((r) => setTimeout(r, 2000));
    const g2 = await relayChat(apiKey, REQUEST_MODEL);
    record(
      'group daily request budget blocks with group: code',
      g1.status === 200 && g2.status === 429 && g2.code === 'group:daily_request_limit_exceeded',
      `statuses=${g1.status}/${g2.status} code=${g2.code || '-'}`
    );
    await api('/api/group/daily_budget', {
      method: 'PUT',
      body: { group: 'default', daily_token_limit: 0, daily_request_limit: 0 },
    });
    const g3 = await relayChat(apiKey, REQUEST_MODEL);
    record('clearing the group budget unblocks', g3.status === 200, `status=${g3.status}`);

    // Settlement runs after the response is flushed, so let the last successful
    // relay land before reading the counters back.
    await new Promise((r) => setTimeout(r, 2000));
    const userAfter = await api(userBudgetPath);
    record(
      'user budget endpoint reports the counters enforcement uses',
      Number(userAfter.json?.data?.requests_used ?? -1) >= userBase + 2,
      `requests_used=${userAfter.json?.data?.requests_used} base=${userBase}`
    );
  } else {
    record('user/group budget channel created', false, 'create returned nothing');
  }

  // Case 10: per-key budgets inside a multi-key channel. Two keys, each allowed
  // one request: the first two requests must succeed on different keys, the
  // third must fail with the key-level code (the channel itself has no budget).
  // Only the multi-key channel may serve this model, otherwise channel selection
  // may route around it and the per-key budgets never get exercised. The budgets
  // are set through the panel's own endpoint, not at creation time, so the write
  // path admins actually use is the one under test.
  for (const stray of await listChannels()) {
    if ([REQUEST_CHANNEL_NAME, UG_CHANNEL_NAME].includes(stray.name)) {
      await api(`/api/channel/${stray.id}`, { method: 'DELETE' });
    }
  }
  const multiKeyCreate = await api('/api/channel/', {
    method: 'POST',
    body: {
      mode: 'multi_to_single',
      multi_key_mode: 'polling',
      channel: {
        name: MK_CHANNEL_NAME,
        type: 1,
        base_url: 'http://host.docker.internal:3999',
        key: 'mock-key-a\nmock-key-b',
        models: REQUEST_MODEL,
        group: 'default',
        priority: 0,
        weight: 0,
        status: 1,
      },
    },
  });
  if (multiKeyCreate.json.success) {
    await waitCache();
    const mkList = await api(`/api/channel/search?keyword=${encodeURIComponent(MK_CHANNEL_NAME)}`);
    const mkItems = Array.isArray(mkList.json.data) ? mkList.json.data : mkList.json.data?.items || [];
    const mkChannel = mkItems.find((c) => c?.name === MK_CHANNEL_NAME);
    if (mkChannel) {
      await api(`/api/channel/${mkChannel.id}/status`, { method: 'PUT', body: { status: 1 } });
      const badIndex = await api(`/api/channel/${mkChannel.id}/key_daily_limits`, {
        method: 'PUT',
        body: { key_daily_token_limits: {}, key_daily_request_limits: { '2': 1 } },
      });
      const negative = await api(`/api/channel/${mkChannel.id}/key_daily_limits`, {
        method: 'PUT',
        body: { key_daily_token_limits: {}, key_daily_request_limits: { '0': -1 } },
      });
      record(
        'multi-key: per-key limit validation rejects unknown indexes and negative limits',
        badIndex.json.success === false && negative.json.success === false,
        `index=${badIndex.json.success} negative=${negative.json.success}`
      );
      const budgetSet = await api(`/api/channel/${mkChannel.id}/key_daily_limits`, {
        method: 'PUT',
        body: { key_daily_token_limits: {}, key_daily_request_limits: { '0': 1, '1': 1 } },
      });
      record(
        'multi-key: per-key limits are written through the API',
        budgetSet.json.success === true,
        JSON.stringify(budgetSet.json).slice(0, 120)
      );
      await waitCache();
      const m1 = await relayChat(apiKey, REQUEST_MODEL);
      const m2 = await relayChat(apiKey, REQUEST_MODEL);
      await new Promise((r) => setTimeout(r, 2000));
      const m3 = await relayChat(apiKey, REQUEST_MODEL);
      record(
        'multi-key: each key gets its own daily request budget',
        m1.status === 200 && m2.status === 200 && m3.status === 429 && m3.code === 'channel:key_daily_limit_exceeded',
        `statuses=${m1.status}/${m2.status}/${m3.status} code=${m3.code || '-'}`
      );
      const mkUsage = await api(`/api/channel/daily_usage/${mkChannel.id}`);
      const keyRows = mkUsage.json?.data?.keys || [];
      record(
        'multi-key: usage endpoint reports per-key counters and masked tails',
        keyRows.length === 2 &&
          keyRows.every((row) => row.requests_used === 1 && String(row.key_tail).startsWith('***')),
        JSON.stringify(keyRows.map((row) => ({ i: row.index, tail: row.key_tail, used: row.requests_used })))
      );
    } else {
      record('multi-key channel visible after create', false, 'not found');
    }
  } else {
    record('multi-key channel created', false, JSON.stringify(multiKeyCreate.json).slice(0, 120));
  }


  // Case 10a: per-key RPM. Each key may take one request per minute: the first
  // two requests land on different keys, the third is refused with the pacing
  // code instead of hammering an account that has used up its minute.
  const rpmChannel = await createMultiKeyChannel(MK_RPM_NAME, 'mock-key-a\nmock-key-b', RPM_MODEL);
  if (rpmChannel) {
    await api(`/api/channel/${rpmChannel.id}/status`, { method: 'PUT', body: { status: 1 } });
    const rpmSet = await api(`/api/channel/${rpmChannel.id}/key_daily_limits`, {
      method: 'PUT',
      body: { key_daily_token_limits: {}, key_daily_request_limits: {}, key_rpm_limits: { '0': 1, '1': 1 } },
    });
    const rpm1 = await relayChat(apiKey, RPM_MODEL);
    const rpm2 = await relayChat(apiKey, RPM_MODEL);
    const rpm3 = await relayChat(apiKey, RPM_MODEL);
    record(
      'multi-key: per-key RPM skips a saturated key and refuses a full pool',
      rpmSet.json.success === true &&
        rpm1.status === 200 && rpm2.status === 200 &&
        rpm3.status === 429 && rpm3.code === 'channel:key_rate_limited',
      `set=${rpmSet.json.success} statuses=${rpm1.status}/${rpm2.status}/${rpm3.status} code=${rpm3.code || '-'}`
    );
    const rpmCleared = await api(`/api/channel/${rpmChannel.id}/key_daily_limits`, {
      method: 'PUT',
      body: { key_daily_token_limits: {}, key_daily_request_limits: {}, key_rpm_limits: {} },
    });
    const rpm4 = await relayChat(apiKey, RPM_MODEL);
    record(
      'multi-key: clearing the RPM limit restores the pool immediately',
      rpmCleared.json.success === true && rpm4.status === 200,
      `cleared=${rpmCleared.json.success} status=${rpm4.status}`
    );
    await api(`/api/channel/${rpmChannel.id}`, { method: 'DELETE' });
  } else {
    record('multi-key RPM channel created', false, 'create failed');
  }

  // Case 10b: an upstream 429 rests that key for KeyRateLimitCooldownSeconds and
  // the pool moves the next request to another key. After the cooldown the key
  // is selectable again (the mock answers 429 only on the first hit).
  // Key affinity is off for this case so polling reaches the second key.
  await api('/api/option/', { method: 'PUT', body: { key: 'KeyRateLimitCooldownSeconds', value: '5' } });
  await api('/api/option/', { method: 'PUT', body: { key: 'KeyAffinityTTLSeconds', value: '0' } });
  const rateChannel = await createMultiKeyChannel(MK_RATE_NAME, 'rate429-key\nmock-key-b', RATE_MODEL);
  if (rateChannel) {
    const rate1 = await relayChat(apiKey, RATE_MODEL);
    // The cooldown is written while the error is processed; poll briefly rather
    // than assuming a fixed delay.
    let rateKey0 = null;
    for (let i = 0; i < 20; i++) {
      const snapshot = await api(`/api/channel/daily_usage/${rateChannel.id}`);
      rateKey0 = (snapshot.json?.data?.keys || []).find((row) => row.index === 0);
      if ((rateKey0?.cooldown_remaining_seconds || 0) > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const rate2 = await relayChat(apiKey, RATE_MODEL);
    await new Promise((r) => setTimeout(r, 1500));
    const rateUsage2 = await api(`/api/channel/daily_usage/${rateChannel.id}`);
    const rateKeys = rateUsage2.json?.data?.keys || [];
    const rateUsed0 = rateKeys.find((row) => row.index === 0)?.requests_used;
    const rateUsed1 = rateKeys.find((row) => row.index === 1)?.requests_used;
    record(
      'multi-key: upstream 429 cools the key down and the other key serves',
      rate1.status === 429 &&
        (rateKey0?.cooldown_remaining_seconds || 0) > 0 &&
        rate2.status === 200 && rateUsed1 === 1 && (rateUsed0 || 0) === 0,
      `first=${rate1.status}/${rate1.code || '-'} cooldown=${rateKey0?.cooldown_remaining_seconds} second=${rate2.status} used=${rateUsed0}/${rateUsed1}`
    );
    await new Promise((r) => setTimeout(r, 6000));
    const rate3 = await relayChat(apiKey, RATE_MODEL);
    const rateUsage3 = await api(`/api/channel/daily_usage/${rateChannel.id}`);
    const rateKey0After = (rateUsage3.json?.data?.keys || []).find((row) => row.index === 0);
    record(
      'multi-key: the cooled key returns after the cooldown and serves again',
      rate3.status === 200 && (rateKey0After?.cooldown_remaining_seconds || 0) === 0,
      `status=${rate3.status} cooldown=${rateKey0After?.cooldown_remaining_seconds}`
    );
    await api(`/api/channel/${rateChannel.id}`, { method: 'DELETE' });
  } else {
    record('multi-key 429 channel created', false, 'create failed');
  }
  await api('/api/option/', { method: 'PUT', body: { key: 'KeyRateLimitCooldownSeconds', value: '60' } });

  // Case 10c: key affinity. Two healthy keys on polling would alternate; with
  // affinity on, the second request must stay on the key that served the first.
  await api('/api/option/', { method: 'PUT', body: { key: 'KeyAffinityTTLSeconds', value: '600' } });
  const affinityChannel = await createMultiKeyChannel(MK_AFFINITY_NAME, 'mock-key-a\nmock-key-b', AFFINITY_MODEL);
  if (affinityChannel) {
    const affinity1 = await relayChat(apiKey, AFFINITY_MODEL);
    // The binding is written after the response is flushed, so give it a moment
    // before the follow-up request (real clients think for longer than this).
    await new Promise((r) => setTimeout(r, 700));
    const affinity2 = await relayChat(apiKey, AFFINITY_MODEL);
    await new Promise((r) => setTimeout(r, 2000));
    const affinityUsage = await api(`/api/channel/daily_usage/${affinityChannel.id}`);
    const affinityKeys = affinityUsage.json?.data?.keys || [];
    const affinityUsed0 = affinityKeys.find((row) => row.index === 0)?.requests_used;
    const affinityUsed1 = affinityKeys.find((row) => row.index === 1)?.requests_used;
    record(
      'multi-key: a client stays on the key that served it (affinity)',
      affinity1.status === 200 && affinity2.status === 200 &&
        affinityUsed0 === 2 && (affinityUsed1 || 0) === 0,
      `statuses=${affinity1.status}/${affinity2.status} used=${affinityUsed0}/${affinityUsed1}`
    );
    await api(`/api/channel/${affinityChannel.id}`, { method: 'DELETE' });
  } else {
    record('multi-key affinity channel created', false, 'create failed');
  }

  // The auto-disable case needs polling to reach the failing key, so affinity
  // stays off until the recovery case has run.
  await api('/api/option/', { method: 'PUT', body: { key: 'KeyAffinityTTLSeconds', value: '0' } });

  // Case 11: a revoked key is taken out of the pool automatically; the healthy
  // key keeps serving and the usage endpoint shows the auto-disable with a reason.
  for (const stray of await listChannels()) {
    // Also clear an earlier run's auto channel: two channels serving the same
    // model would split these requests and the status check would read the
    // wrong channel.
    if (stray.name === MK_CHANNEL_NAME || stray.name === MK_AUTO_NAME) {
      await api(`/api/channel/${stray.id}`, { method: 'DELETE' });
    }
  }
  // Automatic channel/key disabling is opt-in upstream; turn it on for this case
  // and put it back afterwards so the rest of the stack behaves as before.
  await api('/api/option/', { method: 'PUT', body: { key: 'AutomaticDisableChannelEnabled', value: 'true' } });
  const autoCreate = await api('/api/channel/', {
    method: 'POST',
    body: {
      mode: 'multi_to_single',
      multi_key_mode: 'polling',
      channel: {
        name: MK_AUTO_NAME,
        type: 1,
        base_url: 'http://host.docker.internal:3999',
        key: 'mock-bad-key\nmock-good-key',
        models: REQUEST_MODEL,
        group: 'default',
        priority: 0,
        weight: 0,
        status: 1,
        auto_ban: 1,
      },
    },
  });
  if (autoCreate.json.success) {
    await waitCache();
    const autoList = await api(`/api/channel/search?keyword=${encodeURIComponent(MK_AUTO_NAME)}`);
    const autoItems = Array.isArray(autoList.json.data) ? autoList.json.data : autoList.json.data?.items || [];
    const autoChannel = autoItems.find((c) => c?.name === MK_AUTO_NAME);
    if (autoChannel) {
      const bad = await relayChat(apiKey, REQUEST_MODEL); // key 0 -> 401 from the mock
      const good = await relayChat(apiKey, REQUEST_MODEL); // key 1 -> healthy
      // Auto-disable is persisted asynchronously after the response: poll for it.
      let autoKeys = [];
      let badKey = null;
      let goodKey = null;
      for (let i = 0; i < 25; i++) {
        const autoUsage = await api(`/api/channel/daily_usage/${autoChannel.id}`);
        autoKeys = autoUsage.json?.data?.keys || [];
        badKey = autoKeys.find((row) => row.index === 0);
        goodKey = autoKeys.find((row) => row.index === 1);
        if (badKey?.status === 3) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      record(
        'multi-key: a revoked key is auto-disabled with a reason',
        bad.status === 401 &&
          badKey?.status === 3 &&
          typeof badKey?.disabled_reason === 'string' &&
          badKey.disabled_reason.length > 0 &&
          goodKey?.status === 1,
        `first=${bad.status} second=${good.status} badKeyStatus=${badKey?.status} reason=${String(badKey?.disabled_reason || '').slice(0, 40)}`
      );
      const afterDisable = await relayChat(apiKey, REQUEST_MODEL);
      record('multi-key: the healthy key keeps serving after the bad one is removed', afterDisable.status === 200, `status=${afterDisable.status}`);
      await api('/api/option/', { method: 'PUT', body: { key: 'AutomaticDisableChannelEnabled', value: 'false' } });
    } else {
      record('auto-disable channel visible after create', false, 'not found');
    }
  } else {
    record('auto-disable channel created', false, JSON.stringify(autoCreate.json).slice(0, 120));
  }

  // Case 12: cooldown recovery. With a one-minute cooldown, the key disabled in
  // case 11 must come back after it elapses — recovery happens lazily on the next
  // key selection, so one request after the wait is enough to observe it.
  // This is the slowest case by design (~70s); it is the only proof that a
  // transient failure does not permanently remove a key.
  await api('/api/option/', { method: 'PUT', body: { key: 'MultiKeyAutoRecoverMinutes', value: '1' } });
  const recoverList = await api(`/api/channel/search?keyword=${encodeURIComponent(MK_AUTO_NAME)}`);
  const recoverItems = Array.isArray(recoverList.json.data) ? recoverList.json.data : recoverList.json.data?.items || [];
  const recoverChannel = recoverItems.find((c) => c?.name === MK_AUTO_NAME);
  if (recoverChannel) {
    await new Promise((r) => setTimeout(r, 65000));
    const probe = await relayChat(apiKey, REQUEST_MODEL);
    await new Promise((r) => setTimeout(r, 1500));
    const recovered = await api(`/api/channel/daily_usage/${recoverChannel.id}`);
    const recoveredKeys = recovered.json?.data?.keys || [];
    const backKey = recoveredKeys.find((row) => row.index === 0);
    // The probe recovers the key and then succeeds: the mock stops rejecting the
    // "revoked" key after two attempts, so a 200 here proves both recovery and a
    // usable key rather than a second failure.
    record(
      'multi-key: an auto-disabled key returns after the cooldown',
      probe.status === 200 && backKey?.status === 1,
      `probe=${probe.status} badKeyStatus=${backKey?.status}`
    );
    await api(`/api/channel/${recoverChannel.id}`, { method: 'DELETE' });
  } else {
    record('cooldown: channel still present for recovery', false, 'not found');
  }
  await api('/api/option/', { method: 'PUT', body: { key: 'MultiKeyAutoRecoverMinutes', value: '30' } });
  await api('/api/option/', { method: 'PUT', body: { key: 'KeyAffinityTTLSeconds', value: '600' } });

  const cleanup = await api(`/api/channel/${channel.id}`, { method: 'DELETE' });
  record('cleanup channel deleted', cleanup.json.success === true, JSON.stringify(cleanup.json).slice(0, 80));
  // Harness cleanup convention: find the token by keyword (GET /api/token/ is
  // paginated, so a plain list can miss a freshly created one) and delete it by
  // id, then assert it is really gone. Measured: search?keyword= returns exactly
  // the match and DELETE /api/token/:id answers success:true.
  const found = await api(`/api/token/search?keyword=${encodeURIComponent(TOKEN_NAME)}`);
  const tokenRows = Array.isArray(found.json.data) ? found.json.data : found.json.data?.items || [];
  for (const stale of tokenRows.filter((t) => t?.name === TOKEN_NAME)) {
    await api(`/api/token/${stale.id}`, { method: 'DELETE' });
  }
  const after = await api(`/api/token/search?keyword=${encodeURIComponent(TOKEN_NAME)}`);
  const afterRows = Array.isArray(after.json.data) ? after.json.data : after.json.data?.items || [];
  record('token cleaned up', afterRows.filter((t) => t?.name === TOKEN_NAME).length === 0, `left=${afterRows.length}`);

  for (const stray of await listChannels()) {
    if (['price-probe', CHANNEL_NAME, IMAGE_CHANNEL_NAME, REQUEST_CHANNEL_NAME, UG_CHANNEL_NAME, MK_CHANNEL_NAME, MK_AUTO_NAME, MK_RPM_NAME, MK_RATE_NAME, MK_AFFINITY_NAME].includes(stray.name)) {
      await api(`/api/channel/${stray.id}`, { method: 'DELETE' });
    }
  }

  // Active sessions are capped per user (AUTH_SESSION_LIMIT). Leaving one behind
  // per run eventually blocks the next login with a 409 that looks unrelated to
  // this script, so revoke this run's session instead of accumulating them.
  const logout = await api('/api/user/auth/logout', { method: 'POST' });
  if (!logout.json?.success) {
    console.log(`WARN  admin session not revoked — ${JSON.stringify(logout.json).slice(0, 100)}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error('error:', err.message);
  process.exit(1);
});
