import type { Settings } from './settings'

export async function transcribeAudio(blob: Blob, s: Settings): Promise<string> {
  const form = new FormData()
  form.append('file', blob, 'audio.webm')
  form.append('model', s.asr.model)
  const res = await fetch(`${s.asr.baseURL}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${s.asr.apiKey}` },
    body: form,
  })
  if (!res.ok) throw new Error(`ASR error: ${res.status}`)
  const data = await res.json()
  return data.text || ''
}

export async function sendToGateway(text: string, s: Settings): Promise<string> {
  const res = await fetch(s.gateway.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${s.gateway.token}`,
    },
    body: JSON.stringify({ message: text }),
  })
  if (!res.ok) throw new Error(`Gateway error: ${res.status}`)
  const data = await res.json()
  return data.reply || data.text || data.message || JSON.stringify(data)
}

export async function summarize(text: string, s: Settings): Promise<string> {
  const res = await fetch(`${s.llm.baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${s.llm.apiKey}`,
    },
    body: JSON.stringify({
      model: s.llm.model,
      messages: [
        { role: 'system', content: '用一两句话简洁地总结以下内容，保留关键信息：' },
        { role: 'user', content: text },
      ],
      max_tokens: 200,
    }),
  })
  if (!res.ok) throw new Error(`LLM error: ${res.status}`)
  const data = await res.json()
  return data.choices?.[0]?.message?.content || text
}

export async function textToSpeech(text: string, s: Settings): Promise<ArrayBuffer> {
  const res = await fetch(`${s.tts.baseURL}/audio/speech`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${s.tts.apiKey}`,
    },
    body: JSON.stringify({ model: 'tts-1', input: text, voice: s.tts.voice }),
  })
  if (!res.ok) throw new Error(`TTS error: ${res.status}`)
  return res.arrayBuffer()
}

export async function playAudio(buffer: ArrayBuffer) {
  const ctx = new AudioContext()
  const decoded = await ctx.decodeAudioData(buffer)
  const source = ctx.createBufferSource()
  source.buffer = decoded
  source.connect(ctx.destination)
  source.start()
  return new Promise<void>((resolve) => { source.onended = () => resolve() })
}
