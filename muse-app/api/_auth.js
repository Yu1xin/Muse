import { createClient } from '@supabase/supabase-js'

const ALLOWED_EMAILS = new Set(['yuxinh402@gmail.com', 'yh3832@barnard.edu'])

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

export async function requireUser(req) {
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!token) return null
  const { data, error } = await supabaseAdmin.auth.getUser(token)
  const email = data?.user?.email?.toLowerCase()
  if (error || !email || !ALLOWED_EMAILS.has(email)) return null
  return data.user
}
