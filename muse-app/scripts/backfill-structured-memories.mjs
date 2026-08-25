import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')
const APPLY = process.argv.includes('--apply')
const SOURCE_KEYS = ['room-diary', 'room-memory']
const MEMORY_KEYS = {
  ordinary: 'memory-v1-ordinary',
  sensitive_history: 'memory-v1-sensitive-history',
  current_state: 'memory-v1-current-state',
}

function loadEnv(filename) {
  const file = path.join(ROOT, filename)
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (!match || process.env[match[1]]) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    process.env[match[1]] = value
  }
}

loadEnv('.env.vercel.test')
loadEnv('.env.local')

const BASE = process.env.KV_REST_API_URL
const TOKEN = process.env.KV_REST_API_TOKEN
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY
const SOCKS_PROXY = process.env.MUSE_SOCKS_PROXY || 'socks5h://127.0.0.1:10024'
if (!BASE || !TOKEN) throw new Error('Missing KV_REST_API_URL or KV_REST_API_TOKEN')
if (APPLY && !ANTHROPIC_KEY) throw new Error('Missing ANTHROPIC_KEY')

async function redisGet(key) {
  const response = await fetch(`${BASE}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  if (!response.ok) throw new Error(`KV read failed for ${key}: ${response.status}`)
  const { result } = await response.json()
  if (!result) return []
  const parsed = JSON.parse(result)
  return Array.isArray(parsed) ? parsed : JSON.parse(parsed)
}

async function redisSet(key, value) {
  const response = await fetch(`${BASE}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(value),
  })
  if (!response.ok) throw new Error(`KV write failed for ${key}: ${response.status}`)
}

function parseJsonObject(text) {
  return JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim())
}

function cleanArray(value) {
  return Array.isArray(value) ? value.map(item => String(item).trim()).filter(Boolean).slice(0, 8) : []
}

