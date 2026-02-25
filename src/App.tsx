import { useState, useRef, useCallback, useEffect } from 'react'
import SettingsPage from './SettingsPage'
import { loadSettings } from './settings'
import { transcribeAudio, summarize, textToSpeech, playAudio } from './api'
import {
  buildGatewayDeviceAuth,
  DEFAULT_GATEWAY_SESSION_KEY,
  getGatewayErrorInfo,
  getGatewayErrorMessage,
  OPERATOR_SCOPES,
  parseGatewayChatPayload,
} from './gatewayProtocol'
import * as vadWeb from '@ricky0123/vad-web'
import type { MicVAD as MicVADType } from '@ricky0123/vad-web'
import * as ort from 'onnxruntime-web'

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected'
type LoopStatus = 'idle' | 'listening' | 'recognizing' | 'thinking' | 'speaking'

type Message = { id: string; role: 'user' | 'ai'; text: string }

type PlaybackController = { stop: () => void; done: Promise<void> }

type PendingChat = {
  resolve: (text: string) => void
  reject: (err: Error) => void
  timeoutId: number
  reqId: string
  runId?: string
  buffer: string
}

const LOOP_STATUS_LABEL: Record<LoopStatus, string> = {
  listening: '监听中',
  recognizing: '识别中',
  thinking: '思考中',
  speaking: '播报中',
  idle: '未连接',
}

const STORAGE_KEY = 'talk-app-messages'
const MAX_MESSAGES = 10

const createMessageId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const normalizeMessages = (input: unknown): Message[] => {
  if (!Array.isArray(input)) return []
  const normalized: Message[] = []
  for (const item of input) {
    if (!item || typeof item !== 'object') continue
    const role = (item as any).role
    const text = (item as any).text
    if ((role !== 'user' && role !== 'ai') || typeof text !== 'string') continue
    const id = typeof (item as any).id === 'string' ? (item as any).id : createMessageId()
    normalized.push({ id, role, text })
  }
  return normalized.slice(-MAX_MESSAGES)
}

const nextReconnectDelay = (attempt: number) => Math.min(1000 * 2 ** attempt, 30000)

