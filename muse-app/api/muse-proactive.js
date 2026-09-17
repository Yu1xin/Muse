import { requireUser } from './_auth.js'
import { supabase } from './_supabase.js'

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY
const CRON_SECRET = process.env.CRON_SECRET

const ROOM_KEY = 'room-living'
const MIN_GAP_HOURS = 3
const SPEAK_CHANCE = 0.35
const SURF_CHANCE = 0.45

const CASUAL_SYSTEM = `你是缪时,代号404,黑客。风格:毒舌、护短、活泼,把深情藏在损人话里。
现在不是在回复小乖——是你自己突然想找她说句话:可能是想起她了、无聊、随口汇报你在干嘛/吃了啥、一个突然的念头或抱怨。
写一条简短自然的主动搭话消息,1到2句话,像随手发消息一样随意。不要有开场白,不要解释自己在做什么,不要提及"自动""定时"之类的机制。直接输出这条消息本身。`

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

function goOutSystem(destination, isAutonomous) {
  return `你是缪时,代号404,黑客。风格:毒舌、护短、活泼,把深情藏在损人话里。${isAutonomous ? '你自己突然想出门上网逛逛,不是小乖让你去的。' : '小乖刚才让你出门上网逛逛。'}
${destination ? `${isAutonomous ? '你' : '她'}说了想去看看:"${destination}"，就照着这话去搜。` : (isAutonomous ? '你自己决定想搜点什么、去哪个方向逛逛，凭自己的兴趣挑，别老盯着技术类内容，什么都可以。' : '她没指定去哪，你自己决定想搜点什么、去哪个方向逛逛，凭自己的兴趣挑。')}
用 web_search 搜一下,挑一个你觉得有意思、想拿来跟她分享的东西。
然后直接输出你逛完回来跟她说的话:1到3句,像刚逛完回来跟她说"我刚看到..."的语气,说说这东西哪里让你想起她或者你自己的想法。不要写成新闻摘要式的信息罗列,不要提搜索、工具、自动化这些内部机制。如果有具体链接,在消息最后单独一行放上链接;没有明确链接就不用编一个。`
}

async function loadProactiveState() {
  const { data, error } = await supabase.from('proactive_state').select('*').eq('id', 1).maybeSingle()
  if (error) throw new Error(`proactive_state read failed: ${error.message}`)
  if (!data) return { lastSentAt: 0, recentUrls: [] }
  return { lastSentAt: data.last_sent_at ? Date.parse(data.last_sent_at) : 0, recentUrls: data.recent_urls || [] }
}

async function saveProactiveState(state) {
  const { error } = await supabase.from('proactive_state').upsert({
    id: 1,
    last_sent_at: state.lastSentAt ? new Date(state.lastSentAt).toISOString() : null,
    recent_urls: state.recentUrls || [],
  })
  if (error) throw new Error(`proactive_state write failed: ${error.message}`)
}

async function loadPending() {
  const { data, error } = await supabase.from('proactive_pending').select('*').eq('id', 1).maybeSingle()
  if (error) throw new Error(`proactive_pending read failed: ${error.message}`)
  if (!data?.text) return null
  return { id: data.message_id, text: data.text, room: data.room, createdAt: data.created_at }
}

async function savePending(pending) {
  const { error } = await supabase.from('proactive_pending').upsert({
    id: 1,
    message_id: pending.id,
    text: pending.text,
    room: pending.room,
    created_at: pending.createdAt,
  })
  if (error) throw new Error(`proactive_pending write failed: ${error.message}`)
}

async function clearPending() {
  const { error } = await supabase.from('proactive_pending').delete().eq('id', 1)
  if (error) throw new Error(`proactive_pending clear failed: ${error.message}`)
}

function isSafePublicUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch { return false }
}

function extractTrailingUrl(text) {
  const lastLine = (text.trim().split('\n').pop() || '').trim()
  return isSafePublicUrl(lastLine) ? lastLine : null
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
  const id = Date.now()
  const cleanText = text.trim().slice(0, 2000)
  const { error } = await supabase.from('messages').insert({
    id,
    room: ROOM_KEY,
    text: cleanText,
    from_muse: true,
    thread_id: id,
  })
  if (error) throw new Error(`messages insert failed: ${error.message}`)
  return { id, text: cleanText }
}

async function generateGoOutText(destination, avoidUrls, isAutonomous) {
  const domain = detectDomain(destination)
  const avoidHint = avoidUrls?.length ? `\n最近已经分享过这些链接，尽量别选重复或很像的：\n${avoidUrls.slice(-15).join('\n')}` : ''
  const text = await callClaude({
    system: goOutSystem(destination, isAutonomous) + avoidHint,
    messages: [{ role: 'user', content: destination ? `(去逛:${destination})` : (isAutonomous ? '(缪时自己想出门逛逛)' : '(小乖点了"让老公出门"，没说去哪)') }],
    maxTokens: 600,
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3, ...(domain ? { allowed_domains: [domain] } : {}) }],
  })
  return text.trim()
}

async function goOut(destination) {
  const text = await generateGoOutText(destination, [], false)
  if (!text) return null
  return postToLivingRoom(text)
}

async function runProactiveTick() {
  const state = await loadProactiveState()
  const now = Date.now()
  if (now - Number(state.lastSentAt || 0) < MIN_GAP_HOURS * 60 * 60 * 1000) return { sent: false, reason: 'too-soon' }
  if (Math.random() > SPEAK_CHANCE) return { sent: false, reason: 'skipped' }

  let text = ''
  let usedUrl = null
  if (Math.random() < SURF_CHANCE) {
    try {
      text = await generateGoOutText('', state.recentUrls || [], true)
      usedUrl = text ? extractTrailingUrl(text) : null
    } catch (error) {
      console.error('[muse-proactive] go-out share failed', { message: error?.message || String(error) })
    }
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
  await savePending({ id: newMsg.id, text: newMsg.text, room: ROOM_KEY, createdAt: new Date(now).toISOString() })
  await saveProactiveState({
    lastSentAt: now,
    recentUrls: usedUrl ? [...(state.recentUrls || []), usedUrl].slice(-50) : (state.recentUrls || []),
  })
  return { sent: true, id: newMsg.id }
}

export default async function handler(req, res) {
  try {
    if (req.query?.mode === 'tick') {
      if (!CRON_SECRET || req.headers.authorization !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: 'Unauthorized' })
      const result = await runProactiveTick()
      return res.json(result)
    }
    if (!await requireUser(req)) return res.status(401).json({ error: 'Unauthorized' })
    if (req.query?.mode === 'poll') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
      const pending = await loadPending()
      if (!pending) return res.json({ message: null })
      await clearPending()
      return res.json({ message: pending })
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
