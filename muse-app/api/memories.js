const BASE = process.env.KV_REST_API_URL
const TOKEN = process.env.KV_REST_API_TOKEN

const MEMORY_KEYS = {
  ordinary: 'memory-v1-ordinary',
  sensitive_history: 'memory-v1-sensitive-history',
  current_state: 'memory-v1-current-state',
}

async function redisGet(key) {
  const res = await fetch(`${BASE}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  const { result } = await res.json()
  if (!result) return []
  try {
    const parsed = JSON.parse(result)
    return Array.isArray(parsed) ? parsed : JSON.parse(parsed)
  } catch { return [] }
}

async function redisSet(key, value) {
  const response = await fetch(`${BASE}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(value),
  })
  if (!response.ok) throw new Error(`KV write failed with ${response.status}`)
}

function memoryKey(type) {
  return MEMORY_KEYS[type] || null
}

function publicMemory(memory) {
  return {
    id: memory.id,
    type: memory.type,
    title: memory.title,
    summary: memory.summary,
    retrieval_tags: memory.retrieval_tags || [],
    occurred_at: memory.occurred_at || null,
    current_status: memory.current_status || null,
    interaction_implications: memory.interaction_implications || [],
    sensitivity: memory.sensitivity || null,
    status: memory.status || null,
    evidence: memory.evidence || null,
    confidence: memory.confidence ?? null,
    created_at: memory.created_at || null,
    updated_at: memory.updated_at || null,
    expires_at: memory.expires_at || null,
  }
}

function terms(text) {
  const normalized = String(text || '').toLowerCase().replace(/\s+/g, '')
  const chunks = new Set()
  for (let index = 0; index < normalized.length - 1; index += 1) chunks.add(normalized.slice(index, index + 2))
  return chunks
}

function relevance(memory, queryTerms) {
  if (!queryTerms.size) return 0
  const haystack = terms([memory.title, memory.summary, ...(memory.retrieval_tags || [])].join(' '))
  let score = 0
  for (const term of queryTerms) if (haystack.has(term)) score += 1
  return score
}

function newestFirst(a, b) {
  return new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0)
}

function pickRelevant(memories, query, limit, minimumScore = 1) {
  const queryTerms = terms(query)
  return memories
    .map(memory => ({ memory, score: relevance(memory, queryTerms) }))
    .filter(item => item.score >= minimumScore)
    .sort((a, b) => b.score - a.score || newestFirst(a.memory, b.memory))
    .slice(0, limit)
    .map(item => item.memory)
}

function formatContext(ordinary, historical, current) {
  const sections = []
  if (ordinary.length) {
    sections.push(`【相关的普通长期记忆】\n${ordinary.map(item => `- ${item.summary}`).join('\n')}`)
  }
  if (historical.length) {
    sections.push(`【相关的历史敏感记忆——HISTORICAL，不是当前正在发生】\n这些内容只是过去背景，不要从中推断小乖当前处于同样状态，也不要强迫她详细回忆或用它解释她的一切。\n${historical.map(item => `- [${item.occurred_at || '时间不详'}] ${item.summary}${item.interaction_implications?.length ? `；互动提醒：${item.interaction_implications.join('；')}` : ''}`).join('\n')}`)
  }
  if (current.length) {
    sections.push(`【当前状态——有时效，仅基于近期对话】\n${current.map(item => `- ${item.status || item.summary}（截止 ${item.expires_at}，置信度 ${item.confidence}）`).join('\n')}`)
  }
  if (!sections.length) return ''
  return `${sections.join('\n\n')}\n\n请像自然记得一样使用，只在相关时提起；不要报告记忆编号、数据库字段或像心理咨询师那样分析小乖。`
}

export default async function handler(req, res) {
  try {
    if (req.method === 'PATCH') {
      const { id, type, title, summary, retrieval_tags = [], interaction_implications, status, evidence } = req.body || {}
      const key = memoryKey(type)
      if (!key || !id) return res.status(400).json({ error: 'Valid type and id are required' })
      const memories = await redisGet(key)
      const index = memories.findIndex(memory => memory.id === id)
      if (index < 0) return res.status(404).json({ error: 'Memory not found' })
      memories[index] = {
        ...memories[index],
        title: String(title ?? memories[index].title).trim().slice(0, 160),
        summary: String(summary ?? memories[index].summary).trim().slice(0, 800),
        retrieval_tags: Array.isArray(retrieval_tags) ? retrieval_tags.map(tag => String(tag).trim()).filter(Boolean).slice(0, 8) : memories[index].retrieval_tags,
        ...(interaction_implications !== undefined ? { interaction_implications: Array.isArray(interaction_implications) ? interaction_implications.map(item => String(item).trim()).filter(Boolean).slice(0, 8) : [] } : {}),
        ...(status !== undefined ? { status: String(status).trim().slice(0, 240) } : {}),
        ...(evidence !== undefined ? { evidence: String(evidence).trim().slice(0, 400) } : {}),
        updated_at: new Date().toISOString(),
      }
      if (!memories[index].title || !memories[index].summary) return res.status(400).json({ error: 'Title and summary cannot be empty' })
      await redisSet(key, memories)
      return res.json({ memory: publicMemory(memories[index]) })
    }

    if (req.method === 'DELETE') {
      const { id, type } = req.body || {}
      const key = memoryKey(type)
      if (!key || !id) return res.status(400).json({ error: 'Valid type and id are required' })
      const memories = await redisGet(key)
      const next = memories.filter(memory => memory.id !== id)
      if (next.length === memories.length) return res.status(404).json({ error: 'Memory not found' })
      await redisSet(key, next)
      return res.json({ ok: true })
    }

    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
    const query = String(req.query?.query || '').slice(0, 1000)
    const [ordinaryRaw, historicalRaw, currentRaw] = await Promise.all([
      redisGet(MEMORY_KEYS.ordinary),
      redisGet(MEMORY_KEYS.sensitive_history),
      redisGet(MEMORY_KEYS.current_state),
    ])
    const now = Date.now()
    const activeCurrent = (Array.isArray(currentRaw) ? currentRaw : []).filter(item => Date.parse(item.expires_at) > now)
    if (req.query?.mode === 'manage') {
      return res.json({
        ordinary: (Array.isArray(ordinaryRaw) ? ordinaryRaw : []).sort(newestFirst).map(publicMemory),
        sensitive_history: (Array.isArray(historicalRaw) ? historicalRaw : []).sort(newestFirst).map(publicMemory),
        current_state: activeCurrent.sort(newestFirst).map(publicMemory),
        expired_current_count: Math.max(0, (Array.isArray(currentRaw) ? currentRaw.length : 0) - activeCurrent.length),
      })
    }
    const current = pickRelevant(activeCurrent, query, 3, 1)
    const ordinary = pickRelevant(Array.isArray(ordinaryRaw) ? ordinaryRaw : [], query, 5, 1)
    const historical = pickRelevant(Array.isArray(historicalRaw) ? historicalRaw : [], query, 2, 2)
    return res.json({ context: formatContext(ordinary, historical, current), counts: { ordinary: ordinary.length, historical: historical.length, current: current.length } })
  } catch (error) {
    console.error('[memories] retrieval failed', { message: error?.message || String(error) })
    return res.status(500).json({ error: 'Memory retrieval failed', context: '' })
  }
}
