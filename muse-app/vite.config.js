import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    server: {
      proxy: {
        '/api/claude': {
          target: 'https://api.anthropic.com',
          changeOrigin: true,
          rewrite: path => path.replace(/^\/api\/claude/, '/v1/messages'),
          headers: {
            'x-api-key': env.ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01',
          },
        },
      },
    },
  }
})
