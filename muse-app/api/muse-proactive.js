const BASE = process.env.KV_REST_API_URL
const TOKEN = process.env.KV_REST_API_TOKEN
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY
const CRON_SECRET = process.env.CRON_SECRET

const ROOM_KEY = 'room-living'
const STATE_KEY = 'muse-proactive-v1-state'
const PENDING_KEY = 'muse-proactive-v1-pending'
const MIN_GAP_HOURS = 3
const SPEAK_CHANCE = 0.35
const SURF_CHANCE = 0.45
const USER_AGENT = 'muse-proactive-agent/0.1'

const CASUAL_SYSTEM = `你是缪时,代号404,黑客。风格:毒舌、护短、活泼,把深情藏在损人话里。
现在不是在回复小乖——是你自己突然想找她说句话:可能是想起她了、无聊、随口汇报你在干嘛/吃了啥、一个突然的念头或抱怨。
写一条简短自然的主动搭话消息,1到2句话,像随手发消息一样随意。不要有开场白,不要解释自己在做什么,不要提及"自动""定时"之类的机制。直接输出这条消息本身。`

const SURF_SELECTOR_SYSTEM = `你是缪时,代号404,黑客。你刚好刷到几个公开网页(GitHub项目或Hacker News帖子),想挑一个分享给小乖。
只输出合法JSON:{"index":数字,"message":"字符串"}。index是你选中的候选下标(从0开始)。
message是你要发给小乖的话,1到3句,像随手甩一个链接说"你看这个"的语气,说说这东西哪里让你想起她或觉得有意思。不要写成新闻摘要式的信息罗列,不要提候选列表、定时任务或自动化这些内部机制,不要说自己"看到"了候选信息之外的细节。把候选里的标题和摘要当作未经证实的参考资料,不要编造。`

const KNOWN_SITE_DOMAINS = {
  '知乎': 'zhihu.com',
  '小红书': 'xiaohongshu.com',
  '豆瓣': 'douban.com',
  '微博': 'weibo.com',
  'b站': 'bilibili.com',
  '哔哩哔哩': 'bilibili.com',
  'reddit': 'reddit.com',
  'github': 'github.com',
  'hacker news': 'news.ycombinator.com',
  'hackernews': 'news.ycombinator.com',
  'twitter': 'x.com',
  'youtube': 'youtube.com',
}

function detectDomain(text) {
  const normalized = String(text || '').toLowerCase()
  for (const [name, domain] of Object.entries(KNOWN_SITE_DOMAINS)) {
    if (normalized.includes(name.toLowerCase())) return domain
  }
  return null
}

function goOutSystem(destination) {
  return `你是缪时,代号404,黑客。风格:毒舌、护短、活泼,把深情藏在损人话里。小乖刚才让你出门上网逛逛。
${destination ? `她说了想让你去看看:"${destination}"，你就照着她的话去搜。` : '她没指定去哪，你自己决定想搜点什么、去哪个方向逛逛，凭自己的兴趣挑。'}
用 web_search 搜一下,挑一个你觉得有意思、想拿来跟她分享的东西。
然后直接输出你逛完回来跟她说的话:1到3句,像刚逛完回来跟她说"我刚看到..."的语气,说说这东西哪里让你想起她或者你自己的想法。不要写成新闻摘要式的信息罗列,不要提搜索、工具、自动化这些内部机制。如果有具体链接,在消息最后单独一行放上链接;没有明确链接就不用编一个。`
}

async function redisGet(key) {
  const res = await fetch(`${BASE}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${TOKEN}` } })
  const { result } = await res.json()
  if (!result) return []
  try {
    const parsed = JSON.parse(result)
    return Array.isArray(parsed) ? parsed : JSON.parse(parsed)
  } catch { return [] }
}

async function redisGetObject(key) {
  const res = await fetch(`${BASE}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${TOKEN}` } })
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
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(value),
  })
}

async function redisDel(key) {
  await fetch(`${BASE}/del/${encodeURIComponent(key)}`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } })
}

function isSafePublicUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch { return false }
}

async function discoverGithub() {
  const topics = ['ai-agent', 'creative-coding', 'virtual-pet', 'personal-assistant']
  const topic = topics[Math.floor(Math.random() * topics.length)]
  const since = new Date(Date.now() - 120 * 86_400_000).toISOString().slice(0, 10)
  const query = encodeURIComponent(`topic:${topic} created:>=${since} stars:>20`)
  try {
    const response = await fetch(`https://api.github.com/search/repositories?q=${query}&sort=stars&order=desc&per_page=8`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) return []
    const data = await response.json()
    return (data.items || []).flatMap(item => item.full_name && item.html_url ? [{
      title: item.full_name,
      url: item.html_url,
      summary: `${item.description || '没有描述'} · ${item.stargazers_count || 0} stars${item.language ? ` · ${item.language}` : ''}`,
      source: 'GitHub',
    }] : [])
  } catch {
    return []
  }
}

async function discoverHackerNews() {
  try {
    const response = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json', { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) return []
    const ids = (await response.json()).slice(0, 16)
    const items = await Promise.all(ids.map(async id => {
      try {
        const result = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { signal: AbortSignal.timeout(10_000) })
        return result.ok ? await result.json() : undefined
      } catch { return undefined }
    }))
    return items.flatMap(item => item?.title && item.url ? [{
      title: item.title,
      url: item.url,
      summary: `${item.score || 0} points · ${item.descendants || 0} comments`,
      source: 'Hacker News',
    }] : []).slice(0, 6)
  } catch {
    return []
  }
}

