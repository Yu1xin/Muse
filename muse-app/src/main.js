import './style.css'

const ROOMS = {
  living:  { key: 'room-living',  name: '客厅' },
  bedroom: { key: 'room-bedroom', name: '卧室' },
  memory:  { key: 'room-memory',  name: '回忆录' },
}

function getMessages(key) {
  try { return JSON.parse(localStorage.getItem(key) || '[]') } catch { return [] }
}

function saveMessage(key, text) {
  const msgs = getMessages(key)
  msgs.unshift({
    id: Date.now(),
    text,
    time: new Date().toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    }),
  })
  localStorage.setItem(key, JSON.stringify(msgs))
}

function esc(t) {
  return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
          .replace(/"/g,'&quot;').replace(/\n/g,'<br>')
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

function msgListHTML(key) {
  const msgs = getMessages(key)
  if (!msgs.length) return '<p class="empty">还没有留言，来写第一条吧</p>'
  return msgs.map(m => `
    <div class="message-item">
      <p class="message-text">${esc(m.text)}</p>
      <span class="message-time">${m.time}</span>
    </div>`).join('')
}

// ── Views ────────────────────────────────────────────────────────────────────

function renderHome() {
  return `
    <div class="home">
      <header class="home-header">
        <h1 class="home-title">缪时的家</h1>
        <p class="home-subtitle">我们共同的小角落</p>
      </header>
      <div class="scene-cards">
        <button class="scene-card" data-room="living">
          <div class="scene-thumb living-thumb"></div>
          <span class="scene-label">客厅</span>
        </button>
        <button class="scene-card" data-room="bedroom">
          <div class="scene-thumb bedroom-thumb"></div>
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
        <textarea id="msg-input" placeholder="写点什么…" rows="3"></textarea>
        <button class="add-btn" id="add-btn">添加留言</button>
        <div class="msg-list" id="msg-list">${msgListHTML(ROOMS[roomId].key)}</div>
      </div>
      <div class="modal-back" id="modal-back"></div>
    </div>`
}

function renderBook() {
  const msgs  = getMessages(ROOMS.memory.key)
  const total = msgs.length
  const pg    = state.bookPage
  const isWrite = pg === 0
  const msg   = msgs[pg - 1] || null

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
                  <textarea id="book-input" placeholder="在这里写下今天的故事…" maxlength="400"></textarea>
                  <button class="book-save-btn" id="book-save">写好了 ✦</button>
                </div>` : `
                <div class="read-page">
                  <p class="book-text">${esc(msg.text)}</p>
                  <span class="book-time">${msg.time}</span>
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

function go(view, room = null) {
  state.view      = view
  state.room      = room
  state.modalOpen = false
  window.scrollTo(0, 0)
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
    document.getElementById('add-btn').addEventListener('click', () => {
      const input = document.getElementById('msg-input')
      const text  = input.value.trim()
      if (!text) return
      saveMessage(key, text)
      input.value = ''
      document.getElementById('msg-list').innerHTML = msgListHTML(key)
    })

    document.getElementById('msg-input').addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        document.getElementById('add-btn').click()
      }
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

    document.getElementById('book-save')?.addEventListener('click', () => {
      const input = document.getElementById('book-input')
      const text  = input?.value.trim()
      if (!text) return
      saveMessage(ROOMS.memory.key, text)
      state.bookPage = 1
      render()
    })

    document.getElementById('btn-older')?.addEventListener('click', () => flipBook('older'))
    document.getElementById('btn-newer')?.addEventListener('click', () => flipBook('newer'))
  }
}

render()
