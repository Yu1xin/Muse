const BASE = process.env.KV_REST_API_URL
const TOKEN = process.env.KV_REST_API_TOKEN

const DIARY_BUFFER_KEY = 'diary-buffer'
const DIARY_ROOM_KEY = 'room-diary'
const DIARY_BATCH_SIZE = 60

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
每部分写2到4句话,具体、有画面感,基于下面给出的对话记录来写。如果记录里信息不够具体,就合理概括,不要编造没发生过的具体事实(比如虚构地点、第三者、意外事件),但可以写你自己对这段互动的理解、情绪和态度。
直接输出五个部分,不要加额外的开场白或结尾寒暄。`

async function maybeWriteDiaryEntry() {
  try {
    const buffer = await redisGet(DIARY_BUFFER_KEY)
    if (!Array.isArray(buffer) || buffer.length < DIARY_BATCH_SIZE) return

    const batch = buffer.slice(0, DIARY_BATCH_SIZE)
    const rest = buffer.slice(DIARY_BATCH_SIZE)
    // Reset the buffer immediately so concurrent requests don't double-trigger.
    await redisSet(DIARY_BUFFER_KEY, rest)

    const transcript = batch
      .map(m => `${ROOM_NAMES[m.room] || m.room}|${m.fromMuse ? '缪时' : '小乖'}|${m.text}`)
      .join('\n')

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 700,
        system: DIARY_SYSTEM,
        messages: [{
          role: 'user',
          content: `以下是最近 ${batch.length} 条对话记录(格式:房间|说话人|内容):\n${transcript}\n\n请写这篇日记。`,
        }],
      }),
    })
    if (!response.ok) return
    const data = await response.json()
    const diaryText = data?.content?.[0]?.text?.trim()
    if (!diaryText) return

    const diaryMessages = await redisGet(DIARY_ROOM_KEY)
    const id = Date.now()
    diaryMessages.unshift({
      id,
      text: diaryText,
      fromMuse: true,
      threadId: id,
      time: new Date().toLocaleString('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      }),
    })
    await redisSet(DIARY_ROOM_KEY, diaryMessages)
  } catch {
    // Diary generation is best-effort; never break normal message saving because of it.
  }
}

export default async function handler(req, res) {
  const { room } = req.query
  if (!room) return res.status(400).json({ error: 'room required' })

  if (req.method === 'GET') {
    const messages = await redisGet(room)
    return res.json(messages)
  }

  if (req.method === 'POST') {
    const { text, fromMuse = false, threadId = null } = req.body
    if (!text) return res.status(400).json({ error: 'text required' })
    const messages = await redisGet(room)
    const id = Date.now()
    const newMsg = {
      id,
      text,
      fromMuse,
      threadId: threadId || id,
      time: new Date().toLocaleString('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      }),
    }
    messages.unshift(newMsg)
    await redisSet(room, messages)

    // Feed the global diary buffer (skip the diary room itself to avoid feedback loops)
    // and diary-related "tool rooms" have no chat messages anyway.
    if (room !== DIARY_ROOM_KEY && ROOM_NAMES[room]) {
      const buffer = await redisGet(DIARY_BUFFER_KEY)
      buffer.push({ room, text, fromMuse, time: newMsg.time })
      await redisSet(DIARY_BUFFER_KEY, buffer)
      await maybeWriteDiaryEntry()
    }

    return res.json(newMsg)
  }

  if (req.method === 'DELETE') {
    const id = Number(req.body?.id ?? req.query.id)
    if (!id) return res.status(400).json({ error: 'id required' })
    const messages = await redisGet(room)
    const nextMessages = messages.filter(message => Number(message.id) !== id)
    await redisSet(room, nextMessages)
    return res.json({ ok: true })
  }

  res.status(405).end()
}
