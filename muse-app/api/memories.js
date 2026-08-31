const BASE = process.env.KV_REST_API_URL
const TOKEN = process.env.KV_REST_API_TOKEN

const MEMORY_KEYS = {
  ordinary: 'memory-v1-ordinary',
  sensitive_history: 'memory-v1-sensitive-history',
  current_state: 'memory-v1-current-state',
}

const MEMORY_FOLDERS = {
  '高中': ['高中', '中学', '高中同学', '老师', '校园', '班级', '考试', '高考', '青春期', 'Tony', '社团', '暗恋', '毕业', '校服', '高中朋友'],
  'UNC': ['UNC', '北卡', '教堂山', '北卡森林', '大学', '留学', '美国大学', '课程', '教授', '卫生间', '宿舍', '图书馆', '本科', '大学同学', '校园生活'],
  '纽约': ['纽约', 'New York', 'Manhattan', 'Queens', '曼哈顿', '皇后区', '纽约地铁', '纽约旅行', '第二次纽约', '美国东岸', 'Central Park', '中央公园', '时代广场', '布鲁克林', 'NYC'],
  '国内': ['国内', '中国', '回国', '家里', '父母', '妈妈', '爸爸', '亲戚', '家乡', '微信', '城管', '公园摆摊', '超市', '城市', '国内生活'],
  '日常': ['日常', '吃饭', '睡觉', '咖啡', '散步', '超市', '做饭', '天气', '游戏', '电影', '衣服', '家', '卧室', '客厅', '缪时'],
  '学习和工作': ['学习', '工作', '实习', '求职', '找工作', 'networking', 'LinkedIn', 'mentor', 'career coach', 'Molly', '作业', '项目', '面试', '公司', '效率'],
}

const MEMORY_ROUTER_SYSTEM = `根据当前消息，从长期记忆索引中选择语义相关的记忆。只输出相关记忆的 id，用英文逗号分隔；没有明确相关项就输出 NONE。最多选择4项，不要解释。不要因为同属一个宽泛文件夹就选择不相关内容。`

function normalizedText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '')
}

function inferFolder(memory) {
  if (MEMORY_FOLDERS[memory.folder]) return memory.folder
  const haystack = normalizedText([memory.title, memory.summary, ...(memory.retrieval_tags || [])].join(' '))
  let best = '日常'
  let bestScore = 0
  for (const [folder, keywords] of Object.entries(MEMORY_FOLDERS)) {
    const score = keywords.reduce((sum, keyword) => sum + (haystack.includes(normalizedText(keyword)) ? 1 : 0), 0)
    if (score > bestScore) { best = folder; bestScore = score }
  }
  return best
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
          content: `当前消息：${String(query).slice(0, 500)}\n\n记忆索引（id|folder|title|tags）：\n${memories.map(item => `${item.id}|${inferFolder(item)}|${item.title}|${(item.retrieval_tags || []).join('、')}`).join('\n')}`,
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
    folder: inferFolder(memory),
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
    sections.push(`【相关的普通长期记忆】\n${ordinary.map(item => `- [${inferFolder(item)}] ${item.summary}`).join('\n')}`)
  }
  if (historical.length) {
    sections.push(`【相关的历史敏感记忆——HISTORICAL，不是当前正在发生】\n这些内容只是过去背景，不要从中推断小乖当前处于同样状态，也不要强迫她详细回忆或用它解释她的一切。\n${historical.map(item => `- [${inferFolder(item)}／${item.occurred_at || '时间不详'}] ${item.summary}${item.interaction_implications?.length ? `；互动提醒：${item.interaction_implications.join('；')}` : ''}`).join('\n')}`)
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
        folders: Object.entries(MEMORY_FOLDERS).map(([name, keywords]) => ({ name, keywords })),
        ordinary: (Array.isArray(ordinaryRaw) ? ordinaryRaw : []).sort(newestFirst).map(publicMemory),
        sensitive_history: (Array.isArray(historicalRaw) ? historicalRaw : []).sort(newestFirst).map(publicMemory),
        current_state: activeCurrent.sort(newestFirst).map(publicMemory),
        expired_current_count: Math.max(0, (Array.isArray(currentRaw) ? currentRaw.length : 0) - activeCurrent.length),
      })
    }
    const current = pickRelevant(activeCurrent, query, 3, 1)
    const allOrdinary = Array.isArray(ordinaryRaw) ? ordinaryRaw : []
    const allHistorical = Array.isArray(historicalRaw) ? historicalRaw : []
    const queryText = normalizedText(query)
    const triggeredFolders = Object.entries(MEMORY_FOLDERS)
      .filter(([, keywords]) => keywords.some(keyword => queryText.includes(normalizedText(keyword))))
      .map(([name]) => name)
    const semanticIds = triggeredFolders.length ? [] : await semanticMemoryRoute(query, [...allOrdinary, ...allHistorical])
    const directOrdinary = pickRelevant(allOrdinary, query, 3, 2)
    const directHistorical = pickRelevant(allHistorical, query, 1, 2)
    const folderOrdinary = triggeredFolders.length
      ? allOrdinary.filter(item => triggeredFolders.includes(inferFolder(item))).sort(newestFirst).slice(0, 5)
      : []
    const folderHistorical = triggeredFolders.length
      ? allHistorical.filter(item => triggeredFolders.includes(inferFolder(item))).sort(newestFirst).slice(0, 2)
      : []
    const semanticOrdinary = allOrdinary.filter(item => semanticIds.includes(String(item.id)))
    const semanticHistorical = allHistorical.filter(item => semanticIds.includes(String(item.id)))
    const dedupe = items => [...new Map(items.map(item => [item.id || item.dedupe_key, item])).values()]
    const ordinary = dedupe([...directOrdinary, ...folderOrdinary, ...semanticOrdinary]).slice(0, 6)
    const historical = dedupe([...directHistorical, ...folderHistorical, ...semanticHistorical]).slice(0, 2)
    return res.json({ context: formatContext(ordinary, historical, current), counts: { ordinary: ordinary.length, historical: historical.length, current: current.length } })
  } catch (error) {
    console.error('[memories] retrieval failed', { message: error?.message || String(error) })
    return res.status(500).json({ error: 'Memory retrieval failed', context: '' })
  }
}