export default function App() {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected')
  const [loopStatus, setLoopStatus] = useState<LoopStatus>('idle')
  const [messages, setMessages] = useState<Message[]>([])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [showSettings, setShowSettings] = useState(false)
  const [verboseNext, setVerboseNext] = useState(false)
  const [error, setError] = useState('')
  const [vadAvailable, setVadAvailable] = useState(true)
  const [gatewayUrlHint, setGatewayUrlHint] = useState(() => loadSettings().gateway.url.trim())

  const mediaRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const lastAudioRef = useRef<ArrayBuffer | null>(null)
  const abortRef = useRef(false)
  const playbackRef = useRef<PlaybackController | null>(null)
  const loopStatusRef = useRef<LoopStatus>('idle')
  const activeRunIdRef = useRef(0)
  const abortControllersRef = useRef<{ asr?: AbortController; llm?: AbortController; tts?: AbortController }>({})

  const wsRef = useRef<WebSocket | null>(null)
  const connectSentRef = useRef(false)
  const connectedRef = useRef(false)
  const pendingChatRef = useRef<PendingChat | null>(null)
  const disconnectRequestedRef = useRef(false)
  const reconnectAttemptRef = useRef(0)
  const reconnectTimerRef = useRef<number | null>(null)
  const connectGatewayRef = useRef<() => void>(() => {})

  const vadRef = useRef<MicVADType | null>(null)

  const addMsg = (role: 'user' | 'ai', text: string) =>
    setMessages(prev => {
      const next = [...prev, { id: createMessageId(), role, text }]
      return next.slice(-MAX_MESSAGES)
    })

  const playSendBeep = useCallback(() => {
    try {
      const ctx = new AudioContext()
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(1160, ctx.currentTime)
      gain.gain.setValueAtTime(0.0001, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.14)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start()
      osc.stop(ctx.currentTime + 0.14)
      osc.onended = () => {
        void ctx.close()
      }
    } catch {
      // ignore beep errors
    }
  }, [])

  useEffect(() => {
    loopStatusRef.current = loopStatus
  }, [loopStatus])

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return
    try {
      const parsed = JSON.parse(stored)
      setMessages(normalizeMessages(parsed))
    } catch {
      // Ignore malformed storage.
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(messages))
  }, [messages])

  useEffect(() => {
    if (messages.length === 0) {
      setExpanded({})
      return
    }
    const validIds = new Set(messages.map(m => m.id))
    setExpanded(prev => {
      const next: Record<string, boolean> = {}
      for (const id of Object.keys(prev)) {
        if (validIds.has(id)) next[id] = prev[id]
      }
      return next
    })
  }, [messages])

  useEffect(() => {
    if (!showSettings) {
      setGatewayUrlHint(loadSettings().gateway.url.trim())
    }
  }, [showSettings])

  useEffect(() => {
    return () => {
      disconnectRequestedRef.current = true
      clearReconnectTimer()
      disconnectGateway()
      void stopVad(true)
      stopPlayback()
    }
  }, [])

  const clearReconnectTimer = () => {
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
  }

  const stopPlayback = () => {
    if (playbackRef.current) {
      playbackRef.current.stop()
      playbackRef.current = null
    }
  }

  const cancelInFlight = (reason?: string) => {
    abortRef.current = true
    abortControllersRef.current.asr?.abort(reason)
    abortControllersRef.current.llm?.abort(reason)
    abortControllersRef.current.tts?.abort(reason)
    abortControllersRef.current = {}
    if (pendingChatRef.current) {
      const pending = pendingChatRef.current
      pendingChatRef.current = null
      window.clearTimeout(pending.timeoutId)
      pending.reject(new Error(reason || 'Request canceled'))
    }
  }

  const handleVoiceCommand = (text: string): boolean => {
    if (text.includes('详细播报')) {
      setVerboseNext(true)
      return true
    }
    if (text.includes('停止') || text.includes('算了')) {
      cancelInFlight('User canceled')
      stopPlayback()
      return true
    }
    if (text.includes('重复一遍') && lastAudioRef.current) {
      setLoopStatus('speaking')
      const playback = playAudio(lastAudioRef.current)
      playbackRef.current = playback
      playback.done.finally(() => {
        playbackRef.current = null
        if (connectedRef.current) setLoopStatus('listening')
      })
      return true
    }
    return false
  }

  const sendGatewayMessage = useCallback((text: string) => {
    return new Promise<string>((resolve, reject) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !connectedRef.current) {
        reject(new Error('Gateway not connected'))
        return
      }
      if (pendingChatRef.current) {
        reject(new Error('Gateway is busy'))
        return
      }

      const chatReqId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`
      const idempotencyKey =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `msg_${Date.now()}_${Math.random().toString(16).slice(2)}`

      const timeoutId = window.setTimeout(() => {
        if (pendingChatRef.current) {
          pendingChatRef.current = null
          reject(new Error('Gateway timeout after 30s'))
        }
      }, 30000)

      pendingChatRef.current = { resolve, reject, timeoutId, reqId: chatReqId, buffer: '' }

      try {
        wsRef.current.send(
          JSON.stringify({
            type: 'req',
            id: chatReqId,
            method: 'chat.send',
            params: {
              sessionKey: DEFAULT_GATEWAY_SESSION_KEY,
              message: text,
              idempotencyKey,
            },
          })
        )
        playSendBeep()
      } catch (err) {
        window.clearTimeout(timeoutId)
        pendingChatRef.current = null
        reject(err instanceof Error ? err : new Error('Gateway message send failed'))
      }
    })
  }, [playSendBeep])

  const processAudio = useCallback(
    async (blob: Blob) => {
      const runId = ++activeRunIdRef.current
      const s = loadSettings()
      abortRef.current = false
      try {
        setLoopStatus('recognizing')
        const asrController = new AbortController()
        abortControllersRef.current.asr = asrController
        const text = await transcribeAudio(blob, s, asrController.signal)
        if (runId !== activeRunIdRef.current || abortRef.current) return
        if (!text.trim()) {
          if (connectedRef.current) setLoopStatus('listening')
          return
        }
        addMsg('user', text)
        if (handleVoiceCommand(text)) {
          if (connectedRef.current) setLoopStatus('listening')
          return
        }

        setLoopStatus('thinking')
        const reply = await sendGatewayMessage(text)
        if (runId !== activeRunIdRef.current || abortRef.current) return

        addMsg('ai', reply)
        const verbose = verboseNext
        setVerboseNext(false)
        let toSpeak = reply
        const shouldSummarize = !verbose && reply.trim().length > s.summary.thresholdChars
        if (shouldSummarize) {
          const llmController = new AbortController()
          abortControllersRef.current.llm = llmController
          try {
            const summarized = await summarize(reply, s, llmController.signal)
            if (summarized.trim()) toSpeak = summarized.trim()
          } catch (err) {
            if (llmController.signal.aborted || abortRef.current || runId !== activeRunIdRef.current) {
              throw err
            }
            toSpeak = reply
          }
        }
        if (runId !== activeRunIdRef.current || abortRef.current) return

        setLoopStatus('speaking')
        const ttsController = new AbortController()
        abortControllersRef.current.tts = ttsController
        const audio = await textToSpeech(toSpeak, s, ttsController.signal)
        if (runId !== activeRunIdRef.current || abortRef.current) return
        lastAudioRef.current = audio
        const playback = playAudio(audio)
        playbackRef.current = playback
        await playback.done
      } catch (e: any) {
        if (!abortRef.current) setError(e.message)
      } finally {
        playbackRef.current = null
        abortControllersRef.current = {}
        if (connectedRef.current) setLoopStatus('listening')
        else setLoopStatus('idle')
      }
    },
    [sendGatewayMessage, verboseNext]
  )

  const startManualListening = async () => {
    setError('')
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const mr = new MediaRecorder(stream)
    chunksRef.current = []
    mr.ondataavailable = e => chunksRef.current.push(e.data)
    mr.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
      stream.getTracks().forEach(t => t.stop())
      void processAudio(blob)
    }
    mr.start()
    mediaRef.current = mr
    setLoopStatus('listening')
  }

  const stopManualListening = () => {
    mediaRef.current?.stop()
    mediaRef.current = null
  }

  const toggleManualListen = () => {
    if (loopStatus === 'listening') stopManualListening()
    else if (connectionStatus === 'connected') void startManualListening()
  }

  const handleToggleMessage = (id: string) =>
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }))
  const handleClearHistory = () => {
    setMessages([])
    localStorage.removeItem(STORAGE_KEY)
  }

  const handleSpeechStart = useCallback(() => {
    if (!connectedRef.current) return
    // Only allow barge-in while currently speaking. During thinking/recognizing,
    // false-positive VAD starts could cancel a valid turn before TTS is requested.
    if (loopStatusRef.current !== 'speaking') return
    stopPlayback()
    cancelInFlight('Interrupted by speech')
    setLoopStatus('listening')
  }, [])

  const handleSpeechEnd = useCallback(
    (audio: Float32Array) => {
      if (!connectedRef.current) return
      const wav = vadWeb.utils.encodeWAV(audio, 1, 16000, 1, 16)
      const blob = new Blob([wav], { type: 'audio/wav' })
      void processAudio(blob)
    },
    [processAudio]
  )

  const initVad = useCallback(async () => {
    if (vadRef.current) return
    try {
      const assetBasePath = import.meta.env.BASE_URL
      const onnxWasmBasePath = import.meta.env.DEV
        ? `${assetBasePath}node_modules/onnxruntime-web/dist/`
        : assetBasePath

      ort.env.wasm.wasmPaths = onnxWasmBasePath
      const vad = await vadWeb.MicVAD.new({
        startOnLoad: false,
        baseAssetPath: assetBasePath,
        onnxWASMBasePath: onnxWasmBasePath,
        onSpeechStart: handleSpeechStart,
        onSpeechEnd: handleSpeechEnd,
      })
      vadRef.current = vad
      setVadAvailable(true)
    } catch (err: any) {
      setVadAvailable(false)
      setError(err?.message || 'VAD 初始化失败，已切换到手动模式')
    }
  }, [handleSpeechEnd, handleSpeechStart])

  const startVad = useCallback(async () => {
    if (!vadAvailable) return
    if (!vadRef.current) {
      await initVad()
    }
    if (vadRef.current) {
      await vadRef.current.start()
      setLoopStatus('listening')
    }
  }, [initVad, vadAvailable])

  const stopVad = useCallback(async (destroy?: boolean) => {
    if (!vadRef.current) return
    if (destroy) {
      await vadRef.current.destroy()
      vadRef.current = null
      return
    }
    await vadRef.current.pause()
  }, [])

  const scheduleReconnect = useCallback(() => {
    if (disconnectRequestedRef.current) return
    clearReconnectTimer()
    const delay = nextReconnectDelay(reconnectAttemptRef.current)
    reconnectAttemptRef.current += 1
    reconnectTimerRef.current = window.setTimeout(() => {
      if (!disconnectRequestedRef.current) connectGatewayRef.current()
    }, delay)
  }, [])

  const handleGatewayClose = useCallback(
    (event?: CloseEvent) => {
      connectedRef.current = false
      connectSentRef.current = false
      cancelInFlight('Gateway connection closed')
      if (pendingChatRef.current) {
        const pending = pendingChatRef.current
        pendingChatRef.current = null
        window.clearTimeout(pending.timeoutId)
        pending.reject(new Error('Gateway connection closed'))
      }
      if (disconnectRequestedRef.current) {
        setConnectionStatus('disconnected')
        setLoopStatus('idle')
        return
      }
      if (event && event.code === 1008) {
        setConnectionStatus('disconnected')
        setLoopStatus('idle')
        void stopVad()
        return
      }
      setConnectionStatus('connecting')
      setLoopStatus('idle')
      if (event && event.code !== 1000) {
        setError(`Gateway connection closed: ${event.code}`)
      }
      void stopVad()
      scheduleReconnect()
    },
    [scheduleReconnect, stopVad]
  )

  const connectGateway = useCallback(() => {
    if (connectionStatus === 'connected' || connectionStatus === 'connecting') return
    const s = loadSettings()
    const gatewayUrl = typeof s.gateway.url === 'string' ? s.gateway.url.trim() : ''
    const gatewayToken = typeof s.gateway.token === 'string' ? s.gateway.token.trim() : ''
    setGatewayUrlHint(gatewayUrl)
    if (!gatewayUrl) {
      setError('Gateway URL 为空，请在设置中填写 wss://... 地址')
      setConnectionStatus('disconnected')
      return
    }
    if (!/^wss?:\/\//i.test(gatewayUrl)) {
      setError(`Gateway URL 非法：${gatewayUrl}（必须以 ws:// 或 wss:// 开头）`)
      setConnectionStatus('disconnected')
      return
    }
    disconnectRequestedRef.current = false
    setError('')
    setConnectionStatus('connecting')
    setLoopStatus('idle')
    const instanceId = Math.random().toString(16).slice(2, 6)

    let ws: WebSocket
    try {
      ws = new WebSocket(gatewayUrl)
    } catch (err: any) {
      setError((err?.message || 'Gateway connection failed') + ` (${gatewayUrl})`)
      setConnectionStatus('disconnected')
      return
    }

    wsRef.current = ws

    ws.onopen = () => {}

    ws.onerror = () => {
      setError(`Gateway connection error (${gatewayUrl})`)
    }

    ws.onclose = event => {
      handleGatewayClose(event)
    }

    ws.onmessage = event => {
      let data: any = null
      try {
        data = JSON.parse(event.data)
      } catch {
        setError('Gateway returned non-JSON response')
        return
      }

      if (data?.type === 'error') {
        setError(getGatewayErrorMessage(data))
        return
      }

      if (data?.type === 'event' && data?.event === 'connect.challenge') {
        if (connectSentRef.current) return
        connectSentRef.current = true
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
            if (ws.readyState !== WebSocket.OPEN) return
            ws.send(
              JSON.stringify({
                type: 'req',
                id: '1',
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
            )
          } catch (err: any) {
            connectSentRef.current = false
            disconnectRequestedRef.current = true
            setConnectionStatus('disconnected')
            setLoopStatus('idle')
            setError(err?.message || 'Gateway connect send failed')
            try {
              ws.close(1008, 'connect auth failed')
            } catch {
              // ignore
            }
          }
        })()
        return
      }

      if (data?.type === 'res' && data?.id === '1') {
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
            setError(
              `网关要求先配对设备${requestHint}。请在网关机器执行：openclaw devices approve --latest`
            )
          } else {
            setError(info.message)
          }
          disconnectRequestedRef.current = true
          connectedRef.current = false
          connectSentRef.current = false
          setConnectionStatus('disconnected')
          setLoopStatus('idle')
          try {
            ws.close(1008, 'connect rejected')
          } catch {
            // ignore
          }
          return
        }
        if (data?.payload?.type !== 'hello-ok') {
          setError('Gateway hello handshake failed')
          return
        }
        connectedRef.current = true
        reconnectAttemptRef.current = 0
        setConnectionStatus('connected')
        void startVad()
        return
      }

      if (data?.type === 'res' && pendingChatRef.current?.reqId === data?.id) {
        if (!data?.ok) {
          const pending = pendingChatRef.current
          if (!pending) return
          pendingChatRef.current = null
          window.clearTimeout(pending.timeoutId)
          pending.reject(new Error(getGatewayErrorMessage(data, 'Gateway chat.send failed')))
          return
        }
        if (typeof data?.payload?.runId === 'string' && pendingChatRef.current) {
          pendingChatRef.current.runId = data.payload.runId
        }
        return
      }

      if (data?.type === 'event' && data?.event === 'chat') {
        const payload = data?.payload
        if (!payload || !pendingChatRef.current) return
        const parsed = parseGatewayChatPayload(payload)
        const eventRunId = parsed.runId
        if (pendingChatRef.current.runId && eventRunId && pendingChatRef.current.runId !== eventRunId) {
          return
        }
        if (!pendingChatRef.current.runId && eventRunId) {
          pendingChatRef.current.runId = eventRunId
        }
        if (parsed.state === 'delta') {
          if (parsed.text) pendingChatRef.current.buffer = parsed.text
          return
        }
        if (parsed.state === 'aborted') {
          const pending = pendingChatRef.current
          if (!pending) return
          pendingChatRef.current = null
          window.clearTimeout(pending.timeoutId)
          pending.reject(new Error('Gateway response aborted'))
          return
        }
        if (parsed.state === 'error') {
          const pending = pendingChatRef.current
          if (!pending) return
          pendingChatRef.current = null
          window.clearTimeout(pending.timeoutId)
          pending.reject(new Error(parsed.errorMessage || 'Gateway response failed'))
          return
        }
        if (parsed.state === 'final') {
          const pending = pendingChatRef.current
          if (!pending) return
          pendingChatRef.current = null
          window.clearTimeout(pending.timeoutId)
          const reply = (parsed.text || pending.buffer).trim()
          if (reply) pending.resolve(reply)
          else pending.reject(new Error('Gateway response missing reply text'))
        }
      }
    }
  }, [connectionStatus, handleGatewayClose, startVad])

  useEffect(() => {
    connectGatewayRef.current = connectGateway
  }, [connectGateway])

  const disconnectGateway = useCallback(() => {
    disconnectRequestedRef.current = true
    clearReconnectTimer()
    reconnectAttemptRef.current = 0
    connectedRef.current = false
    connectSentRef.current = false
    cancelInFlight('Gateway disconnected')
    stopPlayback()
    if (pendingChatRef.current) {
      const pending = pendingChatRef.current
      pendingChatRef.current = null
      window.clearTimeout(pending.timeoutId)
      pending.reject(new Error('Gateway disconnected'))
    }
    if (wsRef.current &&
      (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      wsRef.current.close()
    }
    wsRef.current = null
    setConnectionStatus('disconnected')
    setLoopStatus('idle')
    void stopVad()
  }, [stopVad])

  const toggleConnection = () => {
    if (connectionStatus === 'disconnected') connectGateway()
    else disconnectGateway()
  }

  const loopStatusLabel =
    connectionStatus === 'disconnected'
      ? '未连接'
      : connectionStatus === 'connecting'
        ? '连接中'
        : loopStatus === 'idle'
          ? '监听中'
          : LOOP_STATUS_LABEL[loopStatus]

  const manualMode = !vadAvailable

  return (
    <div className="relative h-[100dvh] overflow-hidden bg-background text-foreground">
      <div className="pointer-events-none absolute inset-0 opacity-40">
        <div className="absolute inset-0 bg-[linear-gradient(rgba(0,212,255,0.08)_1px,transparent_1px)] bg-[length:28px_28px]" />
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(0,212,255,0.06)_1px,transparent_1px)] bg-[length:28px_28px]" />
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[length:4px_4px]" />
      </div>

      {showSettings && <SettingsPage onClose={() => setShowSettings(false)} />}

      <div className="relative z-10 mx-auto flex h-full w-full max-w-5xl flex-col px-6">
        <header className="flex items-center justify-between py-6">
          <div>
            <p className="text-[10px] uppercase tracking-[0.35em] text-muted-foreground">
              Voice Companion
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">哈吉语音助手</h1>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleClearHistory}
              className="rounded-full border border-white/10 bg-card/60 px-3 py-2 text-[11px] text-muted-foreground transition hover:text-foreground"
            >
              清空记录
            </button>
            <button
              type="button"
              onClick={() => setShowSettings(true)}
              className="rounded-full border border-white/10 bg-card/60 px-3 py-2 text-xs uppercase tracking-[0.3em] text-muted-foreground transition hover:text-foreground"
            >
              ⚙ 设置
            </button>
          </div>
        </header>

        <main className="flex min-h-0 flex-1 flex-col gap-4 pb-6">
          <section className="rounded-2xl border border-white/10 bg-card/70 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
                Continuous
              </p>
              <span
                className={`rounded-full border px-3 py-1 text-[10px] uppercase tracking-[0.3em] ${
                  connectionStatus === 'connected'
                    ? 'border-accent/60 text-accent'
                    : 'border-white/10 text-muted-foreground'
                }`}
              >
                {loopStatusLabel}
              </span>
              {verboseNext && (
                <span className="rounded-full border border-white/10 px-3 py-1 text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
                  下次详细播报
                </span>
              )}
              {manualMode && (
                <span className="rounded-full border border-white/10 px-3 py-1 text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
                  手动模式
                </span>
              )}
              <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                网关：{gatewayUrlHint || '未配置'}
              </span>
              {manualMode && (
                <button
                  type="button"
                  onClick={toggleManualListen}
                  disabled={connectionStatus !== 'connected' || (loopStatus !== 'idle' && loopStatus !== 'listening')}
                  className={`rounded-full border px-3 py-1 text-[10px] uppercase tracking-[0.28em] transition ${
                    loopStatus === 'listening'
                      ? 'border-accent text-accent'
                      : 'border-white/10 text-muted-foreground'
                  } ${connectionStatus !== 'connected' ? 'opacity-50' : 'hover:text-foreground'}`}
                >
                  {loopStatus === 'listening' ? '结束录音' : '手动录音'}
                </button>
              )}
              <button
                type="button"
                onClick={toggleConnection}
                disabled={connectionStatus === 'connecting'}
                className={`relative rounded-full border px-5 py-2 text-xs font-semibold tracking-[0.3em] transition ${
                  connectionStatus === 'connected'
                    ? 'border-accent text-accent shadow-[0_0_24px_rgba(0,212,255,0.5)]'
                    : 'border-accent/60 text-accent/80'
                } ${connectionStatus === 'connecting' ? 'opacity-60' : 'hover:scale-[1.02]'}`}
              >
                {connectionStatus === 'connected' ? '断开' : '连接'}
              </button>
            </div>
            {error && (
              <div className="mt-2 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                {error}
              </div>
            )}
          </section>

          <section className="flex min-h-0 flex-1 flex-col rounded-2xl border border-white/10 bg-card/70 p-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
                  Conversation
                </p>
                <h2 className="mt-2 text-base font-semibold">对话记录</h2>
                <p className="mt-1 text-xs text-muted-foreground">最近 10 条信息</p>
              </div>
            </div>

            <div className="mt-4 min-h-0 flex-1 overflow-hidden">
              <div className="h-full overflow-y-auto pr-2">
                <div className="flex flex-col gap-4">
                  {messages.length === 0 && (
                    <div className="rounded-xl border border-dashed border-white/10 bg-background/40 p-6 text-center text-sm text-muted-foreground">
                      连接后自动进入监听，直接开口说话即可
                    </div>
                  )}
                  {messages.map(m => (
                    <div
                      key={m.id}
                      className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
                    >
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => handleToggleMessage(m.id)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' || e.key === ' ') handleToggleMessage(m.id)
                        }}
                        className={`max-w-[75%] rounded-xl border px-4 py-3 text-sm leading-relaxed ${
                          m.role === 'user'
                            ? 'border-accent/60 bg-accent/10 text-foreground'
                            : 'border-white/10 bg-background/40 text-foreground'
                        } cursor-pointer transition hover:border-white/20`}
                      >
                        <p className="mb-2 text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
                          {m.role === 'user' ? 'You' : 'AI'}
                        </p>
                        <p className={expanded[m.id] ? '' : 'message-clamp'}>{m.text}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>
        </main>
      </div>
    </div>
  )
}
