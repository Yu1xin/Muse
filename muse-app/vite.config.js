import { defineConfig } from 'vite'
import fs from 'fs'
import path from 'path'
import https from 'https'

// 解析 .env.local
const envFile = path.resolve(process.cwd(), '.env.local')
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf-8').split('\n').forEach(line => {
    const [k, ...v] = line.split('=')
    if (k?.trim()) process.env[k.trim()] = v.join('=').trim()
  })
}

export default defineConfig({
  plugins: [{
    name: 'claude-proxy',
    configureServer(server) {
      server.middlewares.use('/api/claude', (req, res) => {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', () => {
          const apiReq = https.request({
            hostname: 'api.anthropic.com',
            port: 443,
            path: '/v1/messages',
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-api-key': process.env.ANTHROPIC_KEY,
              'anthropic-version': '2023-06-01',
              'content-length': Buffer.byteLength(body),
            },
          }, apiRes => {
            res.statusCode = apiRes.statusCode
            res.setHeader('content-type', 'application/json')
            apiRes.pipe(res)
          })
          apiReq.on('error', err => {
            res.statusCode = 500
            res.end(JSON.stringify({ error: err.message }))
          })
          apiReq.write(body)
          apiReq.end()
        })
      })
    },
  }],
})
