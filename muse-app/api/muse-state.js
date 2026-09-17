import { requireUser } from './_auth.js'
import { supabase } from './_supabase.js'

const DEFAULT_STATE = {
  mood: '平静、有点想逗她',
  body: '精神还不错',
  energy: 68,
  relationshipIntensity: 72,
  pendingResponses: [],
  updatedAt: null,
}

async function loadState() {
  const { data, error } = await supabase.from('muse_state').select('*').eq('id', 1).maybeSingle()
  if (error) throw new Error(`muse_state read failed: ${error.message}`)
  if (!data) return null
  return {
    mood: data.mood,
    body: data.body,
    energy: data.energy,
    relationshipIntensity: data.relationship_intensity,
    pendingResponses: data.pending_responses || [],
    updatedAt: data.updated_at,
  }
}

async function saveState(next) {
  const { error } = await supabase.from('muse_state').upsert({
    id: 1,
    mood: next.mood,
    body: next.body,
    energy: next.energy,
    relationship_intensity: next.relationshipIntensity,
    pending_responses: next.pendingResponses,
    updated_at: next.updatedAt,
  })
  if (error) throw new Error(`muse_state write failed: ${error.message}`)
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
    if (!await requireUser(req)) return res.status(401).json({ error: 'Unauthorized' })
    if (req.method === 'GET') return res.json(decayedState(await loadState()))

    if (req.method === 'PUT') {
      const current = decayedState(await loadState())
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
      await saveState(next)
      return res.json(next)
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (error) {
    console.error('[muse-state] request failed', { message: error?.message || String(error) })
    return res.status(500).json({ error: 'Muse state request failed' })
  }
}
