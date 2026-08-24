const BASE = process.env.KV_REST_API_URL
const TOKEN = process.env.KV_REST_API_TOKEN
const STATE_KEY = 'muse-autonomy-state-v1'

const DEFAULT_STATE = {
  mood: '平静、有点想逗她',
  body: '精神还不错',
  energy: 68,
  relationshipIntensity: 72,
  pendingResponses: [],
  updatedAt: null,
}

async function redisGet(key) {
  const response = await fetch(`${BASE}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  if (!response.ok) throw new Error(`KV read failed with ${response.status}`)
  const { result } = await response.json()
  if (!result) return null
  try {
    const parsed = JSON.parse(result)
    return typeof parsed === 'string' ? JSON.parse(parsed) : parsed
  } catch { return null }
}

async function redisSet(key, value) {
  const response = await fetch(`${BASE}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(value),
  })
  if (!response.ok) throw new Error(`KV write failed with ${response.status}`)
}

function boundedNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : fallback
}

function decayedState(raw) {
  const state = { ...DEFAULT_STATE, ...(raw || {}) }
  const updatedAt = Date.parse(state.updatedAt)
  const elapsedHours = Number.isFinite(updatedAt) ? Math.max(0, (Date.now() - updatedAt) / 3_600_000) : 0
  const drift = Math.min(1, elapsedHours / 24)
  const now = Date.now()
  const pendingResponses = (Array.isArray(state.pendingResponses) ? state.pendingResponses : [])
    .filter(item => item && item.id && Date.parse(item.expiresAt) > now)
    .slice(0, 3)
    .map(item => ({
      id: String(item.id).slice(0, 100),
      room: String(item.room || '').slice(0, 40),
      threadId: String(item.threadId || '').slice(0, 100),
      triggerMessageId: String(item.triggerMessageId || '').slice(0, 100),
      topic: String(item.topic || '').slice(0, 240),
      createdAt: item.createdAt,
      expiresAt: item.expiresAt,
    }))
  return {
    mood: String(elapsedHours >= 12 ? DEFAULT_STATE.mood : state.mood || DEFAULT_STATE.mood).slice(0, 100),
    body: String(elapsedHours >= 12 ? DEFAULT_STATE.body : state.body || DEFAULT_STATE.body).slice(0, 100),
    energy: Math.round(boundedNumber(state.energy, DEFAULT_STATE.energy) * (1 - drift) + 60 * drift),
    relationshipIntensity: Math.round(boundedNumber(state.relationshipIntensity, DEFAULT_STATE.relationshipIntensity) * (1 - drift) + 55 * drift),
    pendingResponses,
    updatedAt: state.updatedAt || null,
  }
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') return res.json(decayedState(await redisGet(STATE_KEY)))

    if (req.method === 'PUT') {
      const current = decayedState(await redisGet(STATE_KEY))
      const pendingResponses = decayedState({
        ...current,
        pendingResponses: Array.isArray(req.body?.pendingResponses) ? req.body.pendingResponses : current.pendingResponses,
      }).pendingResponses
      const next = {
        mood: String(req.body?.mood || current.mood).trim().slice(0, 100),
        body: String(req.body?.body || current.body).trim().slice(0, 100),
        energy: boundedNumber(req.body?.energy, current.energy),
        relationshipIntensity: boundedNumber(req.body?.relationshipIntensity, current.relationshipIntensity),
        pendingResponses,
        updatedAt: new Date().toISOString(),
      }
      await redisSet(STATE_KEY, next)
      return res.json(next)
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (error) {
    console.error('[muse-state] request failed', { message: error?.message || String(error) })
    return res.status(500).json({ error: 'Muse state request failed' })
  }
}
