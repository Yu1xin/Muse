import { TOPIC_TAXONOMY, matchTopicsInText, inferTopics, buildTopicGraph } from './_topics.js'
import { requireUser } from './_auth.js'
import { supabase } from './_supabase.js'

const MEMORY_TYPES = new Set(['ordinary', 'sensitive_history', 'current_state'])

const MEMORY_ROUTER_SYSTEM = `根据当前消息，从长期记忆索引中选择语义相关的记忆。只输出相关记忆的 id，用英文逗号分隔；没有明确相关项就输出 NONE。最多选择4项，不要解释。不要因为同属一个宽泛topic就选择不相关内容。`

const DEDUPE_SCAN_SYSTEM = `你是记忆去重助手。下面是缪时长期记忆的完整索引（id|title|summary）。找出其中语义重复或高度相似、实际上在说同一件事/同一个持续偏好/同一个反复出现情况的条目，把它们分成组。
只输出合法JSON：{"groups":[{"ids":["id1","id2"],"merged_title":"...","merged_summary":"...","merged_tags":["..."]}]}。
每组至少2个id。merged_title和merged_summary要把这些重复条目里的信息合并、去重、保留最新最具体的说法，不要丢失细节。merged_tags最多6个。
如果两条记忆主题接近但其实是不同的具体事件（比如都关于工作但是两次不同的求职经历），不要合并。宁可少合并，不要把不同的事情硬凑到一起。没有重复就输出{"groups":[]}，不要解释。`

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

function chunkArray(array, size) {
  const chunks = []
  for (let index = 0; index < array.length; index += size) chunks.push(array.slice(index, index + size))
  return chunks
}

async function scanDuplicatesChunk(memories) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      system: DEDUPE_SCAN_SYSTEM,
      messages: [{
        role: 'user',
        content: `记忆索引：\n${memories.map(item => `${item.id}|${item.title}|${item.summary}`).join('\n')}`,
      }],
    }),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(`API ${response.status}`)
  if (data.stop_reason === 'max_tokens') throw new Error('dedupe scan hit token limit; refusing partial JSON')
  const text = (data.content || []).filter(block => block.type === 'text').map(block => block.text).join('')
  const parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))
  const validIds = new Set(memories.map(item => String(item.id)))
  return (Array.isArray(parsed.groups) ? parsed.groups : [])
    .map(group => ({
      ids: Array.isArray(group.ids) ? group.ids.map(String).filter(id => validIds.has(id)) : [],
      merged_title: String(group.merged_title || '').trim().slice(0, 160),
      merged_summary: String(group.merged_summary || '').trim().slice(0, 800),
      merged_tags: Array.isArray(group.merged_tags) ? group.merged_tags.map(tag => String(tag).trim()).filter(Boolean).slice(0, 6) : [],
    }))
    .filter(group => group.ids.length >= 2 && group.merged_title && group.merged_summary)
}

async function scanDuplicates(memories) {
  if (memories.length < 2) return []
  const groups = []
  for (const chunk of chunkArray(memories, 40)) {
    if (chunk.length < 2) continue
    try {
      groups.push(...await scanDuplicatesChunk(chunk))
    } catch (error) {
      console.error('[memory-dedupe-scan] chunk failed', { message: error?.message || String(error) })
    }
  }
  return groups
}

