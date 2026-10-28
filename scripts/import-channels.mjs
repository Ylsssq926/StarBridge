// Import channels from a JSON file through the panel API, so adding a source is
// "edit a file, run one command" instead of clicking through the console or
// hand-writing curl calls.
//
//   node scripts/import-channels.mjs channels.example.json --dry-run
//   node scripts/import-channels.mjs channels.json
//
// File shape: a JSON array of channel objects (see channels.example.json):
//   { "name", "type", "base_url", "models", "group", "priority", "weight",
//     "status", "setting": {...}, "key" | "key_env", "param_override", "remark" }
//
// Keys come from the environment via key_env, so the file itself can live in the
// repository. An entry without a usable key is reported as skipped, never
// silently imported with a broken credential.
//
// Env: NEW_API_BASE (default http://localhost:3800), NEW_API_ADMIN_USER,
// NEW_API_ADMIN_PASS.
import fs from 'node:fs'

import { adminCredentials } from './poc-credentials.mjs'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--'))
const DRY_RUN = args.includes('--dry-run')
const ALLOW_MISSING_KEYS = args.includes('--allow-missing-keys')
const UPDATE_EXISTING = args.includes('--update-existing')
const BASE = process.env.NEW_API_BASE || 'http://localhost:3800'
const { user: ADMIN_USER, pass: ADMIN_PASS } = adminCredentials('import-channels.mjs')

if (!file) {
  console.error(
    'usage: node scripts/import-channels.mjs <channels.json> [--dry-run] [--update-existing] [--allow-missing-keys]'
  )
  process.exit(2)
}

let accessToken = ''
let adminId = ''

async function api(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: options.method || 'GET',
    headers: {
      'content-type': 'application/json',
      ...(accessToken
        ? { authorization: `Bearer ${accessToken}`, 'new-api-user': adminId }
        : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await res.text()
  try {
    return { status: res.status, json: JSON.parse(text) }
  } catch {
    return { status: res.status, json: { raw: text.slice(0, 160) } }
  }
}

function rowsOf(json) {
  return Array.isArray(json.data) ? json.data : json.data?.items || []
}

function toChannel(spec) {
  const setting =
    typeof spec.setting === 'string' ? spec.setting : JSON.stringify(spec.setting || {})
  const channel = {
    name: spec.name,
    type: spec.type,
    base_url: spec.base_url || '',
    models: spec.models,
    group: spec.group || 'default',
    priority: spec.priority ?? 0,
    weight: spec.weight ?? 0,
    status: spec.status ?? 1,
    setting,
  }
  if (spec.param_override) channel.param_override = spec.param_override
  if (spec.header_override) channel.header_override = spec.header_override
  if (spec.remark) channel.remark = spec.remark
  if (spec.auto_ban !== undefined) channel.auto_ban = spec.auto_ban
  return channel
}

function resolveKey(spec) {
  if (spec.key) return spec.key
  if (spec.key_env) return process.env[spec.key_env] || ''
  return ''
}

const specs = JSON.parse(fs.readFileSync(file, 'utf8'))
if (!Array.isArray(specs)) {
  console.error(`${file} must contain a JSON array of channels`)
  process.exit(2)
}

const login = await api('/api/user/login', {
  method: 'POST',
  body: { username: ADMIN_USER, password: ADMIN_PASS },
})
if (login.json.success !== true) {
  console.error(`login failed at ${BASE}: ${JSON.stringify(login.json).slice(0, 160)}`)
  process.exit(1)
}
accessToken = login.json.data.access_token
adminId = String(login.json.data.user?.id ?? '')

const byName = new Map(rowsOf((await api('/api/channel/')).json).map((c) => [c.name, c]))

let imported = 0
let skipped = 0
const failures = []

for (const spec of specs) {
  const label = spec.name || `<unnamed type ${spec.type}>`
  if (!spec.name || !spec.type || !spec.models) {
    failures.push(`${label}: needs name, type and models`)
    continue
  }

  const key = resolveKey(spec)
  if (!key && !ALLOW_MISSING_KEYS) {
    const reason = spec.key_env ? `env ${spec.key_env} is empty` : 'no key or key_env'
    console.log(`SKIP  ${label} — ${reason}; export the variable or pass --allow-missing-keys`)
    skipped++
    continue
  }

  const channel = { ...toChannel(spec), key: key || 'REPLACE_ME' }
  const already = byName.get(spec.name)
  if (already && !UPDATE_EXISTING) {
    console.log(`SKIP  ${label} — already exists (id=${already.id}); --update-existing overwrites it`)
    skipped++
    continue
  }

  if (DRY_RUN) {
    console.log(
      `DRY   ${label} — type=${spec.type} models=${spec.models} base=${channel.base_url || '(built-in)'}`
    )
    imported++
    continue
  }

  const res = already
    ? await api('/api/channel/', { method: 'PUT', body: { ...channel, id: already.id } })
    : await api('/api/channel/', { method: 'POST', body: { mode: 'single', channel } })

  if (res.json.success === true) {
    console.log(`${already ? 'UPDATE' : 'CREATE'} ${label} — ok`)
    imported++
  } else {
    failures.push(`${label}: ${String(res.json.message || res.json.raw || res.status).slice(0, 120)}`)
  }
}

console.log(`\n${imported} imported, ${skipped} skipped, ${failures.length} failed`)
for (const failure of failures) console.error(`FAIL  ${failure}`)
// Set the code instead of calling process.exit(): on Windows an immediate exit
// while handles are still draining trips a libuv assertion and yields a
// misleading exit code (127) even when every import succeeded.
process.exitCode = failures.length ? 1 : 0
