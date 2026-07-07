const BASE = process.env.KV_REST_API_URL
const TOKEN = process.env.KV_REST_API_TOKEN

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
