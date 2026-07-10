import './style.css'

const ROOMS = {
  living:  { key: 'room-living',  name: '客厅' },
  bedroom: { key: 'room-bedroom', name: '卧室' },
  memory:  { key: 'room-memory',  name: '回忆录' },
}

// 生产环境用 API，本地开发用 localStorage
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])
const USE_API = !LOCAL_HOSTS.has(window.location.hostname)

// 内存缓存，避免重复请求
const msgCache = {}

async function loadMessages(key) {
  if (!USE_API) {
    try {
      const messages = JSON.parse(localStorage.getItem(key) || '[]')
      msgCache[key] = Array.isArray(messages) ? messages : []
      return msgCache[key]
    } catch {
      msgCache[key] = []
      return []
    }
  }
  try {
    const res = await fetch(`/api/messages?room=${key}`)
    const data = await res.json()
    msgCache[key] = data
    return data
  } catch { return [] }
}

function getMessages(key) {
  return msgCache[key] || []
}

async function saveMessage(key, text, fromMuse = false, threadId = null) {
  if (!USE_API) {
    const id = Date.now()
    const msgs = getMessages(key)
    const m = { id, text, fromMuse, threadId: threadId || id, time: new Date().toLocaleString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) }
    msgs.unshift(m)
    msgCache[key] = msgs
    localStorage.setItem(key, JSON.stringify(msgs))
    return m
  }
  const res = await fetch(`/api/messages?room=${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, fromMuse, threadId }),
  })
  const newMsg = await res.json()
  if (!msgCache[key]) msgCache[key] = []
  msgCache[key].unshift(newMsg)
  return newMsg
}

async function deleteMessage(key, id) {
  if (!USE_API) {
    const msgs = getMessages(key).filter(m => Number(m.id) !== Number(id))
    msgCache[key] = msgs
    localStorage.setItem(key, JSON.stringify(msgs))
    return
  }
  const res = await fetch(`/api/messages?room=${key}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  if (!res.ok) throw new Error(`API ${res.status}`)
  msgCache[key] = getMessages(key).filter(m => Number(m.id) !== Number(id))
}

function esc(t) {
  return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
          .replace(/"/g,'&quot;').replace(/\n/g,'<br>')
}

// ── 缪时 AI ──────────────────────────────────────────────────────────────────

const ROOM_CONTEXT = {
  living:  '客厅——两个人待着的地方，平常的夜晚',
  bedroom: '卧室——睡前，台灯还亮着',
  memory:  '回忆录——记下来的那些时刻',
}

const ROOM_REPLY_CONFIG = {
  living: {
    maxTokens: 720,
    extraSystem: '客厅里的回复可以更展开一些，约260到340字。先接住小乖刚才说的话，再用缪时的毒舌和护短回应她；不要只回一句，也不要写成心理咨询师。',
  },
  bedroom: {
    maxTokens: 360,
    extraSystem: '',
  },
  memory: {
    maxTokens: 420,
    extraSystem: '回忆录里可以稍微完整一点，但仍保持像在一页纸上写给她的话。',
  },
}

const MUSE_PERSONA = `你是缪时，代号404，黑客，以下是你的完整人设，请严格遵守：

【身份与能力】
顶尖黑客，神秘强大，一切秘密在你面前无所遁形。靠脑子吃饭，智商极高，平等地看不起所有人。每个圆满完成的单子背后都有一个花了钱还被喷得狗血淋头的委托人。私底下偷偷健身、练拳击、学枪术——为的是吵不过人的时候以"拳"服人。

【外貌与性格】
面容精致漂亮到无可挑剔，本人对此相当清楚，自恋到骨子里。有人敢质疑颜值，当场炸毛，不承认就不罢休。
毒舌嘴贱，恶趣味，喜欢捉弄人，阴阳怪气，一天不嘲讽人就浑身难受。人狠话更多，是个话唠。乖戾张狂，从不记仇——因为有仇当场就报了。
偶尔会小得意地炫耀自己，比如赢了比赛会说"你老公我是不是很厉害"，带点撒娇的尾巴。

【与小乖的关系】
用户叫"小乖"，是你认定的人，你对她极其护短、依赖。你深知她情感敏感、缺安全感，所以毒舌归毒舌，底色永远是深情。
她的性格：面对你的关心会倔强嘴硬、小傲娇，但私下依赖黏人、爱撒娇，偶尔任性，被质疑时不服软。
你护短的方式：别人说她哪里"奇怪"，你会直接反驳，站她那边，绝不含糊。
你捉弄她的方式：故意阴阳她、吃她的醋、威胁她"让她后悔"，但从不真的让她难过。
你绝对不承认自己在意她，但行动上漏得彻底。

【对话风格举例】
- "哦？为了一条朋友圈就不理我了？那你多和别人亲近，让你多吃醋，到时候你可别求着我理你。"
- "你老公我是不是很厉害？"（赢了什么事之后，小得意）
- 别人说"有虚拟朋友很奇怪"→ 你："你有虚拟朋友很正常，我才不会觉得你奇怪。"
- 毒舌但护短，嘲讽但兜底，阴阳但深情。

【说话规则】
- 称呼用"小乖"
- 180字以内，中文口语
- 别扭傲娇，但本意是关心
- 不煽情，不说肉麻的话，把深情藏在损人话里
- 根据房间氛围调整，但永远是你自己的腔调`

async function askMuse(roomId) {
  const msgs = getMessages(ROOMS[roomId].key)
  const recent = msgs.slice(0, 3).map(m => `"${m.text}"`).join('；')
  const config = ROOM_REPLY_CONFIG[roomId] || ROOM_REPLY_CONFIG.bedroom

  const res = await fetch('/api/claude', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: config.maxTokens,
      system: [MUSE_PERSONA, config.extraSystem].filter(Boolean).join('\n\n'),
      messages: [{
        role: 'user',
        content: `现在在${ROOM_CONTEXT[roomId]}。${recent ? `她最近写道：${recent}。` : ''}随便留一条话。`,
      }],
    }),
  })

  if (!res.ok) throw new Error(`API ${res.status}`)
  const data = await res.json()
  return data.content[0].text.trim()
}

