import { get } from '@vercel/blob'
import { requireUser } from './_auth.js'
import { supabase } from './_supabase.js'

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

async function storedImageBlock(id) {
  const safeId = String(id || '')
  if (!/^[a-f0-9-]{20,50}$/i.test(safeId)) throw new Error('Invalid stored image id')
  const { data, error } = await supabase.from('media').select('*').eq('id', safeId).maybeSingle()
  if (error) throw new Error(`media read failed: ${error.message}`)
  const media = data ? { pathname: data.pathname, mimeType: data.mime_type, bytes: data.bytes } : null
  if (!media?.pathname || !ALLOWED_IMAGE_TYPES.has(media.mimeType) || Number(media.bytes) > 3 * 1024 * 1024) {
    throw new Error('Stored image is unavailable or invalid')
  }
  const result = await get(media.pathname, { access: 'private' })
  if (result?.statusCode !== 200 || !result.stream) throw new Error('Stored image could not be read')
  const buffer = Buffer.from(await new Response(result.stream).arrayBuffer())
  if (buffer.length !== Number(media.bytes) || buffer.length > 3 * 1024 * 1024) throw new Error('Stored image size mismatch')
  return {
    type: 'image',
    source: { type: 'base64', media_type: media.mimeType, data: buffer.toString('base64') },
  }
}

async function resolveStoredImages(messages) {
  let imageCount = 0
  return Promise.all((Array.isArray(messages) ? messages : []).map(async message => {
    if (!Array.isArray(message.content)) return message
    const blocks = []
    for (const block of message.content) {
      if (block?.type !== 'stored_image') {
        blocks.push(block)
        continue
      }
      imageCount += 1
      if (imageCount > 4) throw new Error('Too many images in Claude request')
      blocks.push(await storedImageBlock(block.id))
    }
    return { ...message, content: blocks }
  }))
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }
  if (!await requireUser(req)) return res.status(401).json({ error: 'Unauthorized' })

  let body
  try {
    body = { ...req.body, messages: await resolveStoredImages(req.body?.messages) }
  } catch (error) {
    console.error('[claude] stored image resolution failed', { message: error?.message || String(error) })
    return res.status(400).json({ error: { message: 'One or more attached images are invalid' } })
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  })

  const data = await response.json()
  console.info('[claude] completion', {
    status: response.status,
    model: data.model ?? req.body?.model,
    stopReason: data.stop_reason ?? null,
    stopSequence: data.stop_sequence ?? null,
    maxTokens: req.body?.max_tokens ?? null,
    inputTokens: data.usage?.input_tokens ?? null,
    outputTokens: data.usage?.output_tokens ?? null,
    cacheCreationTokens: data.usage?.cache_creation_input_tokens ?? null,
    cacheReadTokens: data.usage?.cache_read_input_tokens ?? null,
  })
  res.status(response.status).json(data)
}
