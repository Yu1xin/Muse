import { Redis } from '@upstash/redis'

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

export default async function handler(req, res) {
  const { room } = req.query
  if (!room) return res.status(400).json({ error: 'room required' })

  if (req.method === 'GET') {
    const messages = (await redis.get(room)) || []
    return res.json(messages)
  }

  if (req.method === 'POST') {
    const { text, fromMuse = false } = req.body
    if (!text) return res.status(400).json({ error: 'text required' })
    const messages = (await redis.get(room)) || []
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
    await redis.set(room, messages)
    return res.json(newMsg)
  }

  res.status(405).end()
}