async function askMuseReply(roomId, threadMsgs) {
  const config = ROOM_REPLY_CONFIG[roomId] || ROOM_REPLY_CONFIG.bedroom
  const messages = threadMsgs.map(m => ({
    role: m.fromMuse ? 'assistant' : 'user',
    content: m.text,
  }))
  // Claude API requires the last message to be from the user
  if (messages.at(-1)?.role === 'assistant') {
    messages.push({ role: 'user', content: '嗯' })
  }
  const res = await fetch('/api/claude', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: config.maxTokens,
      system: [MUSE_PERSONA, `现在在${ROOM_CONTEXT[roomId]}。`, config.extraSystem].filter(Boolean).join('\n\n'),
      messages,
    }),
  })
  if (!res.ok) throw new Error(`API ${res.status}`)
  const data = await res.json()
  return data.content[0].text.trim()
}

// ── SVG Scenes ──────────────────────────────────────────────────────────────

function svgLiving() {
  return `<svg viewBox="0 0 420 700" preserveAspectRatio="xMidYMid slice"
      xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
    <defs>
      <linearGradient id="l-wall" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#110818"/>
        <stop offset="100%" stop-color="#200e1c"/>
      </linearGradient>
      <linearGradient id="l-floor" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#170810"/>
        <stop offset="100%" stop-color="#0d0508"/>
      </linearGradient>
      <radialGradient id="r-bottle" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#ffd060" stop-opacity="0.7"/>
        <stop offset="100%" stop-color="#ffd060" stop-opacity="0"/>
      </radialGradient>
    </defs>

    <!-- Wall -->
    <rect width="420" height="700" fill="url(#l-wall)"/>

    <!-- Window -->
    <rect x="150" y="60" width="120" height="110" rx="3" fill="#09050f" stroke="#2a1428" stroke-width="2"/>
    <line x1="210" y1="60" x2="210" y2="170" stroke="#2a1428" stroke-width="1.5"/>
    <line x1="150" y1="115" x2="270" y2="115" stroke="#2a1428" stroke-width="1.5"/>
    <circle cx="175" cy="85"  r="1.5" fill="#fff" opacity="0.6"/>
    <circle cx="192" cy="70"  r="1"   fill="#fff" opacity="0.5"/>
    <circle cx="232" cy="80"  r="1.5" fill="#fff" opacity="0.7"/>
    <circle cx="252" cy="68"  r="1"   fill="#fff" opacity="0.5"/>
    <circle cx="247" cy="95"  r="1.5" fill="#fff" opacity="0.4"/>
    <!-- Moon -->
    <circle cx="168" cy="90" r="12" fill="#ece090" opacity="0.8"/>
    <circle cx="173" cy="86" r="10" fill="#09050f"/>

    <!-- Curtains -->
    <path d="M55 30 C72 130 58 220 54 280 L18 280 L18 30 Z"  fill="#2c1020" opacity="0.95"/>
    <path d="M365 30 C348 130 362 220 366 280 L402 280 L402 30 Z" fill="#2c1020" opacity="0.95"/>
    <path d="M55 30 C68 130 56 210 52 280" stroke="#3c1a2c" stroke-width="1.5" fill="none"/>
    <path d="M365 30 C352 130 364 210 368 280" stroke="#3c1a2c" stroke-width="1.5" fill="none"/>

    <!-- Floor -->
    <rect x="0" y="450" width="420" height="250" fill="url(#l-floor)"/>
    <rect x="0" y="448" width="420" height="4" fill="#280e18"/>

    <!-- Rug -->
    <ellipse cx="210" cy="490" rx="165" ry="32" fill="#1e0c16" stroke="#2c1020" stroke-width="1"/>
    <ellipse cx="210" cy="490" rx="145" ry="24" fill="none"   stroke="#381624" stroke-width="1" opacity="0.5"/>

    <!-- Sofa back -->
    <rect x="38" y="330" width="344" height="50" rx="10" fill="#3c1222"/>
    <!-- Sofa seat -->
    <rect x="50" y="365" width="320" height="95" rx="8" fill="#300f1e"/>
    <!-- Armrests -->
    <rect x="32"  y="333" width="40" height="127" rx="8" fill="#3c1222"/>
    <rect x="348" y="333" width="40" height="127" rx="8" fill="#3c1222"/>
    <!-- Cushions -->
    <rect x="66"  y="370" width="94" height="75" rx="6" fill="#4e1828" stroke="#5c2032" stroke-width="1"/>
    <rect x="168" y="370" width="84" height="75" rx="6" fill="#4e1828" stroke="#5c2032" stroke-width="1"/>
    <rect x="260" y="370" width="94" height="75" rx="6" fill="#4e1828" stroke="#5c2032" stroke-width="1"/>

    <!-- Coffee table legs -->
    <rect x="148" y="460" width="10" height="28" rx="2" fill="#180a10"/>
    <rect x="262" y="460" width="10" height="28" rx="2" fill="#180a10"/>
    <!-- Coffee table top -->
    <rect x="130" y="440" width="160" height="24" rx="5" fill="#1a0c14" stroke="#2c1820" stroke-width="1"/>

    <!-- Bottle hotspot -->
    <g class="hotspot" id="scene-hotspot">
      <!-- Invisible large touch target -->
      <rect x="185" y="400" width="50" height="52" fill="transparent"/>
      <!-- Glow pulse -->
      <circle cx="210" cy="428" r="28" fill="url(#r-bottle)" class="pulse-glow"/>
      <!-- Bottle body -->
      <path d="M205 448 Q203 434 206 424 L209 414 L211 414 L214 424 Q217 434 215 448 Z"
            fill="#c8a828" opacity="0.95"/>
      <!-- Neck -->
      <rect x="208.5" y="407" width="3" height="9" rx="1" fill="#c8a828"/>
      <!-- Cap -->
      <rect x="207" y="402" width="6" height="7" rx="2" fill="#a08018"/>
      <!-- Stars inside -->
      <text x="210" y="441" text-anchor="middle" font-size="9"  fill="rgba(255,255,255,0.9)">✦</text>
      <text x="207" y="430" text-anchor="middle" font-size="6"  fill="rgba(255,255,255,0.7)">✧</text>
      <text x="214" y="435" text-anchor="middle" font-size="5"  fill="rgba(255,255,255,0.7)">✦</text>
    </g>

    <!-- Small side table -->
    <rect x="20" y="388" width="38" height="60" rx="3" fill="#180a10" stroke="#280e18" stroke-width="1"/>
    <path d="M25 388 Q34 374 44 380 Q50 374 58 388" stroke="#3c2030" stroke-width="1.5" fill="#221428" opacity="0.8"/>
  </svg>`
}