function uniqueId(type) {
  return `${type}-backfill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function chunksByCharacters(records, limit = 12000) {
  const chunks = []
  let current = []
  let size = 0
  for (const record of records) {
    const serialized = `[${record.source} | ${record.time || '时间不详'} | ${record.speaker}]\n${record.text}`
    if (current.length && size + serialized.length > limit) {
      chunks.push(current)
      current = []
      size = 0
    }
    current.push(serialized)
    size += serialized.length
  }
  if (current.length) chunks.push(current)
  return chunks
}

const SYSTEM = `你是一次性历史记忆迁移器。输入全部是回顾性日记或旧回忆，绝对不是用户当前状态的证据。
只输出合法 JSON：{"candidates":[...]} 。每个候选的 type 只能是 ordinary 或 sensitive_history，必须包含 dedupe_key、title、summary、retrieval_tags。
ordinary 只收录稳定偏好、重要关系事实、持续项目、共同设定或未来仍有用的具体了解。
sensitive_history 只收录明确已发生且将来互动需要谨慎知道的敏感经历，并额外提供 occurred_at 和 interaction_implications。
不得输出 current_state，不得把当时的情绪当成稳定人格，不得心理诊断，不得凭旧记忆推断现在仍如此。
日记可能有文学化总结或缪时的主观语气；优先保留明确事实，不要将推测写成事实。缪时说的话不能自动当成 Yuxin 的自述。
宁可少存，不要滥存。每批最多 12 条，不要输出解释。输出必须能被 JSON.parse 直接解析，字符串内容中的双引号必须正确转义。`

async function extract(chunk, index, total) {
  const payload = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 5000,
    system: SYSTEM,
    messages: [{ role: 'user', content: `历史资料批次 ${index}/${total}：\n\n${chunk.join('\n\n')}` }],
  })
  const { status, body } = await curlAnthropic(payload)
  const data = JSON.parse(body)
  console.info(`Batch ${index}/${total}: status=${status}, stop=${data.stop_reason || 'n/a'}, input=${data.usage?.input_tokens ?? 'n/a'}, output=${data.usage?.output_tokens ?? 'n/a'}`)
  if (status < 200 || status >= 300) throw new Error(`Claude API failed: ${data.error?.message || status}`)
  if (data.stop_reason === 'max_tokens') throw new Error(`Batch ${index} hit token limit; refusing partial JSON`)
  const text = (data.content || []).filter(block => block.type === 'text').map(block => block.text).join('')
  const parsed = parseJsonObject(text)
  return Array.isArray(parsed.candidates) ? parsed.candidates : []
}

function curlAnthropic(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn('curl', [
      '--silent', '--show-error', '--proxy', SOCKS_PROXY,
      '--output', '-', '--write-out', '\n%{http_code}',
      '--request', 'POST', 'https://api.anthropic.com/v1/messages',
      '--header', 'content-type: application/json',
      '--header', `x-api-key: ${ANTHROPIC_KEY}`,
      '--header', 'anthropic-version: 2023-06-01',
      '--data-binary', '@-',
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`curl failed (${code}): ${stderr.trim()}`))
      const split = stdout.lastIndexOf('\n')
      resolve({ body: stdout.slice(0, split), status: Number(stdout.slice(split + 1)) })
    })
    child.stdin.end(payload)
  })
}

function normalize(candidate, now) {
  if (!candidate || !['ordinary', 'sensitive_history'].includes(candidate.type)) return null
  const base = {
    id: uniqueId(candidate.type),
    type: candidate.type,
    dedupe_key: String(candidate.dedupe_key || candidate.title || '').trim().slice(0, 120),
    title: String(candidate.title || '').trim().slice(0, 160),
    summary: String(candidate.summary || '').trim().slice(0, 800),
    retrieval_tags: cleanArray(candidate.retrieval_tags),
    created_at: now,
    updated_at: now,
    source: 'historical-backfill',
  }
  if (!base.dedupe_key || !base.title || !base.summary) return null
  if (candidate.type === 'sensitive_history') return {
    ...base,
    occurred_at: String(candidate.occurred_at || '时间不详').slice(0, 120),
    current_status: 'historical',
    interaction_implications: cleanArray(candidate.interaction_implications),
    sensitivity: 'high',
  }
  return base
}

function mergeByDedupeKey(existing, additions) {
  const merged = [...existing]
  const seen = new Set(existing.map(item => item.dedupe_key).filter(Boolean))
  for (const item of additions) {
    if (seen.has(item.dedupe_key)) continue
    seen.add(item.dedupe_key)
    merged.unshift(item)
  }
  return merged.slice(0, 250)
}

const [diaries, memoirs, ordinary, historical, current] = await Promise.all([
  redisGet(SOURCE_KEYS[0]),
  redisGet(SOURCE_KEYS[1]),
  redisGet(MEMORY_KEYS.ordinary),
  redisGet(MEMORY_KEYS.sensitive_history),
  redisGet(MEMORY_KEYS.current_state),
])

const records = [
  ...diaries.map(item => ({ ...item, source: '回顾性日记', speaker: item.fromMuse ? '缪时' : 'Yuxin' })),
  ...memoirs.map(item => ({ ...item, source: '旧回忆录', speaker: item.fromMuse ? '缪时' : 'Yuxin' })),
].filter(item => String(item.text || '').trim())
  .sort((a, b) => new Date(a.time || 0) - new Date(b.time || 0))

const chunks = chunksByCharacters(records)
console.info(`Sources: diaries=${diaries.length}, memoirs=${memoirs.length}, characters=${records.reduce((sum, item) => sum + item.text.length, 0)}`)
console.info(`Existing: ordinary=${ordinary.length}, sensitive_history=${historical.length}, current_state=${current.length}`)
console.info(`Planned Claude calls: ${chunks.length}`)

if (!APPLY) {
  console.info('Preflight only. Re-run with --apply to back up, extract, and write historical memories.')
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupPrefix = `memory-backup-${stamp}`
await Promise.all([
  redisSet(`${backupPrefix}-ordinary`, ordinary),
  redisSet(`${backupPrefix}-sensitive-history`, historical),
  redisSet(`${backupPrefix}-current-state`, current),
  redisSet(`${backupPrefix}-manifest`, { created_at: new Date().toISOString(), source_keys: SOURCE_KEYS, memory_keys: MEMORY_KEYS }),
])
console.info(`Backup created: ${backupPrefix}-*`)

const candidates = []
for (let index = 0; index < chunks.length; index += 1) {
  try {
    candidates.push(...await extract(chunks[index], index + 1, chunks.length))
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    console.warn('Batch ' + (index + 1) + ' returned invalid JSON; retrying once')
    candidates.push(...await extract(chunks[index], index + 1, chunks.length))
  }
}
const now = new Date().toISOString()
const normalized = candidates.map(candidate => normalize(candidate, now)).filter(Boolean)
const ordinaryAdditions = normalized.filter(item => item.type === 'ordinary')
const historicalAdditions = normalized.filter(item => item.type === 'sensitive_history')
const nextOrdinary = mergeByDedupeKey(ordinary, ordinaryAdditions)
const nextHistorical = mergeByDedupeKey(historical, historicalAdditions)

await Promise.all([
  redisSet(MEMORY_KEYS.ordinary, nextOrdinary),
  redisSet(MEMORY_KEYS.sensitive_history, nextHistorical),
])
console.info(`Written: ordinary +${nextOrdinary.length - ordinary.length}, sensitive_history +${nextHistorical.length - historical.length}, current_state unchanged (${current.length})`)
