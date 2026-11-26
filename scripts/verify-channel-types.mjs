// Per-upstream-type console adaptation check.
// For every channel type we wire, verify that the panel can create/update the
// channel with daily_token_limit set, that the value survives the update path,
// and that our field never changes the type's own validation result.
// Usage: POC_POSTGRES_CONTAINER=<container> node scripts/verify-channel-types.mjs [base_url]
const BASE = process.argv[2] || 'http://localhost:3800';
import { adminCredentials } from './poc-credentials.mjs';
const { user: ADMIN_USER, pass: ADMIN_PASS } = adminCredentials('verify-channel-types.mjs');
const MOCK_BASE = 'http://host.docker.internal:3999';
const TOKEN_NAME = 'verify-channel-types';
const MOCK_UNSUPPORTED_TYPES = new Set([16, 41, 57, 61]);

// type id -> label; includes every upstream this product uses.
const TYPES = [
  [1, 'OpenAI'],
  [14, 'Anthropic'],
  [16, 'Zhipu'],
  [17, 'Ali'],
  [24, 'Gemini'],
  [25, 'Moonshot'],
  [41, 'VertexAI'],
  [43, 'DeepSeek'],
  [45, 'VolcEngine'],
  [54, 'Doubao'],
  [57, 'Codex'],
  [58, 'AdvancedCustom'],
  [59, 'Sub2API'],
  [60, 'NewAPI'],
  [61, 'TaskPlugin'],
  [62, 'VLLM'],
  [63, 'SGLang'],
];

// Type-specific required config, so these upstreams are tested with a channel
// the console actually accepts.
const TYPE_EXTRA = {
  41: { other: JSON.stringify({ default: 'us-central1' }) },
  57: { key: JSON.stringify({ access_token: 'mock-access-token', account_id: 'mock-account' }) },
  58: {
    settings: JSON.stringify({
      advanced_custom: {
        advanced_routes: [
          {
            incoming_path: '/v1/chat/completions',
            upstream_path: '/v1/chat/completions',
            converter: '',
            models: [`verify-m-58`],
          },
        ],
      },
    }),
  },
  // Type 61 shares the same setting JSON as daily_token_limit, so it is the
  // collision risk to prove. "alibaba" is the plugin this build registers.
  61: { taskPluginKey: 'alibaba' },
};

const jar = new Map();
let accessToken = '';
let adminId = '';
const rows = [];

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
    return { status: res.status, json: { raw: text.slice(0, 160) } };
  }
}

async function listChannels() {
  const res = await api('/api/channel/');
  return Array.isArray(res.json.data) ? res.json.data : res.json.data?.items || [];
}

async function createChannel(name, type, setting) {
  const extra = TYPE_EXTRA[type] || {};
  let mergedSetting = setting;
  if (extra.taskPluginKey) {
    const parsed = JSON.parse(setting || '{}');
    parsed.task_plugin_key = extra.taskPluginKey;
    mergedSetting = JSON.stringify(parsed);
  }
  const body = {
    mode: 'single',
    channel: {
      name,
      type,
      base_url: MOCK_BASE,
      key: 'mock-key',
      models: `verify-m-${type}`,
      group: 'default',
      priority: 0,
      weight: 0,
      status: 1,
      setting: mergedSetting,
      ...(extra.key ? { key: extra.key } : {}),
      ...(extra.other ? { other: extra.other } : {}),
      ...(extra.settings ? { settings: extra.settings } : {}),
    },
  };
  const res = await api('/api/channel/', { method: 'POST', body });
  if (res.json.success !== true) {
    return { ok: false, message: String(res.json.message || res.json.error || '').slice(0, 90) };
  }
  const found = (await listChannels()).find((c) => c.name === name) || null;
  return { ok: true, channel: found };
}

function hasLimit(channel) {
  try {
    const parsed = JSON.parse(channel.setting || '{}');
    return Number(parsed.daily_token_limit) === 10 && Number(parsed.daily_request_limit) === 5;
  } catch {
    return false;
  }
}