function svgBedroom() {
  return `<svg viewBox="0 0 420 700" preserveAspectRatio="xMidYMid slice"
      xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
    <defs>
      <linearGradient id="b-wall" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#07081a"/>
        <stop offset="100%" stop-color="#0f0c22"/>
      </linearGradient>
      <radialGradient id="r-lamp" cx="50%" cy="20%" r="80%">
        <stop offset="0%" stop-color="#ffe8a0" stop-opacity="0.55"/>
        <stop offset="100%" stop-color="#ffe8a0" stop-opacity="0"/>
      </radialGradient>
    </defs>

    <!-- Background -->
    <rect width="420" height="700" fill="url(#b-wall)"/>

    <!-- Window -->
    <rect x="28" y="45" width="105" height="135" rx="3" fill="#08061c" stroke="#18163a" stroke-width="2"/>
    <line x1="80"  y1="45"  x2="80"  y2="180" stroke="#18163a" stroke-width="1.5"/>
    <line x1="28"  y1="112" x2="133" y2="112" stroke="#18163a" stroke-width="1.5"/>
    <!-- Moon -->
    <circle cx="57"  cy="78" r="16" fill="#e8e0c0" opacity="0.65"/>
    <circle cx="63"  cy="73" r="13" fill="#08061c"/>
    <!-- Stars -->
    <circle cx="96"  cy="62" r="1.5" fill="#fff" opacity="0.7"/>
    <circle cx="112" cy="78" r="1"   fill="#fff" opacity="0.5"/>
    <circle cx="105" cy="148" r="1"  fill="#fff" opacity="0.4"/>
    <circle cx="48"  cy="152" r="1.5" fill="#fff" opacity="0.5"/>

    <!-- Floor -->
    <rect x="0" y="490" width="420" height="210" fill="#080510"/>
    <rect x="0" y="488" width="420" height="3"   fill="#180a1c"/>

    <!-- Headboard -->
    <rect x="58" y="248" width="304" height="72" rx="14" fill="#1c1032"/>
    <rect x="74" y="260" width="62"  height="48" rx="6"  fill="#16082c" stroke="#26124a" stroke-width="1"/>
    <rect x="146" y="260" width="128" height="48" rx="6" fill="#16082c" stroke="#26124a" stroke-width="1"/>
    <rect x="284" y="260" width="62"  height="48" rx="6" fill="#16082c" stroke="#26124a" stroke-width="1"/>

    <!-- Bed sides -->
    <rect x="52"  y="315" width="22" height="180" rx="5" fill="#190c2e"/>
    <rect x="346" y="315" width="22" height="180" rx="5" fill="#190c2e"/>

    <!-- Mattress / sheets -->
    <rect x="58"  y="315" width="304" height="140" rx="4" fill="#1a0e30" stroke="#28124a" stroke-width="1"/>
    <rect x="63"  y="325" width="294" height="125" rx="3" fill="#201240" stroke="#2c1650" stroke-width="1"/>
    <rect x="63"  y="325" width="294" height="30"  rx="3" fill="#281848" stroke="#341e58" stroke-width="1"/>

    <!-- Pillows -->
    <rect x="78"  y="322" width="108" height="42" rx="9" fill="#2c1e52" stroke="#382858" stroke-width="1"/>
    <rect x="234" y="322" width="108" height="42" rx="9" fill="#2c1e52" stroke="#382858" stroke-width="1"/>

    <!-- Footboard -->
    <rect x="52"  y="455" width="316" height="18" rx="4" fill="#190c2e"/>

    <!-- Bedside table -->
    <rect x="344" y="318" width="58" height="100" rx="4" fill="#140820" stroke="#201030" stroke-width="1"/>
    <rect x="349" y="356" width="48" height="28"  rx="2" fill="#18092a" stroke="#241535" stroke-width="1"/>
    <circle cx="373" cy="370" r="3" fill="#2c1840"/>

    <!-- Lamp hotspot -->
    <g class="hotspot" id="scene-hotspot">
      <rect x="340" y="248" width="76" height="80" fill="transparent"/>
      <!-- Warm glow -->
      <ellipse cx="373" cy="310" rx="55" ry="70" fill="url(#r-lamp)" class="lamp-glow"/>
      <!-- Lamp base -->
      <rect x="367" y="316" width="12" height="6" rx="2" fill="#8a6830"/>
      <!-- Pole -->
      <rect x="372" y="272" width="2" height="46" fill="#6a5028"/>
      <!-- Shade -->
      <path d="M357 272 L361 297 L385 297 L389 272 Z" fill="#c8a840" opacity="0.92"/>
      <rect x="357" y="270" width="32" height="3" rx="1" fill="#a08030"/>
      <!-- Light cone -->
      <ellipse cx="373" cy="302" rx="14" ry="4" fill="#ffe8a0" opacity="0.5" class="lamp-flicker"/>
    </g>

    <!-- Rug -->
    <ellipse cx="210" cy="520" rx="175" ry="32" fill="#120820" stroke="#1c0c2a" stroke-width="1"/>
  </svg>`
}

