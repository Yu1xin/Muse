import './style.css'

const rooms = [
  {
    id: 'living',
    key: 'room-living',
    name: '客厅',
    icon: '🛋️',
    desc: '留下你想说的话，陪彼此度过每一个平常的夜晚',
  },
  {
    id: 'bedroom',
    key: 'room-bedroom',
    name: '卧室',
    icon: '🌙',
    desc: '睡前的悄悄话，只有两个人知道的秘密',
  },
  {
    id: 'memory',
    key: 'room-memory',
    name: '回忆录',
    icon: '📖',
    desc: '值得被记住的时刻，我们共同编写的故事',
  },
]

function getMessages(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || '[]')
  } catch {
    return []
  }
}

function saveMessage(key, text) {
  const messages = getMessages(key)
  messages.unshift({
    id: Date.now(),
    text,
    time: new Date().toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }),
  })
  localStorage.setItem(key, JSON.stringify(messages))
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '<br>')
}

function renderHome() {
  return `
    <div class="home">
      <header class="home-header">
        <h1 class="home-title">缪时的家</h1>
        <p class="home-subtitle">我们共同的小角落</p>
      </header>
      <div class="rooms">
        ${rooms.map(r => `
          <button class="room-card" data-room="${r.id}">
            <span class="room-icon">${r.icon}</span>
            <div class="room-info">
              <span class="room-name">${r.name}</span>
              <span class="room-desc">${r.desc}</span>
            </div>
            <span class="room-arrow">›</span>
          </button>
        `).join('')}
      </div>
    </div>
  `
}

function renderRoom(roomId) {
  const room = rooms.find(r => r.id === roomId)
  const messages = getMessages(room.key)
  return `
    <div class="room-page">
      <header class="room-header">
        <button class="back-btn" id="back-btn">‹ 返回</button>
        <span class="room-header-name">${room.icon} ${room.name}</span>
      </header>
      <div class="input-area">
        <textarea id="msg-input" placeholder="写点什么…" rows="3"></textarea>
        <button id="add-btn" class="add-btn">添加留言</button>
      </div>
      <div class="messages" id="messages">
        ${messages.length === 0
          ? '<p class="empty">还没有留言，来写第一条吧</p>'
          : messages.map(m => `
            <div class="message-item">
              <p class="message-text">${escapeHtml(m.text)}</p>
              <span class="message-time">${m.time}</span>
            </div>
          `).join('')
        }
      </div>
    </div>
  `
}

let currentView = 'home'
let currentRoom = null

function navigate(view, roomId = null) {
  currentView = view
  currentRoom = roomId
  window.scrollTo(0, 0)
  render()
}

function render() {
  const app = document.getElementById('app')

  if (currentView === 'home') {
    app.innerHTML = renderHome()
    app.querySelectorAll('.room-card').forEach(btn => {
      btn.addEventListener('click', () => navigate('room', btn.dataset.room))
    })
  } else {
    app.innerHTML = renderRoom(currentRoom)

    document.getElementById('back-btn').addEventListener('click', () => navigate('home'))

    const input = document.getElementById('msg-input')
    const addBtn = document.getElementById('add-btn')

    addBtn.addEventListener('click', () => {
      const text = input.value.trim()
      if (!text) return
      const room = rooms.find(r => r.id === currentRoom)
      saveMessage(room.key, text)
      input.value = ''
      render()
    })

    // Ctrl+Enter to submit
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        addBtn.click()
      }
    })
  }
}

render()
