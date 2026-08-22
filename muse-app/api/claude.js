export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(req.body),
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