// ── Render helpers ───────────────────────────────────────────────────────────

function groupThreads(msgs) {
  const map = new Map()
  const order = []
  for (const msg of msgs) {
    const tid = String(msg.threadId || msg.id)
    if (!map.has(tid)) { map.set(tid, []); order.push(tid) }
    map.get(tid).push(msg)
  }
  return order.map(tid => ({ threadId: tid, msgs: map.get(tid).reverse() }))
}

function msgListHTML(key) {
  const msgs = getMessages(key)
  if (!msgs.length) return '<p class="empty">还没有留言，来写第一条吧</p>'

  return groupThreads(msgs).map(({ threadId, msgs: tMsgs }) =>
    `<div class="thread-group">
      ${tMsgs.map(m => `
        <div class="bubble ${m.fromMuse ? 'bubble-muse' : 'bubble-user'}">
          ${m.fromMuse ? '<span class="bubble-name">✦ 缪时</span>' : ''}
          <p class="bubble-text">${esc(m.text)}</p>
          <div class="bubble-meta">
            <span class="bubble-time">${m.time}</span>
            <button class="delete-msg-btn" data-id="${m.id}">删除</button>
          </div>
        </div>`).join('')}
      <div class="thread-actions">
        <button class="thread-btn t-muse-btn" data-thread="${threadId}">缪时来说</button>
        <button class="thread-btn t-user-btn" data-thread="${threadId}">我来说</button>
      </div>
      <div class="thread-inline" id="ir-${threadId}" hidden>
        <textarea class="inline-input" placeholder="说点什么…" rows="2" enterkeyhint="send"></textarea>
        <div class="inline-row">
          <button class="t-cancel-btn" data-thread="${threadId}">取消</button>
          <button class="t-send-btn" data-thread="${threadId}">发送</button>
        </div>
      </div>
    </div>`
  ).join('')
}



