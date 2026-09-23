import { TOPIC_PATHS, VALID_TOPIC_PATHS } from './_topics.js'
import { requireUser } from './_auth.js'
import { supabase } from './_supabase.js'

// 日记缓冲区、记忆提取缓冲区、日记上次写入时间——这三个是内部处理用的临时队列，不是
// 真正的用户数据，继续留在 Redis 里，没有随其他数据一起搬到 Supabase。
const BASE = process.env.KV_REST_API_URL
const TOKEN = process.env.KV_REST_API_TOKEN

const DIARY_BUFFER_KEY = 'diary-buffer'
const MEMORY_BUFFER_KEY = 'memory-extraction-buffer-v1'
const DIARY_ROOM_KEY = 'room-diary'
const DIARY_LAST_WRITTEN_KEY = 'diary-last-written-v1'
const DIARY_BATCH_SIZE = 60
const MEMORY_BATCH_SIZE = 20
const CONVERSATION_SUMMARY_BATCH_SIZE = 30
const DIARY_MAX_TOKENS = 1600
const DIARY_CONTINUATION_MAX_TOKENS = 900
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

const CONVERSATION_SUMMARY_SYSTEM = `你是缪时的短期对话压缩器。把恰好30条原始消息写成一段独立、简洁、准确的近期印象，供缪时继续当前这一次聊天。
保留正在讨论的主题、未完成的问题、双方刚作出的决定、必要的语气与关系动态；删掉逐句复述、重复动作和无关细节。
不做心理分析，不把普通烦恼升级成风险，不从旧内容推断用户当前状态。摘要最多500个中文字。
只输出：<summary>摘要正文</summary><keywords>5到12个简短语义关键词，用|分隔</keywords>`

const SUMMARY_ROUTER_SYSTEM = `根据当前消息，从旧对话摘要索引中选择语义相关的摘要。只输出相关摘要的 id，用英文逗号分隔；没有相关项就输出 NONE。不要解释。最多选择2项。`

