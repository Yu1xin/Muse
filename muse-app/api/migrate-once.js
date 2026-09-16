import { createClient } from '@supabase/supabase-js'

const BASE = process.env.KV_REST_API_URL
const TOKEN = process.env.KV_REST_API_TOKEN
const CRON_SECRET = process.env.CRON_SECRET

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

const ROOM_KEYS = ['room-living', 'room-bedroom', 'room-memory', 'room-diary']
const MEMORY_KEYS = {
  ordinary: 'memory-v1-ordinary',
  sensitive_history: 'memory-v1-sensitive-history',
  current_state: 'memory-v1-current-state',
}

async function redisGet(key) {
  const res = await fetch(`${BASE}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${TOKEN}` } })
  const { result } = await res.json()
  if (!result) return null
  try {
    const parsed = JSON.parse(result)
    return typeof parsed === 'string' ? JSON.parse(parsed) : parsed
  } catch { return null }
}

function chunk(array, size) {
  const chunks = []
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size))
  return chunks
}

async function migrateMessages() {
  let total = 0
  const mediaIds = new Set()
  for (const room of ROOM_KEYS) {
    const raw = await redisGet(room)
    const messages = Array.isArray(raw) ? raw : []
    const rows = messages.map(m => {
      for (const att of (m.attachments || [])) if (att?.id) mediaIds.add(att.id)
      return {
        id: Number(m.id),
        room,
        text: String(m.text || ''),
        attachments: m.attachments || null,
        from_muse: !!m.fromMuse,
        kind: m.kind || null,
        thread_id: Number(m.threadId || m.id),
        created_at: new Date(Number(m.id)).toISOString(),
      }
    }).filter(row => Number.isFinite(row.id))
    for (const batch of chunk(rows, 500)) {
      const { error } = await supabase.from('messages').upsert(batch)
      if (error) throw new Error(`messages upsert failed (${room}): ${error.message}`)
    }
    total += rows.length
  }
  return { total, mediaIds: [...mediaIds] }
}

async function migrateMemories() {
  let total = 0
  for (const [type, key] of Object.entries(MEMORY_KEYS)) {
    const raw = await redisGet(key)
    const items = Array.isArray(raw) ? raw : []
    const rows = items.map(m => ({
      id: String(m.id),
      type,
      dedupe_key: m.dedupe_key || null,
      title: String(m.title || ''),
      summary: String(m.summary || ''),
      retrieval_tags: m.retrieval_tags || [],
      occurred_at: m.occurred_at || null,
      current_status: m.current_status || null,
      interaction_implications: m.interaction_implications || null,
      sensitivity: m.sensitivity || null,
      status: m.status || null,
      evidence: m.evidence || null,
      confidence: m.confidence ?? null,
      expires_at: m.expires_at || null,
      source: m.source || null,
      created_at: m.created_at || new Date().toISOString(),
      updated_at: m.updated_at || m.created_at || new Date().toISOString(),
    }))
    for (const batch of chunk(rows, 500)) {
      const { error } = await supabase.from('memories').upsert(batch)
      if (error) throw new Error(`memories upsert failed (${type}): ${error.message}`)
    }
    total += rows.length
  }
  return total
}

async function migrateMuseState() {
  const raw = await redisGet('muse-autonomy-state-v1')
  if (!raw) return false
  const { error } = await supabase.from('muse_state').upsert({
    id: 1,
    mood: raw.mood || null,
    body: raw.body || null,
    energy: raw.energy ?? null,
    relationship_intensity: raw.relationshipIntensity ?? null,
    pending_responses: raw.pendingResponses || [],
    updated_at: raw.updatedAt || null,
  })
  if (error) throw new Error(`muse_state upsert failed: ${error.message}`)
  return true
}

async function migrateProactiveState() {
  const state = await redisGet('muse-proactive-v1-state')
  if (state) {
    const { error } = await supabase.from('proactive_state').upsert({
      id: 1,
      last_sent_at: state.lastSentAt ? new Date(state.lastSentAt).toISOString() : null,
      recent_urls: state.recentUrls || [],
    })
    if (error) throw new Error(`proactive_state upsert failed: ${error.message}`)
  }
  const pending = await redisGet('muse-proactive-v1-pending')
  if (pending) {
    const { error } = await supabase.from('proactive_pending').upsert({
      id: 1,
      message_id: pending.id ? Number(pending.id) : null,
      text: pending.text || null,
      room: pending.room || null,
      created_at: pending.createdAt ? new Date(pending.createdAt).toISOString() : null,
    })
    if (error) throw new Error(`proactive_pending upsert failed: ${error.message}`)
  }
  return { state: !!state, pending: !!pending }
}

async function migrateMedia(mediaIds) {
  const rows = []
  for (const id of mediaIds) {
    const media = await redisGet(`media-v1-${id}`)
    if (!media?.pathname) continue
    rows.push({
      id: String(id),
      pathname: media.pathname,
      mime_type: media.mimeType,
      bytes: Number(media.bytes) || 0,
      created_at: media.createdAt || new Date().toISOString(),
    })
  }
  let total = 0
  for (const batch of chunk(rows, 500)) {
    const { error } = await supabase.from('media').upsert(batch)
    if (error) throw new Error(`media upsert failed: ${error.message}`)
    total += batch.length
  }
  return total
}

export default async function handler(req, res) {
  if (!CRON_SECRET || req.headers.authorization !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: 'Unauthorized' })
  try {
    const messagesResult = await migrateMessages()
    const memoriesTotal = await migrateMemories()
    const museStateMigrated = await migrateMuseState()
    const proactiveResult = await migrateProactiveState()
    const mediaTotal = await migrateMedia(messagesResult.mediaIds)
    return res.json({
      ok: true,
      messages: messagesResult.total,
      memories: memoriesTotal,
      museState: museStateMigrated,
      proactive: proactiveResult,
      media: mediaTotal,
    })
  } catch (error) {
    console.error('[migrate-once] failed', { message: error?.message || String(error) })
    return res.status(500).json({ error: error?.message || 'Migration failed' })
  }
}