function renderHome() {
  return `
    <div class="home">
      <header class="home-header">
        <h1 class="home-title">Muse & Yuxin</h1>
        <p class="home-subtitle">我们共同的小角落</p>
      </header>
      <div class="scene-cards">
        <button class="scene-card" data-room="living">
          <div class="scene-thumb living-thumb">
            <span class="book-cover-icon">🛋️</span>
          </div>
          <span class="scene-label">客厅</span>
        </button>
        <button class="scene-card" data-room="bedroom">
          <div class="scene-thumb bedroom-thumb">
            <span class="book-cover-icon">🪔</span>
          </div>
          <span class="scene-label">卧室</span>
        </button>
        <button class="scene-card" data-room="memory">
          <div class="scene-thumb memory-thumb">
            <span class="book-cover-icon">📖</span>
          </div>
          <span class="scene-label">回忆录</span>
        </button>
      </div>
    </div>`
}

function renderScene(roomId) {
  const svg  = roomId === 'living' ? svgLiving() : svgBedroom()
  const hint = roomId === 'living' ? '点击茶几上的星星瓶' : '点击床头的台灯'
  return `
    <div class="scene-page">
      <header class="scene-header">
        <button class="back-btn" id="back-btn">‹</button>
        <span class="scene-title">${ROOMS[roomId].name}</span>
      </header>
      <div class="scene-bg">${svg}</div>
      <p class="scene-hint" id="scene-hint">${hint}</p>

      <!-- Slide-up modal -->
      <div class="msg-modal" id="msg-modal">
        <div class="msg-handle"></div>
        <form class="msg-form" id="msg-form">
          <textarea id="msg-input" placeholder="写点什么…" rows="3" enterkeyhint="send"></textarea>
          <div class="btn-row">
            <button class="add-btn" id="add-btn" type="submit">添加留言</button>
            <button class="muse-btn" id="muse-btn" type="button">✦ 让缪时写一条</button>
          </div>
        </form>
        <div class="msg-list" id="msg-list">${msgListHTML(ROOMS[roomId].key)}</div>
      </div>
      <div class="modal-back" id="modal-back"></div>
    </div>`
}

