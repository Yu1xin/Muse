import { TOPIC_TAXONOMY, matchTopicsInText, inferTopics, buildTopicGraph } from './_topics.js'

const BASE = process.env.KV_REST_API_URL
const TOKEN = process.env.KV_REST_API_TOKEN

const MEMORY_KEYS = {
  ordinary: 'memory-v1-ordinary',
  sensitive_history: 'memory-v1-sensitive-history',
  current_state: 'memory-v1-current-state',
}

const MEMORY_ROUTER_SYSTEM = `根据当前消息，从长期记忆索引中选择语义相关的记忆。只输出相关记忆的 id，用英文逗号分隔；没有明确相关项就输出 NONE。最多选择4项，不要解释。不要因为同属一个宽泛topic就选择不相关内容。`

function normalizedText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '')
}

async function semanticMemoryRoute(query, memories) {
  if (!String(query || '').trim() || !memories.length) return []
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 160,
        system: MEMORY_ROUTER_SYSTEM,
        messages: [{
          role: 'user',
          content: `当前消息：${String(query).slice(0, 500)}\n\n记忆索引（id|topics|title|tags）：\n${memories.map(item => `${item.id}|${inferTopics(item).join('、')}|${item.title}|${(item.retrieval_tags || []).join('、')}`).join('\n')}`,
        }],
      }),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(`API ${response.status}`)
    const text = (data.content || []).filter(block => block.type === 'text').map(block => block.text).join('')
    const validIds = new Set(memories.map(item => String(item.id)))
    return text.split(',').map(item => item.trim()).filter(id => validIds.has(id)).slice(0, 4)
  } catch (error) {
    console.error('[memory-semantic-router] failed', { message: error?.message || String(error) })
    return []
  }
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
    topics: inferTopics(memory),
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

function combinedScore(memory, queryTerms, triggeredTopics, semanticIds) {
  const textScore = relevance(memory, queryTerms)
  const topicHit = inferTopics(memory).some(topic => triggeredTopics.includes(topic))
  const semanticHit = semanticIds.includes(String(memory.id))
  return textScore * 2 + (topicHit ? 3 : 0) + (semanticHit ? 4 : 0)
}

function pickLit(pool, query, triggeredTopics, semanticIds, limit = 3) {
  const queryTerms = terms(query)
  return pool
    .map(memory => ({ memory, score: combinedScore(memory, queryTerms, triggeredTopics, semanticIds) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || newestFirst(a.memory, b.memory))
    .slice(0, limit)
    .map(item => item.memory)
}

function formatContext(ordinary, historical, current) {
  const sections = []
  if (ordinary.length) {
    sections.push(`【相关的普通长期记忆】\n${ordinary.map(item => `- [${inferTopics(item).join('／')}] ${item.summary}`).join('\n')}`)
  }
  if (historical.length) {
    sections.push(`【相关的历史敏感记忆——HISTORICAL，不是当前正在发生】\n这些内容只是过去背景，不要从中推断小乖当前处于同样状态，也不要强迫她详细回忆或用它解释她的一切。\n${historical.map(item => `- [${inferTopics(item).join('／')}／${item.occurred_at || '时间不详'}] ${item.summary}${item.interaction_implications?.length ? `；互动提醒：${item.interaction_implications.join('；')}` : ''}`).join('\n')}`)
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
    const allOrdinary = Array.isArray(ordinaryRaw) ? ordinaryRaw : []
    const allHistorical = Array.isArray(historicalRaw) ? historicalRaw : []
    if (req.query?.mode === 'manage') {
      return res.json({
        taxonomy: Object.entries(TOPIC_TAXONOMY).map(([name, def]) => ({
          name,
          keywords: def.keywords,
          children: Object.entries(def.children || {}).map(([childName, child]) => ({ name: childName, keywords: child.keywords })),
        })),
        graph: buildTopicGraph([...allOrdinary, ...allHistorical]),
        ordinary: [...allOrdinary].sort(newestFirst).map(publicMemory),
        sensitive_history: [...allHistorical].sort(newestFirst).map(publicMemory),
        current_state: activeCurrent.sort(newestFirst).map(publicMemory),
        expired_current_count: Math.max(0, (Array.isArray(currentRaw) ? currentRaw.length : 0) - activeCurrent.length),
      })
    }
    const current = pickRelevant(activeCurrent, query, 3, 1)
    const queryText = normalizedText(query)
    const triggeredTopics = matchTopicsInText(queryText)
    const semanticIds = triggeredTopics.length ? [] : await semanticMemoryRoute(query, [...allOrdinary, ...allHistorical])
    const directOrdinary = pickRelevant(allOrdinary, query, 3, 2)
    const directHistorical = pickRelevant(allHistorical, query, 1, 2)
    const topicOrdinary = triggeredTopics.length
      ? allOrdinary.filter(item => inferTopics(item).some(topic => triggeredTopics.includes(topic))).sort(newestFirst).slice(0, 5)
      : []
    const topicHistorical = triggeredTopics.length
      ? allHistorical.filter(item => inferTopics(item).some(topic => triggeredTopics.includes(topic))).sort(newestFirst).slice(0, 2)
      : []
    const semanticOrdinary = allOrdinary.filter(item => semanticIds.includes(String(item.id)))
    const semanticHistorical = allHistorical.filter(item => semanticIds.includes(String(item.id)))
    const dedupe = items => [...new Map(items.map(item => [item.id || item.dedupe_key, item])).values()]
    const ordinary = dedupe([...directOrdinary, ...topicOrdinary, ...semanticOrdinary]).slice(0, 6)
    const historical = dedupe([...directHistorical, ...topicHistorical, ...semanticHistorical]).slice(0, 2)
    const lit = pickLit(dedupe([...ordinary, ...historical]), query, triggeredTopics, semanticIds, 3)
    return res.json({
      context: formatContext(ordinary, historical, current),
      counts: { ordinary: ordinary.length, historical: historical.length, current: current.length },
      lit_ids: lit.map(item => item.id),
      lit_memories: lit.map(publicMemory),
      lit_topics: [...new Set(lit.flatMap(item => inferTopics(item)))],
    })
  } catch (error) {
    console.error('[memories] retrieval failed', { message: error?.message || String(error) })
    return res.status(500).json({ error: 'Memory retrieval failed', context: '' })
  }
}