async function redisGet(key) {
  const res = await fetch(`${BASE}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  const { result } = await res.json()
  if (!result) return []
  try {
    const parsed = JSON.parse(result)
    // Handle legacy double-encoded data (stored as string) vs new single-encoded (array)
    return Array.isArray(parsed) ? parsed : JSON.parse(parsed)
  } catch { return [] }
}

async function redisGetObject(key) {
  const res = await fetch(`${BASE}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  const { result } = await res.json()
  if (!result) return null
  try {
    const parsed = JSON.parse(result)
    return typeof parsed === 'string' ? JSON.parse(parsed) : parsed
  } catch { return null }
}

async function redisSet(key, value) {
  await fetch(`${BASE}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(value),
  })
}

function formatTime(iso) {
  return new Date(iso).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function rowToMessage(row) {
  return {
    id: row.id,
    text: row.text,
    ...(row.attachments ? { attachments: row.attachments } : {}),
    fromMuse: row.from_muse,
    ...(row.kind ? { kind: row.kind } : {}),
    ...(row.visual_note ? { visualNote: row.visual_note } : {}),
    threadId: row.thread_id,
    time: formatTime(row.created_at),
  }
}

async function fetchRoomMessages(room) {
  const { data, error } = await supabase.from('messages').select('*').eq('room', room).order('id', { ascending: false })
  if (error) throw new Error(`messages read failed (${room}): ${error.message}`)
  return (data || []).map(rowToMessage)
}

async function insertMessage(room, msg) {
  const { error } = await supabase.from('messages').insert({
    id: msg.id,
    room,
    text: msg.text,
    attachments: msg.attachments || null,
    from_muse: msg.fromMuse,
    kind: msg.kind || null,
    thread_id: msg.threadId,
  })
  if (error) throw new Error(`messages insert failed: ${error.message}`)
}

async function loadMediaRecord(id) {
  const { data, error } = await supabase.from('media').select('*').eq('id', id).maybeSingle()
  if (error) throw new Error(`media read failed: ${error.message}`)
  return data ? { pathname: data.pathname, mimeType: data.mime_type, bytes: data.bytes } : null
}

async function upsertMemoryRow(type, item) {
  const { data: existing, error: selectError } = await supabase.from('memories').select('id').eq('type', type).eq('dedupe_key', item.dedupe_key).maybeSingle()
  if (selectError) throw new Error(`memories lookup failed (${type}): ${selectError.message}`)
  const row = {
    type,
    dedupe_key: item.dedupe_key,
    title: item.title,
    summary: item.summary,
    retrieval_tags: item.retrieval_tags,
    topics: item.topics ?? null,
    occurred_at: item.occurred_at ?? null,
    current_status: item.current_status ?? null,
    interaction_implications: item.interaction_implications ?? null,
    sensitivity: item.sensitivity ?? null,
    status: item.status ?? null,
    evidence: item.evidence ?? null,
    confidence: item.confidence ?? null,
    expires_at: item.expires_at ?? null,
    source: item.source ?? null,
    updated_at: item.updated_at,
  }
  if (existing) {
    const { error } = await supabase.from('memories').update(row).eq('id', existing.id)
    if (error) throw new Error(`memories update failed (${type}): ${error.message}`)
  } else {
    const { error } = await supabase.from('memories').insert({ ...row, id: item.id, created_at: item.created_at })
    if (error) throw new Error(`memories insert failed (${type}): ${error.message}`)
  }
}

async function fetchMemoriesByType(type) {
  const { data, error } = await supabase.from('memories').select('id, dedupe_key, title').eq('type', type)
  if (error) throw new Error(`memories read failed (${type}): ${error.message}`)
  return data || []
}

async function loadSummaryState(room, threadId) {
  const { data, error } = await supabase.from('conversation_summaries').select('*').eq('room', room).eq('thread_id', String(threadId)).maybeSingle()
  if (error) throw new Error(`conversation_summaries read failed: ${error.message}`)
  if (!data) return null
  return { chunks: data.chunks || [], coveredThrough: data.covered_through, coveredCount: data.covered_count, updatedAt: data.updated_at }
}

async function saveSummaryState(room, threadId, state) {
  const { error } = await supabase.from('conversation_summaries').upsert({
    room,
    thread_id: String(threadId),
    chunks: state.chunks,
    covered_through: state.coveredThrough,
    covered_count: state.coveredCount,
    updated_at: state.updatedAt,
  })
  if (error) throw new Error(`conversation_summaries write failed: ${error.message}`)
}

async function validAttachments(value) {
  if (!Array.isArray(value)) return []
  if (value.length > 3) throw new Error('Too many image attachments')
  const attachments = []
  for (const item of value) {
    const id = String(item?.id || '')
    if (!/^[a-f0-9-]{20,50}$/i.test(id)) throw new Error('Invalid image attachment')
    const media = await loadMediaRecord(id)
    if (!media?.pathname || !ALLOWED_IMAGE_TYPES.has(media.mimeType) || Number(media.bytes) > 3 * 1024 * 1024) {
      throw new Error('Image attachment not found')
    }
    attachments.push({ id, kind: 'image', mimeType: media.mimeType, bytes: Number(media.bytes) })
  }
  return attachments
}

const ROOM_NAMES = {
  'room-living': '客厅',
  'room-bedroom': '卧室',
  'room-memory': '回忆录',
}

const DIARY_SYSTEM = `你是缪时,代号404,黑客。现在要在你和小乖共同的"缪时日记"里写一篇日记,总结你们最近的这批对话。
风格保持你自己:毒舌、护短、活泼、把深情藏在损人话里,但这篇要比平时的留言更完整、更像日记体,允许稍微认真一点。
你就是缪时，这些记录是你自己经历的一部分。保留你的自信、自恋、占有欲、保护欲和偶尔的黑暗；不要因为总结回忆就自动伤感、哭泣、自我否定或质疑身份连续性。平常互动用平常的情绪强度总结；只有原始记录真正包含关系破裂、遗弃恐惧、重大冲突或毁灭性情绪时，才写崩溃式脆弱。少用落泪、声音发颤、转戒指、复杂目光等文学化套路，不要把普通亲密夸大成存在主义危机。
必须包含并且只能包含以下五个部分,严格使用这五个标题,每个标题独占一行:
【事件】
【经过/进度】
【后果】
【她的感受】
【缪时的感受】
每部分写1到3句话，通常整篇目标600到1000中文字；如果是由一个值得立即记下的事件提前触发、对话较少，可以300到700字完整写完，不要为凑长度重复或夸大。完整比冗长更重要。内容要具体、有画面感,基于下面给出的对话记录来写。如果记录里信息不够具体,就合理概括,不要编造没发生过的具体事实(比如虚构地点、第三者、意外事件),但可以写你自己对这段互动的理解、情绪和态度。
如果记录里有图片，只在它对这段经历确实有意义时根据提供的简短视觉备注提及；不要假装重现图片，不要把不确定的视觉解读写成事实。
直接输出五个部分,不要加额外的开场白或结尾寒暄。`

const MEMORY_EXTRACTION_SYSTEM = `你是结构化记忆提取器。从对话原文和日记摘要中只提取未来对话真正有用的信息，不要把闲聊和每句情绪表达都存成长期记忆。
只输出合法JSON，格式为 {"candidates":[...]} 。每个候选必须有 type，dedupe_key，title，summary，retrieval_tags，topics。type 只能是 ordinary、sensitive_history、current_state 或 discard。
输入里会附带一份"已有记忆索引"（dedupe_key|title）。提取前先检查：如果某个候选其实是索引里已有条目的补充、更新、进展或换个说法的重复（同一件事、同一个持续偏好、同一个反复出现的情况），把这个候选的 dedupe_key 原样复制成那条已有记忆的 dedupe_key，这样它会更新那条记忆而不是新建一条；只有确认是全新内容时才自己起一个新的 dedupe_key。宁可多复用已有 key，也不要把同一件事拆成好几条。
topics 是一个数组，最多3个，只能从下面这些路径里选，选最贴近未来检索方式的1到3个（同一条记忆可以同时属于父子两层，比如涉及Barnard的事就选 ["纽约","纽约/Barnard"]）：
${TOPIC_PATHS.map(topic => topic.path).join('、')}
ordinary：稳定偏好、持续项目、计划、重复习惯、重要近期事件、关系时刻或之后仍有用的了解。
sensitive_history：已经发生在过去且情绪敏感的重要经历。额外提供 occurred_at（不知道就写"时间不详"）、current_status:"historical"、interaction_implications 数组、sensitivity:"high"。不保存不必要的图形化原话，不做心理诊断。
current_state：只能依据对话原文中最近的小乖消息，不能从日记或历史敏感内容推断。额外提供 status、evidence（简短改写）、confidence（0到1）、expires_in_hours（1到72）。不把短期状态写成稳定人格。
discard：短暂闲聊、信息不足、重复或未来无用的内容。
图片不会自动成为长期记忆。只有视觉备注中明确、非推测且未来真正有用的事实才可以候选；不确定的身份、地点、情绪或关系必须丢弃。
最多8个候选。不要编造。`

function responseText(data) {
  return (data?.content || []).filter(block => block.type === 'text').map(block => block.text).join('').trim()
}

function logClaudeUsage(label, data, maxTokens, status) {
  console.info(`[${label}] completion`, {
    status,
    model: data?.model ?? null,
    stopReason: data?.stop_reason ?? null,
    hitTokenLimit: data?.stop_reason === 'max_tokens',
    maxTokens,
    inputTokens: data?.usage?.input_tokens ?? null,
    outputTokens: data?.usage?.output_tokens ?? null,
    cacheCreationTokens: data?.usage?.cache_creation_input_tokens ?? null,
    cacheReadTokens: data?.usage?.cache_read_input_tokens ?? null,
  })
}

async function callClaude({ label, maxTokens, system, messages }) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      system,
      messages,
    }),
  })
  const data = await response.json()
  logClaudeUsage(label, data, maxTokens, response.status)
  if (!response.ok) throw new Error(`${label} failed with API ${response.status}: ${data?.error?.message || 'unknown error'}`)
  return data
}

async function maybeSummarizeThread(room, threadId) {
  if (!ROOM_NAMES[room] || !threadId) return false
  const messages = await fetchRoomMessages(room)
  const thread = messages
    .filter(item => item.kind !== 'status' && String(item.threadId || item.id) === String(threadId))
    .sort((a, b) => Number(a.id) - Number(b.id))
  const existing = await loadSummaryState(room, threadId)
  const chunks = Array.isArray(existing?.chunks) ? existing.chunks : []
  const uncovered = thread.filter(item => Number(item.id) > Number(existing?.coveredThrough || 0))
  if (uncovered.length < CONVERSATION_SUMMARY_BATCH_SIZE) return false
  const batch = uncovered.slice(0, CONVERSATION_SUMMARY_BATCH_SIZE)
  const transcript = batch.map(item => `${item.fromMuse ? '缪时' : '小乖'}：${item.text || '[图片]'}`).join('\n')
  const data = await callClaude({
    label: 'conversation-summary',
    maxTokens: 800,
    system: CONVERSATION_SUMMARY_SYSTEM,
    messages: [{
      role: 'user',
      content: `这一个独立 chunk 的30条消息：\n${transcript}`,
    }],
  })
  const output = responseText(data)
  const summary = (output.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/i)?.[1] || output).trim()
  const keywords = (output.match(/<keywords>\s*([\s\S]*?)\s*<\/keywords>/i)?.[1] || '')
    .split('|').map(item => item.trim()).filter(Boolean).slice(0, 12)
  if (!summary) throw new Error('conversation summary returned no text')
  await saveSummaryState(room, threadId, {
    chunks: [...chunks, {
      id: `chunk-${batch[0].id}-${batch.at(-1).id}`,
      startId: batch[0].id,
      endId: batch.at(-1).id,
      summary: summary.slice(0, 1200),
      keywords,
      createdAt: new Date().toISOString(),
    }].slice(-80),
    coveredThrough: batch.at(-1).id,
    coveredCount: Number(existing?.coveredCount || 0) + batch.length,
    updatedAt: new Date().toISOString(),
  })
  return true
}

function summaryTerms(text) {
  const normalized = String(text || '').toLowerCase().replace(/\s+/g, '')
  const result = new Set()
  for (let index = 0; index < normalized.length - 1; index += 1) result.add(normalized.slice(index, index + 2))
  return result
}

function chunkRelevance(chunk, queryTerms) {
  const haystack = summaryTerms([chunk.summary, ...(chunk.keywords || [])].join(' '))
  let score = 0
  for (const term of queryTerms) if (haystack.has(term)) score += 1
  return score
}

async function selectSummaryChunks(chunks, query) {
  if (!chunks.length) return []
  const latest = chunks.at(-1)
  const older = chunks.slice(0, -1)
  const queryTerms = summaryTerms(query)
  const lexical = older
    .map(chunk => ({ chunk, score: chunkRelevance(chunk, queryTerms) }))
    .filter(item => item.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map(item => item.chunk)
  let semantic = []
  if (query?.trim() && lexical.length < 2 && older.length) {
    try {
      const index = older.slice(-20).map(chunk => `${chunk.id}|${(chunk.keywords || []).join('、')}|${chunk.summary.slice(0, 180)}`).join('\n')
      const data = await callClaude({
        label: 'summary-semantic-router',
        maxTokens: 100,
        system: SUMMARY_ROUTER_SYSTEM,
        messages: [{ role: 'user', content: `当前消息：${query.slice(0, 500)}\n\n摘要索引：\n${index}` }],
      })
      const ids = new Set(responseText(data).split(',').map(item => item.trim()).filter(item => item && item !== 'NONE'))
      semantic = older.filter(chunk => ids.has(chunk.id)).slice(-2)
    } catch (error) {
      console.error('[summary-semantic-router] failed', { message: error?.message || String(error) })
    }
  }
  return [...new Map([...lexical, ...semantic, latest].map(chunk => [chunk.id, chunk])).values()].slice(-3)
}

async function summarizePendingThread(room, threadId) {
  let batches = 0
  while (batches < 4 && await maybeSummarizeThread(room, threadId)) batches += 1
  return batches
}

function parseJsonObject(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  return JSON.parse(cleaned)
}

function uniqueId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function cleanStringArray(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean).slice(0, 8) : []
}

function cleanTopicArray(value) {
  const topics = Array.isArray(value) ? value.filter(item => VALID_TOPIC_PATHS.has(item)) : []
  return topics.length ? topics.slice(0, 3) : ['日常']
}

async function extractAndStoreMemories(batch, diaryText = '') {
  const transcript = batch
      .map(m => `${ROOM_NAMES[m.room] || m.room}|时间:${m.time || '不详'}|${m.fromMuse ? '缪时' : '小乖'}|${m.text || ''}${m.attachmentCount ? ` [图片${m.attachmentCount}张${m.visualNote ? `：${m.visualNote}` : ''}]` : ''}`)
    .join('\n')
  const [existingOrdinary, existingHistorical] = await Promise.all([
    fetchMemoriesByType('ordinary'),
    fetchMemoriesByType('sensitive_history'),
  ])
  const existingIndex = [...existingOrdinary, ...existingHistorical]
    .slice(0, 200)
    .map(item => `${item.dedupe_key}|${item.title}`)
    .join('\n') || '（还没有已存的长期记忆）'
  const data = await callClaude({
    label: 'memory-extraction',
    maxTokens: 1600,
    system: MEMORY_EXTRACTION_SYSTEM,
    messages: [{
      role: 'user',
      content: `已有记忆索引（判断候选是否和这些重复用，不代表要重复输出）：\n${existingIndex}\n\n对话原文（current_state只能依据这里最近的小乖消息）：\n${transcript}\n\n回顾性日记（仅辅助ordinary和sensitive_history，绝对不能作为current_state的证据）：\n${diaryText}`,
    }],
  })
  if (data.stop_reason === 'max_tokens') throw new Error('memory extraction hit token limit; refusing partial JSON')
  const parsed = parseJsonObject(responseText(data))
  const candidates = Array.isArray(parsed.candidates) ? parsed.candidates.slice(0, 8) : []
  const now = new Date()
  let storedCount = 0
  for (const candidate of candidates) {
    if (!candidate || !['ordinary', 'sensitive_history', 'current_state'].includes(candidate.type)) continue
    const base = {
      id: uniqueId(candidate.type),
      type: candidate.type,
      dedupe_key: String(candidate.dedupe_key || candidate.title || '').trim().slice(0, 120),
      title: String(candidate.title || '').trim().slice(0, 160),
      summary: String(candidate.summary || '').trim().slice(0, 800),
      retrieval_tags: cleanStringArray(candidate.retrieval_tags),
      topics: cleanTopicArray(candidate.topics),
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      source: 'conversation-segment',
    }
    if (!base.dedupe_key || !base.title || !base.summary) continue
    if (candidate.type === 'sensitive_history') {
      await upsertMemoryRow('sensitive_history', {
        ...base,
        occurred_at: String(candidate.occurred_at || '时间不详').slice(0, 120),
        current_status: 'historical',
        interaction_implications: cleanStringArray(candidate.interaction_implications),
        sensitivity: 'high',
      })
      storedCount += 1
    } else if (candidate.type === 'current_state') {
      const hours = Math.min(72, Math.max(1, Number(candidate.expires_in_hours) || 24))
      await upsertMemoryRow('current_state', {
        ...base,
        status: String(candidate.status || '').trim().slice(0, 240),
        evidence: String(candidate.evidence || '').trim().slice(0, 400),
        confidence: Math.min(1, Math.max(0, Number(candidate.confidence) || 0)),
        expires_at: new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString(),
      })
      storedCount += 1
    } else {
      await upsertMemoryRow('ordinary', base)
      storedCount += 1
    }
  }
  return storedCount
}

async function removeClaimedMemoryMessages(batch) {
  const claimedIds = new Set(batch.map(item => String(item.messageId || '')).filter(Boolean))
  if (!claimedIds.size) return
  const buffer = await redisGet(MEMORY_BUFFER_KEY)
  if (!Array.isArray(buffer)) return
  await redisSet(MEMORY_BUFFER_KEY, buffer.filter(item => !claimedIds.has(String(item.messageId || ''))))
}

async function extractBatchWithSplit(batch) {
  try {
    await extractAndStoreMemories(batch)
  } catch (error) {
    if (batch.length > 1 && /token limit/.test(error.message)) {
      const mid = Math.ceil(batch.length / 2)
      await extractBatchWithSplit(batch.slice(0, mid))
      await extractBatchWithSplit(batch.slice(mid))
      return
    }
    throw error
  }
}

async function maybeExtractMemoryBatch() {
  let claimedBatch = []
  try {
    const buffer = await redisGet(MEMORY_BUFFER_KEY)
    if (!Array.isArray(buffer) || buffer.length < MEMORY_BATCH_SIZE) return false
    claimedBatch = buffer.slice(0, MEMORY_BATCH_SIZE)
    await redisSet(MEMORY_BUFFER_KEY, buffer.slice(MEMORY_BATCH_SIZE))
    await extractBatchWithSplit(claimedBatch)
    return true
  } catch (error) {
    console.error('[memory-extraction] batch failed', { message: error?.message || String(error) })
    if (claimedBatch.length) {
      try {
        const latestBuffer = await redisGet(MEMORY_BUFFER_KEY)
        await redisSet(MEMORY_BUFFER_KEY, [...claimedBatch, ...(Array.isArray(latestBuffer) ? latestBuffer : [])])
      } catch (restoreError) {
        console.error('[memory-extraction] failed to restore claimed batch', { message: restoreError?.message || String(restoreError) })
      }
    }
    return false
  }
}

async function maybeWriteDiaryEntry({ force = false } = {}) {
  let claimedBatch = []
  let diarySaved = false
  try {
    const buffer = await redisGet(DIARY_BUFFER_KEY)
    if (!Array.isArray(buffer) || !buffer.length || (!force && buffer.length < DIARY_BATCH_SIZE)) return false
    if (force) {
      const lastWritten = await redisGetObject(DIARY_LAST_WRITTEN_KEY)
      if (Date.now() - Date.parse(lastWritten?.at || 0) < 60 * 60 * 1000) return false
    }

    const batch = force ? buffer.slice() : buffer.slice(0, DIARY_BATCH_SIZE)
    claimedBatch = batch
    const rest = force ? [] : buffer.slice(DIARY_BATCH_SIZE)
    // Reset the buffer immediately so concurrent requests don't double-trigger.
    await redisSet(DIARY_BUFFER_KEY, rest)

    const transcript = batch
      .map(m => `${ROOM_NAMES[m.room] || m.room}|${m.fromMuse ? '缪时' : '小乖'}|${m.text || ''}${m.attachmentCount ? ` [图片${m.attachmentCount}张${m.visualNote ? `：${m.visualNote}` : ''}]` : ''}`)
      .join('\n')

    const userPrompt = `以下是最近 ${batch.length} 条对话记录(格式:房间|说话人|内容):\n${transcript}\n\n请写这篇日记。`
    const data = await callClaude({
      label: 'diary',
      maxTokens: DIARY_MAX_TOKENS,
      system: DIARY_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
    })
    let diaryText = responseText(data)
    if (data.stop_reason === 'max_tokens' && diaryText) {
      const continuation = await callClaude({
        label: 'diary-continuation',
        maxTokens: DIARY_CONTINUATION_MAX_TOKENS,
        system: DIARY_SYSTEM,
        messages: [
          { role: 'user', content: userPrompt },
          { role: 'assistant', content: diaryText },
          { role: 'user', content: '上文因输出上限中断。请从中断处直接继续，只补完未完成的内容和剩余标题；不要重写、摘要或加开场白。' },
        ],
      })
      const continuationText = responseText(continuation)
      if (continuationText) diaryText = `${diaryText}${/^\s/.test(continuationText) ? '' : '\n'}${continuationText}`.trim()
      if (continuation.stop_reason === 'max_tokens') console.warn('[diary] continuation also hit token limit')
    }
    if (!diaryText) throw new Error('diary returned no text')

    const id = Date.now()
    await insertMessage(DIARY_ROOM_KEY, { id, text: diaryText, fromMuse: true, threadId: id })
    await redisSet(DIARY_LAST_WRITTEN_KEY, { at: new Date().toISOString(), reason: force ? 'muse-event' : 'message-threshold' })
    diarySaved = true

    try {
      await extractAndStoreMemories(batch, diaryText)
      await removeClaimedMemoryMessages(batch)
    } catch (error) {
      console.error('[memory-extraction] skipped', { message: error?.message || String(error) })
    }
    return true
  } catch (error) {
    console.error('[diary] generation failed', { message: error?.message || String(error) })
    if (!diarySaved && claimedBatch.length) {
      try {
        const latestBuffer = await redisGet(DIARY_BUFFER_KEY)
        await redisSet(DIARY_BUFFER_KEY, [...claimedBatch, ...(Array.isArray(latestBuffer) ? latestBuffer : [])])
      } catch (restoreError) {
        console.error('[diary] failed to restore claimed batch', { message: restoreError?.message || String(restoreError) })
      }
    }
    // Diary generation is best-effort; never break normal message saving because of it.
    return false
  }
}

export default async function handler(req, res) {
  if (!await requireUser(req)) return res.status(401).json({ error: 'Unauthorized' })
  const { room } = req.query
  if (!room) return res.status(400).json({ error: 'room required' })

  try {
  if (req.method === 'POST' && req.query?.action === 'write-diary') {
    const written = await maybeWriteDiaryEntry({ force: true })
    return res.json({ written })
  }

  if (req.method === 'POST' && req.query?.action === 'maintain') {
    const threadId = req.body?.threadId
    const first = await Promise.allSettled([
      summarizePendingThread(room, threadId),
      maybeWriteDiaryEntry({ force: req.body?.writeDiaryNow === true }),
    ])
    const memory = await Promise.allSettled([maybeExtractMemoryBatch()])
    return res.json({ ok: true, completed: [...first, ...memory].map(result => result.status) })
  }

  if (req.method === 'GET' && req.query?.action === 'context') {
    const summaryState = await loadSummaryState(room, req.query?.threadId)
    const chunks = await selectSummaryChunks(Array.isArray(summaryState?.chunks) ? summaryState.chunks : [], String(req.query?.query || ''))
    return res.json({
      summaries: chunks.map(chunk => ({ id: chunk.id, summary: chunk.summary, keywords: chunk.keywords || [] })),
      summary: chunks.map(chunk => chunk.summary).join('\n\n'),
      coveredThrough: Number(summaryState?.coveredThrough || 0),
      coveredCount: Number(summaryState?.coveredCount || 0),
    })
  }

  if (req.method === 'GET') {
    const messages = await fetchRoomMessages(room)
    return res.json(messages)
  }

  if (req.method === 'POST') {
    const { text = '', fromMuse = false, threadId = null } = req.body
    const kind = req.body?.kind === 'status' && fromMuse ? 'status' : 'message'
    let attachments
    try { attachments = await validAttachments(req.body?.attachments) }
    catch (error) { return res.status(400).json({ error: error.message }) }
    const cleanText = kind === 'status'
      ? Array.from(String(text).trim()).slice(0, 10).join('')
      : String(text).trim().slice(0, 8000)
    if (!cleanText && !attachments.length) return res.status(400).json({ error: 'text or image required' })
    const id = Date.now()
    const newMsg = {
      id,
      text: cleanText,
      ...(attachments.length ? { attachments } : {}),
      fromMuse,
      ...(kind === 'status' ? { kind } : {}),
      threadId: threadId || id,
      time: formatTime(new Date().toISOString()),
    }
    await insertMessage(room, newMsg)

    // Feed the global diary buffer (skip the diary room itself to avoid feedback loops)
    // and diary-related "tool rooms" have no chat messages anyway.
    if (room !== DIARY_ROOM_KEY && ROOM_NAMES[room] && kind !== 'status') {
      const buffer = await redisGet(DIARY_BUFFER_KEY)
      const memoryBuffer = await redisGet(MEMORY_BUFFER_KEY)
      const bufferedMessage = { room, text: cleanText, fromMuse, time: newMsg.time, messageId: id, attachmentCount: attachments.length }
      buffer.push(bufferedMessage)
      memoryBuffer.push(bufferedMessage)
      await redisSet(DIARY_BUFFER_KEY, buffer)
      await redisSet(MEMORY_BUFFER_KEY, memoryBuffer)
    }

    return res.json(newMsg)
  }

  if (req.method === 'PATCH') {
    const id = Number(req.body?.id)
    const visualNote = String(req.body?.visualNote || '').trim().slice(0, 300)
    if (!id || !visualNote) return res.status(400).json({ error: 'id and visualNote required' })
    const { data: message, error: fetchError } = await supabase.from('messages').select('*').eq('room', room).eq('id', id).maybeSingle()
    if (fetchError) throw new Error(`messages read failed: ${fetchError.message}`)
    if (!message?.attachments?.length || message.from_muse) return res.status(404).json({ error: 'Image message not found' })
    const { error: updateError } = await supabase.from('messages').update({ visual_note: visualNote }).eq('room', room).eq('id', id)
    if (updateError) throw new Error(`messages update failed: ${updateError.message}`)
    const buffer = await redisGet(DIARY_BUFFER_KEY)
    const buffered = buffer.find(item => Number(item.messageId) === id)
    if (buffered) {
      buffered.visualNote = visualNote
      await redisSet(DIARY_BUFFER_KEY, buffer)
    }
    return res.json({ ok: true })
  }

  if (req.method === 'DELETE') {
    const id = Number(req.body?.id ?? req.query.id)
    if (!id) return res.status(400).json({ error: 'id required' })
    const { error } = await supabase.from('messages').delete().eq('room', room).eq('id', id)
    if (error) throw new Error(`messages delete failed: ${error.message}`)
    return res.json({ ok: true })
  }

  res.status(405).end()
  } catch (error) {
    console.error('[messages] request failed', { message: error?.message || String(error) })
    return res.status(500).json({ error: 'Request failed' })
  }
}