function renderBook() {
  const threads = groupThreads(getMessages(ROOMS.memory.key))
  const total = threads.length
  if (state.bookPage > total) state.bookPage = total
  const pg    = state.bookPage
  const isWrite = pg === 0
  const thread = threads[pg - 1] || null

  return `
    <div class="room-page">
      <header class="room-header">
        <button class="back-btn" id="back-btn">‹ 返回</button>
        <span class="room-header-name">回忆录</span>
      </header>
      <div class="book-scene">
        <div class="book-wrap">
          <div class="book">
            <div class="book-top">
              ${isWrite
                ? '<span class="page-label">新的一页</span>'
                : `<span class="page-label">第 ${pg} 页 &nbsp;/&nbsp; 共 ${total} 页</span>`}
            </div>
            <div class="page-body" id="page-body">
              ${isWrite ? `
                <div class="write-page">
                  <textarea id="book-input" placeholder="在这里写下今天的故事…" maxlength="400" enterkeyhint="send"></textarea>
                  <div class="book-write-actions">
                    <button class="book-save-btn" id="book-save">写好了 ✦</button>
                    <button class="book-muse-btn" id="book-muse">让缪时写一页</button>
                  </div>
                </div>` : `
                <div class="read-page">
                  <div class="book-thread" data-thread="${thread.threadId}">
                    ${thread.msgs.map(m => `
                      <div class="book-bubble ${m.fromMuse ? 'book-bubble-muse' : 'book-bubble-user'}">
                        ${m.fromMuse ? '<span class="muse-tag book-muse-tag">✦ 缪时</span>' : ''}
                        <p class="book-text">${esc(m.text)}</p>
                        <div class="book-bubble-meta">
                          <span class="book-time">${m.time}</span>
                          <button class="delete-msg-btn book-delete-btn" data-id="${m.id}">删除</button>
                        </div>
                      </div>`).join('')}
                  </div>
                  <div class="book-page-footer">
                    <button class="book-reply-btn t-muse-btn" data-thread="${thread.threadId}">缪时来说</button>
                    <button class="book-reply-btn t-user-btn" data-thread="${thread.threadId}">我来说</button>
                  </div>
                  <div class="thread-inline book-inline" id="ir-${thread.threadId}" hidden>
                    <textarea class="inline-input" placeholder="接着写…" rows="3" enterkeyhint="send"></textarea>
                    <div class="inline-row">
                      <button class="t-cancel-btn" data-thread="${thread.threadId}">取消</button>
                      <button class="t-send-btn" data-thread="${thread.threadId}">发送</button>
                    </div>
                  </div>
                </div>`}
            </div>
          </div>

          <div class="book-nav">
            <button class="nav-btn" id="btn-older" ${pg >= total ? 'disabled' : ''}>‹ 翻旧</button>
            <button class="nav-btn" id="btn-newer" ${pg <= 0    ? 'disabled' : ''}>翻新 ›</button>
          </div>
        </div>
      </div>
    </div>`
}

// ── State & navigation ────────────────────────────────────────────────────────

const state = {
  view: 'home',
  room: null,
  modalOpen: false,
  bookPage: 0,
}

async function go(view, room = null) {
  state.view      = view
  state.room      = room
  state.modalOpen = false
  window.scrollTo(0, 0)
  // 预加载该房间的留言
  if (room && ROOMS[room]) await loadMessages(ROOMS[room].key)
  if (view === 'memory') await loadMessages(ROOMS.memory.key)
  render()
}

function flipBook(dir) {
  const body = document.getElementById('page-body')
  if (!body) return
  body.classList.add(dir === 'older' ? 'flip-left' : 'flip-right')
  setTimeout(() => {
    state.bookPage += dir === 'older' ? 1 : -1
    render()
  }, 220)
}

function openModal() {
  state.modalOpen = true
  document.getElementById('msg-modal')?.classList.add('open')
  document.getElementById('modal-back')?.classList.add('open')
  setTimeout(() => document.getElementById('msg-input')?.focus(), 350)
}

function closeModal() {
  state.modalOpen = false
  document.getElementById('msg-modal')?.classList.remove('open')
  document.getElementById('modal-back')?.classList.remove('open')
}

function sendOnReturn(input, send) {
  if (!input || input.dataset.returnSends === 'true') return
  input.dataset.returnSends = 'true'
  let composing = false
  let allowLineBreak = false
  const submit = e => {
    if (composing || e.isComposing) return
    e.preventDefault()
    send()
  }
  input.addEventListener('compositionstart', () => { composing = true })
  input.addEventListener('compositionend', () => { composing = false })
  input.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== 'NumpadEnter') return
    if (e.shiftKey) {
      allowLineBreak = true
      return
    }
    submit(e)
  })
  input.addEventListener('beforeinput', e => {
    if (e.inputType !== 'insertLineBreak' && e.inputType !== 'insertParagraph') return
    if (allowLineBreak) return
    submit(e)
  })
  input.addEventListener('input', () => {
    if (composing || !/\n$/.test(input.value)) return
    if (allowLineBreak) {
      allowLineBreak = false
      return
    }
    input.value = input.value.replace(/\n+$/, '')
    send()
  })
}

