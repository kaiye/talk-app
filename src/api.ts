import { DEFAULT_SETTINGS, type Settings } from './settings'
import {
  buildGatewayDeviceAuth,
  DEFAULT_GATEWAY_SESSION_KEY,
  getGatewayErrorInfo,
  getGatewayErrorMessage,
  OPERATOR_SCOPES,
  parseGatewayChatPayload,
} from './gatewayProtocol'

const readApiErrorMessage = async (res: Response): Promise<string | null> => {
  try {
    const data = await res.json()
    const msg =
      (typeof data?.message === 'string' && data.message) ||
      (typeof data?.error?.message === 'string' && data.error.message) ||
      (typeof data?.error === 'string' && data.error) ||
      null
    return msg ? msg.trim() : null
  } catch {
    try {
      const text = (await res.text()).trim()
      return text || null
    } catch {
      return null
    }
  }
}

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
    const gatewayUrl = typeof s.gateway.url === 'string' ? s.gateway.url.trim() : ''
    const gatewayToken = typeof s.gateway.token === 'string' ? s.gateway.token.trim() : ''
    if (!gatewayUrl) {
      reject(new Error('Gateway URL 为空，请在设置中填写 wss://... 地址'))
      return
    }
    if (!/^wss?:\/\//i.test(gatewayUrl)) {
      reject(new Error(`Gateway URL 非法：${gatewayUrl}（必须以 ws:// 或 wss:// 开头）`))
      return
    }

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
      ws = new WebSocket(gatewayUrl)
    } catch (err) {
      finish(() =>
        reject(
          err instanceof Error
            ? err
            : new Error(`Gateway connection failed (${gatewayUrl})`)
        )
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

      if (data?.type === 'error') {
        finish(() => reject(new Error(getGatewayErrorMessage(data))))
        return
      }

      if (data?.type === 'event' && data?.event === 'connect.challenge') {
        if (connectSent) return
        connectSent = true
        const requestedScopes = [...OPERATOR_SCOPES]
        const nonce = typeof data?.payload?.nonce === 'string' ? data.payload.nonce : ''
        void (async () => {
          try {
            const device = await buildGatewayDeviceAuth({
              clientId: 'webchat-ui',
              clientMode: 'ui',
              role: 'operator',
              scopes: requestedScopes,
              token: gatewayToken || null,
              nonce,
            })
            if (settled || ws?.readyState !== WebSocket.OPEN) return
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
                scopes: requestedScopes,
                caps: [],
                commands: [],
                permissions: {},
                auth: { token: gatewayToken },
                locale: 'zh-CN',
                userAgent: 'haji-voice/1.0.0',
                device,
              },
            })
          } catch (err) {
            finish(() =>
              reject(
                err instanceof Error ? err : new Error('Gateway connect send failed')
              )
            )
          }
        })()
        return
      }

      if (data?.type === 'res' && data?.id === connectReqId) {
        if (!data?.ok) {
          const info = getGatewayErrorInfo(data, 'Gateway connect failed')
          const code = (info.code || '').toUpperCase()
          const detailCode = (info.detailCode || '').toUpperCase()
          const pairingRequired =
            code === 'NOT_PAIRED' ||
            detailCode === 'PAIRING_REQUIRED' ||
            info.message.toLowerCase().includes('pairing required')
          if (pairingRequired) {
            const requestHint = info.requestId ? `（requestId: ${info.requestId}）` : ''
            finish(() =>
              reject(
                new Error(
                  `网关要求先配对设备${requestHint}。请在网关机器执行：openclaw devices approve --latest`
                )
              )
            )
          } else {
            finish(() => reject(new Error(info.message)))
          }
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
              sessionKey: DEFAULT_GATEWAY_SESSION_KEY,
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
          finish(() => reject(new Error(getGatewayErrorMessage(data, 'Gateway chat.send failed'))))
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
        const parsed = parseGatewayChatPayload(payload)
        const eventRunId = parsed.runId
        if (runId && eventRunId && runId !== eventRunId) return
        if (!runId && eventRunId) runId = eventRunId
        if (parsed.state === 'delta') {
          if (parsed.text) buffer = parsed.text
          return
        }
        if (parsed.state === 'aborted') {
          finish(() => reject(new Error('Gateway response aborted')))
          return
        }
        if (parsed.state === 'error') {
          finish(() => reject(new Error(parsed.errorMessage || 'Gateway response failed')))
          return
        }
        if (parsed.state === 'final') {
          const reply = (parsed.text || buffer).trim()
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
        {
          role: 'system',
          content:
            '用一两句话简洁总结以下内容，保留关键信息。若原文包含问题、反问或需要用户确认的问句，必须原样保留问题意图与问句语气，不要改写成陈述句。',
        },
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
  const model = s.tts.model.trim() || DEFAULT_SETTINGS.tts.model
  const voice = s.tts.voice.trim() || DEFAULT_SETTINGS.tts.voice
  const speed = Number.isFinite(s.tts.speed)
    ? Math.min(4, Math.max(0.25, s.tts.speed))
    : DEFAULT_SETTINGS.tts.speed
  const gain = Number.isFinite(s.tts.gain)
    ? Math.min(10, Math.max(-10, s.tts.gain))
    : DEFAULT_SETTINGS.tts.gain
  const res = await fetch(`${s.tts.baseURL}/audio/speech`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${s.tts.apiKey}`,
    },
    body: JSON.stringify({ model, input: text, voice, speed, gain }),
    signal,
  })
  if (!res.ok) {
    const detail = await readApiErrorMessage(res)
    throw new Error(detail ? `TTS error: ${res.status} - ${detail}` : `TTS error: ${res.status}`)
  }
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
