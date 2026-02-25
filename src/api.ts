import type { Settings } from './settings'

export async function transcribeAudio(
  blob: Blob,
  s: Settings,
  signal?: AbortSignal
): Promise<string> {
  const form = new FormData()
  const filename = blob.type === 'audio/wav' ? 'audio.wav' : 'audio.webm'
  form.append('file', blob, filename)
  form.append('model', s.asr.model)
  const res = await fetch(`${s.asr.baseURL}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${s.asr.apiKey}` },
    body: form,
    signal,
  })
  if (!res.ok) throw new Error(`ASR error: ${res.status}`)
  const data = await res.json()
  return data.text || ''
}

export async function sendToGateway(text: string, s: Settings): Promise<string> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket | null = null
    let connectSent = false
    let connected = false
    const connectReqId = '1'
    const chatReqId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `chat_${Date.now()}_${Math.random().toString(16).slice(2)}`
    const idempotencyKey =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `msg_${Date.now()}_${Math.random().toString(16).slice(2)}`
    const instanceId = Math.random().toString(16).slice(2, 6)
    let runId = ''
    let buffer = ''
    let settled = false

    const sendFrame = (payload: unknown) => {
      ws?.send(JSON.stringify(payload))
    }

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close()
      }
      fn()
    }

    const timeoutId = window.setTimeout(() => {
      finish(() => reject(new Error('Gateway timeout after 30s')))
    }, 30000)

    try {
      ws = new WebSocket(s.gateway.url)
    } catch (err) {
      finish(() =>
        reject(err instanceof Error ? err : new Error('Gateway connection failed'))
      )
      return
    }

    ws.onopen = () => {}

    ws.onerror = () => {
      finish(() => reject(new Error('Gateway connection error')))
    }

    ws.onclose = event => {
      if (!settled) {
        finish(() => reject(new Error(`Gateway connection closed: ${event.code}`)))
      }
    }

    ws.onmessage = event => {
      let data: any = null
      try {
        data = JSON.parse(event.data)
      } catch {
        finish(() => reject(new Error('Gateway returned non-JSON response')))
        return
      }

      if (data?.type === 'error' || data?.error) {
        finish(() =>
          reject(new Error(data?.message || data?.error || 'Gateway error'))
        )
        return
      }

      if (data?.type === 'event' && data?.event === 'connect.challenge') {
        if (connectSent) return
        connectSent = true
        try {
          sendFrame({
            type: 'req',
            id: connectReqId,
            method: 'connect',
            params: {
              minProtocol: 3,
              maxProtocol: 3,
              client: {
                id: 'webchat-ui',
                displayName: 'Haji Voice',
                version: '1.0.0',
                platform: 'web',
                mode: 'ui',
                instanceId,
              },
              role: 'operator',
              scopes: ['operator.read', 'operator.write'],
              caps: [],
              commands: [],
              permissions: {},
              auth: { token: s.gateway.token },
              locale: 'zh-CN',
              userAgent: 'haji-voice/1.0.0',
            },
          })
        } catch {
          finish(() => reject(new Error('Gateway connect send failed')))
        }
        return
      }

      if (data?.type === 'res' && data?.id === connectReqId) {
        if (!data?.ok) {
          finish(() => reject(new Error(data?.error?.message || 'Gateway connect failed')))
          return
        }
        if (data?.payload?.type !== 'hello-ok') {
          finish(() => reject(new Error('Gateway hello handshake failed')))
          return
        }
        connected = true
        try {
          sendFrame({
            type: 'req',
            id: chatReqId,
            method: 'chat.send',
            params: {
              message: text,
              idempotencyKey,
            },
          })
        } catch {
          finish(() => reject(new Error('Gateway message send failed')))
        }
        return
      }

      if (data?.type === 'res' && data?.id === chatReqId) {
        if (!data?.ok) {
          finish(() => reject(new Error(data?.error?.message || 'Gateway chat.send failed')))
          return
        }
        if (typeof data?.payload?.runId === 'string') {
          runId = data.payload.runId
        }
        return
      }

      if (data?.type === 'event' && data?.event === 'chat') {
        const payload = data?.payload
        if (!payload) return
        const eventRunId = typeof payload.runId === 'string' ? payload.runId : ''
        if (runId && eventRunId && runId !== eventRunId) return
        if (!runId && eventRunId) runId = eventRunId
        if (payload.type === 'delta' && typeof payload.text === 'string') {
          buffer += payload.text
          return
        }
        if (payload.type === 'done') {
          const reply = buffer.trim()
          if (reply) {
            finish(() => resolve(reply))
            return
          }
          finish(() => reject(new Error('Gateway response missing reply text')))
        }
      }

      if (!connected) return
    }
  })
}

export async function summarize(
  text: string,
  s: Settings,
  signal?: AbortSignal
): Promise<string> {
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
    signal,
  })
  if (!res.ok) throw new Error(`LLM error: ${res.status}`)
  const data = await res.json()
  return data.choices?.[0]?.message?.content || text
}

export async function textToSpeech(
  text: string,
  s: Settings,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  const res = await fetch(`${s.tts.baseURL}/audio/speech`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${s.tts.apiKey}`,
    },
    body: JSON.stringify({ model: 'tts-1', input: text, voice: s.tts.voice }),
    signal,
  })
  if (!res.ok) throw new Error(`TTS error: ${res.status}`)
  return res.arrayBuffer()
}

export function playAudio(buffer: ArrayBuffer): { stop: () => void; done: Promise<void> } {
  const ctx = new AudioContext()
  let source: AudioBufferSourceNode | null = null
  let stopped = false
  let resolveDone: (() => void) | null = null

  const done = new Promise<void>(resolve => {
    resolveDone = resolve
  })

  const stop = () => {
    if (stopped) return
    stopped = true
    try {
      source?.stop()
    } catch {
      // ignore
    }
    void ctx.close()
    resolveDone?.()
  }

  void ctx.decodeAudioData(buffer).then(decoded => {
    if (stopped) {
      resolveDone?.()
      return
    }
    source = ctx.createBufferSource()
    source.buffer = decoded
    source.connect(ctx.destination)
    source.onended = () => {
      if (stopped) return
      resolveDone?.()
      void ctx.close()
    }
    if (stopped) {
      resolveDone?.()
      return
    }
    source.start()
  })

  return { stop, done }
}