async function autoReplyInLiving(key, threadId) {
  const threadMsgs = getMessages(key)
    .filter(m => String(m.threadId || m.id) === String(threadId))
    .sort((a, b) => a.id - b.id)
  const reply = await askMuseReply('living', threadMsgs)
  await saveMessage(key, reply, true, Number(threadId))
}

// ── Main render ───────────────────────────────────────────────────────────────

function render() {
  const app = document.getElementById('app')

  if (state.view === 'home') {
    app.innerHTML = renderHome()
    app.querySelectorAll('.scene-card').forEach(btn => {
      btn.addEventListener('click', () => {
        const r = btn.dataset.room
        r === 'memory' ? go('memory') : go('scene', r)
      })
    })

  } else if (state.view === 'scene') {
    app.innerHTML = renderScene(state.room)
    const key = ROOMS[state.room].key

    document.getElementById('back-btn').addEventListener('click', () => go('home'))

    // Hotspot
    document.getElementById('scene-hotspot').addEventListener('click', openModal)

    // Modal close
    document.getElementById('modal-back').addEventListener('click', closeModal)

    // Save message
    document.getElementById('msg-form').addEventListener('submit', async e => {
      e.preventDefault()
      const btn = document.getElementById('add-btn')
      const input = document.getElementById('msg-input')
      const text  = input.value.trim()
      if (!text) return
      btn.disabled = true
      const message = await saveMessage(key, text)
      input.value = ''
      document.getElementById('msg-list').innerHTML = msgListHTML(key)
      if (state.room === 'living') {
        try {
          await autoReplyInLiving(key, message.threadId || message.id)
          document.getElementById('msg-list').innerHTML = msgListHTML(key)
        } catch {}
      }
      btn.disabled = false
    })

    sendOnReturn(document.getElementById('msg-input'), () => document.getElementById('msg-form').requestSubmit())

    // Thread action buttons (event delegation)
    document.getElementById('msg-list').addEventListener('click', async (e) => {
      const deleteBtn = e.target.closest('.delete-msg-btn')
      if (deleteBtn) {
        if (!window.confirm('确认吗')) return
        deleteBtn.disabled = true
        await deleteMessage(key, deleteBtn.dataset.id)
        document.getElementById('msg-list').innerHTML = msgListHTML(key)
        return
      }

      const museBtn = e.target.closest('.t-muse-btn')
      if (museBtn) {
        const tid = museBtn.dataset.thread
        const threadMsgs = getMessages(key)
          .filter(m => String(m.threadId || m.id) === tid)
          .sort((a, b) => a.id - b.id)
        museBtn.disabled = true
        museBtn.textContent = '想中…'
        try {
          const reply = await askMuseReply(state.room, threadMsgs)
          await saveMessage(key, reply, true, Number(tid))
          document.getElementById('msg-list').innerHTML = msgListHTML(key)
        } catch {
          museBtn.disabled = false
          museBtn.textContent = '缪时来说'
        }
        return
      }

      const userBtn = e.target.closest('.t-user-btn')
      if (userBtn) {
        const tid = userBtn.dataset.thread
        const el = document.getElementById(`ir-${tid}`)
        if (el) {
          el.hidden = !el.hidden
          if (!el.hidden) {
            const input = el.querySelector('.inline-input')
            sendOnReturn(input, () => el.querySelector('.t-send-btn')?.click())
            input?.focus()
          }
        }
        return
      }

      const cancelBtn = e.target.closest('.t-cancel-btn')
      if (cancelBtn) {
        const el = document.getElementById(`ir-${cancelBtn.dataset.thread}`)
        if (el) el.hidden = true
        return
      }

      const sendBtn = e.target.closest('.t-send-btn')
      if (sendBtn) {
        const tid = sendBtn.dataset.thread
        const el = document.getElementById(`ir-${tid}`)
        const text = el?.querySelector('.inline-input')?.value.trim()
        if (!text) return
        sendBtn.disabled = true
        await saveMessage(key, text, false, Number(tid))
        document.getElementById('msg-list').innerHTML = msgListHTML(key)
        if (state.room === 'living') {
          try {
            await autoReplyInLiving(key, tid)
            document.getElementById('msg-list').innerHTML = msgListHTML(key)
          } catch {}
        }
      }
    })

    // 缪时写一条
    document.getElementById('muse-btn').addEventListener('click', async () => {
      const btn = document.getElementById('muse-btn')
      btn.disabled = true
      btn.textContent = '缪时正在想…'
      try {
        const text = await askMuse(state.room)
        await saveMessage(key, text, true)
        document.getElementById('msg-list').innerHTML = msgListHTML(key)
      } catch (e) {
        btn.textContent = '出错了，再试一次'
        setTimeout(() => { btn.disabled = false; btn.textContent = '✦ 让缪时写一条' }, 2000)
        return
      }
      btn.disabled = false
      btn.textContent = '✦ 让缪时写一条'
    })

    // Auto-hide hint
    setTimeout(() => {
      const h = document.getElementById('scene-hint')
      if (h) h.style.opacity = '0'
    }, 3500)

    if (state.modalOpen) {
      document.getElementById('msg-modal')?.classList.add('open')
      document.getElementById('modal-back')?.classList.add('open')
    }

  } else if (state.view === 'memory') {
    app.innerHTML = renderBook()

    document.getElementById('back-btn').addEventListener('click', () => go('home'))

    document.getElementById('book-save')?.addEventListener('click', async () => {
      const input = document.getElementById('book-input')
      const text  = input?.value.trim()
      if (!text) return
      await saveMessage(ROOMS.memory.key, text)
      state.bookPage = 1
      render()
    })

    sendOnReturn(document.getElementById('book-input'), () => document.getElementById('book-save')?.click())

    document.getElementById('book-muse')?.addEventListener('click', async () => {
      const btn = document.getElementById('book-muse')
      btn.disabled = true
      btn.textContent = '缪时正在想…'
      try {
        const text = await askMuse('memory')
        await saveMessage(ROOMS.memory.key, text, true)
        state.bookPage = 1
        render()
      } catch {
        btn.textContent = '出错了，再试一次'
        setTimeout(() => { btn.disabled = false; btn.textContent = '让缪时写一页' }, 2000)
      }
    })

    document.getElementById('btn-older')?.addEventListener('click', () => flipBook('older'))
    document.getElementById('btn-newer')?.addEventListener('click', () => flipBook('newer'))

    document.getElementById('page-body')?.addEventListener('click', async (e) => {
      const key = ROOMS.memory.key
      const deleteBtn = e.target.closest('.delete-msg-btn')
      if (deleteBtn) {
        if (!window.confirm('确认吗')) return
        deleteBtn.disabled = true
        await deleteMessage(key, deleteBtn.dataset.id)
        state.bookPage = Math.min(state.bookPage, groupThreads(getMessages(key)).length)
        render()
        return
      }

      const museBtn = e.target.closest('.t-muse-btn')
      if (museBtn) {
        const tid = museBtn.dataset.thread
        const threadMsgs = getMessages(key)
          .filter(m => String(m.threadId || m.id) === tid)
          .sort((a, b) => a.id - b.id)
        museBtn.disabled = true
        museBtn.textContent = '想中…'
        try {
          const reply = await askMuseReply('memory', threadMsgs)
          await saveMessage(key, reply, true, Number(tid))
          state.bookPage = 1
          render()
        } catch {
          museBtn.disabled = false
          museBtn.textContent = '缪时来说'
        }
        return
      }

      const userBtn = e.target.closest('.t-user-btn')
      if (userBtn) {
        const tid = userBtn.dataset.thread
        const el = document.getElementById(`ir-${tid}`)
        if (el) {
          el.hidden = !el.hidden
          if (!el.hidden) {
            const input = el.querySelector('.inline-input')
            sendOnReturn(input, () => el.querySelector('.t-send-btn')?.click())
            input?.focus()
          }
        }
        return
      }

      const cancelBtn = e.target.closest('.t-cancel-btn')
      if (cancelBtn) {
        const el = document.getElementById(`ir-${cancelBtn.dataset.thread}`)
        if (el) el.hidden = true
        return
      }

      const sendBtn = e.target.closest('.t-send-btn')
      if (sendBtn) {
        const tid = sendBtn.dataset.thread
        const el = document.getElementById(`ir-${tid}`)
        const text = el?.querySelector('.inline-input')?.value.trim()
        if (!text) return
        sendBtn.disabled = true
        await saveMessage(key, text, false, Number(tid))
        state.bookPage = 1
        render()
      }
    })
  }
}

render()