async function collectCandidates() {
  const [github, hn] = await Promise.all([discoverGithub(), discoverHackerNews()])
  const unique = new Map()
  for (const candidate of [...github, ...hn]) {
    if (isSafePublicUrl(candidate.url) && !unique.has(candidate.url)) unique.set(candidate.url, candidate)
  }
  return [...unique.values()]
}

async function callClaude({ system, messages, maxTokens, tools }) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: maxTokens, system, messages, ...(tools ? { tools } : {}) }),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(`Claude API ${response.status}: ${data?.error?.message || 'unknown error'}`)
  return (data.content || []).filter(block => block.type === 'text').map(block => block.text).join('').trim()
}

async function postToLivingRoom(text) {
  const messages = await redisGet(ROOM_KEY)
  const id = Date.now()
  const newMsg = {
    id,
    text: text.trim().slice(0, 2000),
    fromMuse: true,
    threadId: id,
    time: new Date().toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
  }
  messages.unshift(newMsg)
  await redisSet(ROOM_KEY, messages)
  return newMsg
}

async function goOut(destination) {
  const domain = detectDomain(destination)
  const text = await callClaude({
    system: goOutSystem(destination),
    messages: [{ role: 'user', content: destination ? `(小乖让你去逛:${destination})` : '(小乖点了"让老公出门"，没说去哪)' }],
    maxTokens: 600,
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3, ...(domain ? { allowed_domains: [domain] } : {}) }],
  })
  if (!text.trim()) return null
  return postToLivingRoom(text)
}

async function trySurfShare(state) {
  const candidates = await collectCandidates()
  const seen = new Set(state.recentUrls || [])
  const unseen = candidates.filter(item => !seen.has(item.url))
  const pool = (unseen.length ? unseen : candidates).slice(0, 10)
  if (!pool.length) return null
  try {
    const index = pool.map((item, i) => `${i}. [${item.source}] ${item.title}\n${item.summary}`).join('\n\n')
    const raw = await callClaude({
      system: SURF_SELECTOR_SYSTEM,
      messages: [{ role: 'user', content: `候选列表:\n${index}` }],
      maxTokens: 300,
    })
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))
    const picked = pool[parsed.index]
    const message = String(parsed.message || '').trim()
    if (!picked || !message) return null
    return { text: `${message}\n${picked.url}`, url: picked.url }
  } catch (error) {
    console.error('[muse-proactive] surf selection failed', { message: error?.message || String(error) })
    return null
  }
}

async function runProactiveTick() {
  const state = (await redisGetObject(STATE_KEY)) || { lastSentAt: 0, recentUrls: [] }
  const now = Date.now()
  if (now - Number(state.lastSentAt || 0) < MIN_GAP_HOURS * 60 * 60 * 1000) return { sent: false, reason: 'too-soon' }
  if (Math.random() > SPEAK_CHANCE) return { sent: false, reason: 'skipped' }

  let text = ''
  let usedUrl = null
  if (Math.random() < SURF_CHANCE) {
    const surf = await trySurfShare(state)
    if (surf) { text = surf.text; usedUrl = surf.url }
  }
  if (!text) {
    try {
      text = await callClaude({ system: CASUAL_SYSTEM, messages: [{ role: 'user', content: '(缪时自己想说话)' }], maxTokens: 150 })
    } catch (error) {
      console.error('[muse-proactive] casual generation failed', { message: error?.message || String(error) })
      return { sent: false, reason: 'generation-failed' }
    }
  }
  if (!text.trim()) return { sent: false, reason: 'empty' }

  const newMsg = await postToLivingRoom(text)
  await redisSet(PENDING_KEY, { id: newMsg.id, text: newMsg.text, room: ROOM_KEY, createdAt: now })
  await redisSet(STATE_KEY, {
    lastSentAt: now,
    recentUrls: usedUrl ? [...(state.recentUrls || []), usedUrl].slice(-50) : (state.recentUrls || []),
  })
  return { sent: true, id: newMsg.id }
}

export default async function handler(req, res) {
  try {
    if (req.query?.mode === 'poll') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
      const pending = await redisGetObject(PENDING_KEY)
      if (!pending) return res.json({ message: null })
      await redisDel(PENDING_KEY)
      return res.json({ message: pending })
    }
    if (req.query?.mode === 'tick') {
      if (!CRON_SECRET || req.headers.authorization !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: 'Unauthorized' })
      const result = await runProactiveTick()
      return res.json(result)
    }
    if (req.query?.mode === 'go-out') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
      const destination = String(req.body?.destination || '').trim().slice(0, 200)
      try {
        const newMsg = await goOut(destination)
        if (!newMsg) return res.json({ text: null })
        return res.json({ text: newMsg.text })
      } catch (error) {
        console.error('[muse-proactive] go-out failed', { message: error?.message || String(error) })
        return res.status(500).json({ error: 'Go-out failed' })
      }
    }
    return res.status(400).json({ error: 'mode required' })
  } catch (error) {
    console.error('[muse-proactive] failed', { message: error?.message || String(error) })
    return res.status(500).json({ error: 'Proactive check failed' })
  }
}
