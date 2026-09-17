import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { get, put } from '@vercel/blob'
import { requireUser } from './_auth.js'
import { supabase } from './_supabase.js'

const MAX_IMAGE_BYTES = 3 * 1024 * 1024
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }

export const config = { api: { bodyParser: false } }

async function loadMedia(id) {
  const { data, error } = await supabase.from('media').select('*').eq('id', id).maybeSingle()
  if (error) throw new Error(`media read failed: ${error.message}`)
  if (!data) return null
  return { id: data.id, pathname: data.pathname, mimeType: data.mime_type, bytes: data.bytes, createdAt: data.created_at }
}

async function saveMedia(media) {
  const { error } = await supabase.from('media').insert({
    id: media.id,
    pathname: media.pathname,
    mime_type: media.mimeType,
    bytes: media.bytes,
    created_at: media.createdAt,
  })
  if (error) throw new Error(`media write failed: ${error.message}`)
}

async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_IMAGE_BYTES) throw Object.assign(new Error('Image is too large'), { statusCode: 413 })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function detectedType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'image/png'
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return null
}

function safeId(value) {
  const id = String(value || '')
  return /^[a-f0-9-]{20,50}$/i.test(id) ? id : null
}

export default async function handler(req, res) {
  try {
    if (req.method === 'POST') {
      if (!await requireUser(req)) return res.status(401).json({ error: 'Unauthorized' })
      if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) {
        return res.status(503).json({ error: 'Private image storage is not connected yet' })
      }
      const declaredType = String(req.headers['content-type'] || '').split(';')[0].toLowerCase()
      if (!ALLOWED_TYPES.has(declaredType)) return res.status(415).json({ error: 'Unsupported image type' })
      const buffer = await readBody(req)
      if (!buffer.length) return res.status(400).json({ error: 'Image is empty' })
      const actualType = detectedType(buffer)
      if (!actualType || actualType !== declaredType) return res.status(415).json({ error: 'Image content does not match its type' })

      const id = crypto.randomUUID()
      const pathname = `chat-images/${id}.${EXTENSIONS[actualType]}`
      const blob = await put(pathname, buffer, {
        access: 'private',
        contentType: actualType,
        addRandomSuffix: true,
      })
      await saveMedia({
        id,
        pathname: blob.pathname,
        mimeType: actualType,
        bytes: buffer.length,
        createdAt: new Date().toISOString(),
      })
      return res.json({ attachment: { id, kind: 'image', mimeType: actualType, bytes: buffer.length } })
    }

    if (req.method === 'GET') {
      const id = safeId(req.query?.id)
      if (!id) return res.status(400).json({ error: 'Valid media id required' })
      const media = await loadMedia(id)
      if (!media?.pathname || !ALLOWED_TYPES.has(media.mimeType)) return res.status(404).json({ error: 'Image not found' })
      const result = await get(media.pathname, {
        access: 'private',
        ifNoneMatch: req.headers['if-none-match'] || undefined,
      })
      if (!result) return res.status(404).json({ error: 'Image not found' })
      res.setHeader('Cache-Control', 'private, no-cache')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'none'; sandbox")
      if (result.blob?.etag) res.setHeader('ETag', result.blob.etag)
      if (result.statusCode === 304) return res.status(304).end()
      res.setHeader('Content-Type', media.mimeType)
      return Readable.fromWeb(result.stream).pipe(res)
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (error) {
    console.error('[media] request failed', { message: error?.message || String(error) })
    return res.status(error?.statusCode || 500).json({ error: error?.statusCode ? error.message : 'Image request failed' })
  }
}
