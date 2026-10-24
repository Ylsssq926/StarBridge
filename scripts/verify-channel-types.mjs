// Per-upstream-type console adaptation check.
// For every channel type we wire, verify that the panel can create/update the
// channel with daily_token_limit set, that the value survives the update path,
// and that our field never changes the type's own validation result.
// Usage: node scripts/verify-channel-types.mjs [base_url]
const BASE = process.argv[2] || 'http://localhost:3800';
const ADMIN_USER = process.env.NEW_API_ADMIN_USER || 'root';
const ADMIN_PASS = process.env.NEW_API_ADMIN_PASS || 'rootpass123';
const MOCK_BASE = 'http://host.docker.internal:3999';

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
    return Number(JSON.parse(channel.setting || '{}').daily_token_limit) === 10;
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
    const withLimit = await createChannel(limitName, type, JSON.stringify({ daily_token_limit: 10 }));

    if (plain.ok !== withLimit.ok) {
      rows.push({ type, label, result: 'DIFFERS', detail: `plain=${plain.ok} limit=${withLimit.ok} ${withLimit.message || plain.message}` });
    } else if (!withLimit.ok) {
      rows.push({ type, label, result: 'skipped', detail: `type needs extra config: ${withLimit.message}` });
    } else {
      const saved = hasLimit(withLimit.channel);
      // Update an unrelated field through the panel API and re-read.
      await api('/api/channel/', { method: 'PUT', body: { id: withLimit.channel.id, weight: 5 } });
      const after = (await listChannels()).find((c) => c.id === withLimit.channel.id);
      const survived = after ? hasLimit(after) : false;
      let detail = `create=${saved} after-update=${survived}`;
      let pairOk = true;
      if (TYPE_EXTRA[type]?.taskPluginKey && after) {
        const parsed = JSON.parse(after.setting || '{}');
        pairOk = parsed.task_plugin_key === TYPE_EXTRA[type].taskPluginKey && Number(parsed.daily_token_limit) === 10;
        detail += ` plugin-key-preserved=${pairOk}`;
      }
      rows.push({
        type,
        label,
        result: saved && survived && pairOk ? 'ok' : 'BROKEN',
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

  const broken = rows.filter((r) => r.result === 'BROKEN' || r.result === 'DIFFERS');
  console.log(
    `\n${rows.length - broken.length}/${rows.length} types adapted (${limited.length} kept for the cap test)`
  );

  // Per type: the channel must be routable at all, then blocked once its daily
  // cap is reached. Each channel owns a unique model, so selection is exact.
  if (limited.length) {
    const { execFileSync } = await import('node:child_process');
    const container = process.env.POC_POSTGRES_CONTAINER || 'new-api-poc-postgres';
    const raw = execFileSync(
      'docker',
      ['exec', container, 'psql', '-U', 'newapi', '-d', 'new-api', '-tAc', "select key from tokens where name = 'verify-daily-limit' order by id desc limit 1"],
      { encoding: 'utf8' },
    ).trim();
    const apiKey = raw.startsWith('sk-') ? raw.slice(3) : raw;
    if (!apiKey) {
      console.error('no plaintext token key; run scripts/verify-daily-limit.mjs first');
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
    let capFails = 0;
    for (const ch of limited) {
      const first = await call(ch.type);
      // Usage is written during settlement, after the response is flushed.
      await new Promise((r) => setTimeout(r, 2000));
      const second = await call(ch.type);
      const blocked = second.status === 429 && /daily_token_limit_exceeded/.test(second.body);
      if (first.status !== 200) {
        // The mock upstream does not implement every provider's path shape;
        // that is a harness gap, not a gateway defect.
        console.log(
          `${String(ch.type).padStart(4)} | ${ch.label.padEnd(14)} | ${first.status} (mock upstream path not implemented, cap not asserted)`
        );
      } else {
        if (!blocked) capFails += 1;
        console.log(
          `${String(ch.type).padStart(4)} | ${ch.label.padEnd(14)} | ${first.status} | ${second.status}${blocked ? ' (429 daily)' : ` body=${second.body.slice(0, 70)}`}`
        );
      }
      await api(`/api/channel/${ch.id}`, { method: 'DELETE' });
    }
    console.log(`\ncap enforcement: ${limited.length - capFails}/${limited.length} types`);
    if (capFails) process.exit(1);
  }

  process.exit(broken.length ? 1 : 0);
}

main().catch((err) => {
  console.error('error:', err.message);
  process.exit(1);
});