async function main() {
  const login = await api('/api/user/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } });
  accessToken = login.json.data?.access_token || '';
  adminId = String(login.json.data?.user?.id || '');
  if (!accessToken) {
    console.error('login failed:', JSON.stringify(login.json).slice(0, 160));
    process.exit(1);
  }
  await api('/api/option/', {
    method: 'PUT',
    body: {
      key: 'ModelPrice',
      value: JSON.stringify(Object.fromEntries(TYPES.map(([t]) => [`verify-m-${t}`, 0.01]))),
    },
  });

  const limited = [];
  for (const [type, label] of TYPES) {
    const baseName = `verify-type-${type}`;
    const plainName = `${baseName}-plain`;
    const limitName = `${baseName}-limit`;

    // Baseline without our field, so a type-specific rejection is not blamed on the patch.
    const plain = await createChannel(plainName, type, '{}');
    const withLimit = await createChannel(limitName, type, JSON.stringify({ daily_token_limit: 10, daily_request_limit: 5 }));

    if (plain.ok !== withLimit.ok) {
      rows.push({ type, label, result: 'DIFFERS', detail: `plain=${plain.ok} limit=${withLimit.ok} ${withLimit.message || plain.message}` });
    } else if (!withLimit.ok) {
      rows.push({ type, label, result: 'skipped', detail: `type needs extra config: ${withLimit.message}` });
    } else {
      const saved = hasLimit(withLimit.channel);
      // Update an unrelated field through the panel API and re-read.
      const update = await api('/api/channel/', { method: 'PUT', body: { id: withLimit.channel.id, weight: 5 } });
      const after = (await listChannels()).find((c) => c.id === withLimit.channel.id);
      const survived = after ? hasLimit(after) : false;
      const updateOk = update.json.success === true;
      let detail = `create=${saved} update=${updateOk} after-update=${survived}`;
      let pairOk = true;
      if (TYPE_EXTRA[type]?.taskPluginKey && after) {
        const parsed = JSON.parse(after.setting || '{}');
        pairOk = parsed.task_plugin_key === TYPE_EXTRA[type].taskPluginKey && Number(parsed.daily_token_limit) === 10 && Number(parsed.daily_request_limit) === 5;
        detail += ` plugin-key-preserved=${pairOk}`;
      }
      rows.push({
        type,
        label,
        result: saved && updateOk && survived && pairOk ? 'ok' : 'BROKEN',
        detail,
      });
      if (saved && survived && pairOk) limited.push({ id: withLimit.channel.id, type, label });
    }
    if (plain.channel) await api(`/api/channel/${plain.channel.id}`, { method: 'DELETE' });
    if (withLimit.channel && !(rows.at(-1).result === 'ok')) {
      await api(`/api/channel/${withLimit.channel.id}`, { method: 'DELETE' });
    }
  }

  console.log('type | label | result | detail');
  for (const r of rows) console.log(`${String(r.type).padStart(4)} | ${r.label.padEnd(14)} | ${r.result.padEnd(7)} | ${r.detail}`);

  const broken = rows.filter((r) => r.result !== 'ok');
  let capFails = 0;
  let capUnexpectedFails = 0;
  let capChecked = 0;
  let capSkipped = 0;
  console.log(
    `\n${rows.length - broken.length}/${rows.length} types adapted (${limited.length} kept for the cap test)`
  );

  // Per type: the channel must be routable at all, then blocked once its daily
  // cap is reached. Each channel owns a unique model, so selection is exact.
  if (limited.length) {
    const { execFileSync } = await import('node:child_process');
    const container = process.env.POC_POSTGRES_CONTAINER || 'new-api-poc-postgres';
    await api('/api/token/', { method: 'POST', body: { name: TOKEN_NAME, expired_time: -1, unlimited_quota: true } });
    const raw = execFileSync(
      'docker',
      ['exec', container, 'psql', '-U', 'newapi', '-d', 'new-api', '-tAc', `select key from tokens where name = '${TOKEN_NAME}' and deleted_at is null order by id desc limit 1`],
      { encoding: 'utf8' },
    ).trim();
    const apiKey = raw.startsWith('sk-') ? raw.slice(3) : raw;
    if (!apiKey) {
      const tokenHits = await api(`/api/token/search?keyword=${encodeURIComponent(TOKEN_NAME)}`);
      for (const stale of tokenHits.json.data?.items || []) {
        if (stale?.name === TOKEN_NAME) await api(`/api/token/${stale.id}`, { method: 'DELETE' });
      }
      console.error('no plaintext token key; set POC_POSTGRES_CONTAINER');
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 7000));

    const call = async (type) => {
      const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer sk-${apiKey}` },
        body: JSON.stringify({ model: `verify-m-${type}`, messages: [{ role: 'user', content: 'x' }] }),
      });
      return { status: res.status, body: (await res.text()).slice(0, 200) };
    };

    console.log('\ntype | label | routable | capped');
    for (const ch of limited) {
      const first = await call(ch.type);
      // Usage is written during settlement, after the response is flushed.
      await new Promise((r) => setTimeout(r, 2000));
      const second = await call(ch.type);
      const blocked = second.status === 429 && /daily_token_limit_exceeded/.test(second.body);
      if (first.status !== 200) {
        // Only the known mock/provider mismatches may skip the second request.
        if (MOCK_UNSUPPORTED_TYPES.has(ch.type)) {
          capSkipped += 1;
          console.log(
            `${String(ch.type).padStart(4)} | ${ch.label.padEnd(14)} | ${first.status} (known mock upstream gap, cap not asserted) body=${first.body.slice(0, 70)}`
          );
        } else {
          capFails += 1;
          capUnexpectedFails += 1;
          console.log(
            `${String(ch.type).padStart(4)} | ${ch.label.padEnd(14)} | ${first.status} (unexpected upstream failure) body=${first.body.slice(0, 70)}`
          );
        }
      } else {
        capChecked += 1;
        if (!blocked) capFails += 1;
        console.log(
          `${String(ch.type).padStart(4)} | ${ch.label.padEnd(14)} | ${first.status} | ${second.status}${blocked ? ' (429 daily)' : ` body=${second.body.slice(0, 70)}`}`
        );
      }
      await api(`/api/channel/${ch.id}`, { method: 'DELETE' });
    }
    console.log(`\ncap enforcement: ${capChecked - (capFails - capUnexpectedFails)}/${capChecked} routable types (${capSkipped} known mock gaps, ${capUnexpectedFails} unexpected failures)`);

    const tokenHits = await api(`/api/token/search?keyword=${encodeURIComponent(TOKEN_NAME)}`);
    for (const stale of tokenHits.json.data?.items || []) {
      if (stale?.name === TOKEN_NAME) await api(`/api/token/${stale.id}`, { method: 'DELETE' });
    }
    const tokenLeft = await api(`/api/token/search?keyword=${encodeURIComponent(TOKEN_NAME)}`);
    const liveTokens = (tokenLeft.json.data?.items || []).filter((t) => t?.name === TOKEN_NAME);
    console.log(`${liveTokens.length === 0 ? 'PASS' : 'FAIL'}  token cleaned up — left=${liveTokens.length}`);
    if (liveTokens.length) capFails += 1;
  }

  process.exit(broken.length || capFails ? 1 : 0);
}

main().catch((err) => {
  console.error('error:', err.message);
  process.exit(1);
});
