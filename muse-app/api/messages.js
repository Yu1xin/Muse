const BASE = process.env.UPSTASH_REDIS_REST_URL
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN

async function redisGet(key) {
  const res = await fetch(`${BASE}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  const { result } = await res.json()
  if (!result) return []
  try { return JSON.parse(result) } catch { return [] }
}

async function redisSet(key, value) {
  await fetch(`${BASE}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(JSON.stringify(value)),
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
    const { text, fromMuse = false } = req.body
    if (!text) return res.status(400).json({ error: 'text required' })
    const messages = await redisGet(room)
    const newMsg = {
      id: Date.now(),
      text,
      fromMuse,
      time: new Date().toLocaleString('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      }),
    }
    messages.unshift(newMsg)
    await redisSet(room, messages)
    return res.json(newMsg)
  }

  res.status(405).end()
}