async function fetchMemoriesByType(type) {
  const { data, error } = await supabase.from('memories').select('*').eq('type', type)
  if (error) throw new Error(`memories read failed (${type}): ${error.message}`)
  return data || []
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
    if (!await requireUser(req)) return res.status(401).json({ error: 'Unauthorized' })
    if (req.method === 'PATCH') {
      const { id, type, title, summary, retrieval_tags = [], interaction_implications, status, evidence } = req.body || {}
      if (!MEMORY_TYPES.has(type) || !id) return res.status(400).json({ error: 'Valid type and id are required' })
      const { data: existing, error: fetchError } = await supabase.from('memories').select('*').eq('id', id).eq('type', type).maybeSingle()
      if (fetchError) throw new Error(`memories read failed: ${fetchError.message}`)
      if (!existing) return res.status(404).json({ error: 'Memory not found' })
      const patch = {
        title: String(title ?? existing.title).trim().slice(0, 160),
        summary: String(summary ?? existing.summary).trim().slice(0, 800),
        retrieval_tags: Array.isArray(retrieval_tags) ? retrieval_tags.map(tag => String(tag).trim()).filter(Boolean).slice(0, 8) : existing.retrieval_tags,
        ...(interaction_implications !== undefined ? { interaction_implications: Array.isArray(interaction_implications) ? interaction_implications.map(item => String(item).trim()).filter(Boolean).slice(0, 8) : [] } : {}),
        ...(status !== undefined ? { status: String(status).trim().slice(0, 240) } : {}),
        ...(evidence !== undefined ? { evidence: String(evidence).trim().slice(0, 400) } : {}),
        updated_at: new Date().toISOString(),
      }
      if (!patch.title || !patch.summary) return res.status(400).json({ error: 'Title and summary cannot be empty' })
      const { data: updated, error: updateError } = await supabase.from('memories').update(patch).eq('id', id).eq('type', type).select().single()
      if (updateError) throw new Error(`memories update failed: ${updateError.message}`)
      return res.json({ memory: publicMemory(updated) })
    }

    if (req.method === 'DELETE') {
      const { id, type } = req.body || {}
      if (!MEMORY_TYPES.has(type) || !id) return res.status(400).json({ error: 'Valid type and id are required' })
      const { data: deleted, error } = await supabase.from('memories').delete().eq('id', id).eq('type', type).select()
      if (error) throw new Error(`memories delete failed: ${error.message}`)
      if (!deleted?.length) return res.status(404).json({ error: 'Memory not found' })
      return res.json({ ok: true })
    }

    if (req.method === 'POST' && req.query?.action === 'merge-duplicates') {
      const { type, ids, title, summary, retrieval_tags = [] } = req.body || {}
      if (!MEMORY_TYPES.has(type) || !Array.isArray(ids) || ids.length < 2) return res.status(400).json({ error: 'type and at least 2 ids are required' })
      const cleanTitle = String(title || '').trim().slice(0, 160)
      const cleanSummary = String(summary || '').trim().slice(0, 800)
      if (!cleanTitle || !cleanSummary) return res.status(400).json({ error: 'Title and summary cannot be empty' })
      const [keepId, ...removeIds] = ids.map(String)
      const { data: updated, error: updateError } = await supabase.from('memories').update({
        title: cleanTitle,
        summary: cleanSummary,
        retrieval_tags: Array.isArray(retrieval_tags) ? retrieval_tags.map(tag => String(tag).trim()).filter(Boolean).slice(0, 8) : undefined,
        updated_at: new Date().toISOString(),
      }).eq('id', keepId).eq('type', type).select().single()
      if (updateError) throw new Error(`memories merge update failed: ${updateError.message}`)
      if (!updated) return res.status(404).json({ error: 'Memory not found' })
      if (removeIds.length) {
        const { error: deleteError } = await supabase.from('memories').delete().eq('type', type).in('id', removeIds)
        if (deleteError) throw new Error(`memories merge cleanup failed: ${deleteError.message}`)
      }
      return res.json({ memory: publicMemory(updated) })
    }

    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
    const query = String(req.query?.query || '').slice(0, 1000)
    const [allOrdinary, allHistorical, allCurrent] = await Promise.all([
      fetchMemoriesByType('ordinary'),
      fetchMemoriesByType('sensitive_history'),
      fetchMemoriesByType('current_state'),
    ])
    const now = Date.now()
    const activeCurrent = allCurrent.filter(item => Date.parse(item.expires_at) > now)
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
        expired_current_count: Math.max(0, allCurrent.length - activeCurrent.length),
      })
    }
    if (req.query?.mode === 'dedupe-scan') {
      const type = req.query?.type === 'sensitive_history' ? 'sensitive_history' : 'ordinary'
      const pool = type === 'sensitive_history' ? allHistorical : allOrdinary
      const groups = await scanDuplicates(pool.map(publicMemory))
      return res.json({ type, groups })
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
