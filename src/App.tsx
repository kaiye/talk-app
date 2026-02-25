import { useState, useRef, useCallback, useEffect } from 'react'
import SettingsPage from './SettingsPage'
import { loadSettings } from './settings'
import { transcribeAudio, sendToGateway, summarize, textToSpeech, playAudio } from './api'

type Status = 'idle' | 'listening' | 'recognizing' | 'thinking' | 'speaking'

type Message = { id: string; role: 'user' | 'ai'; text: string }

const STATUS_LABEL: Record<Status, string> = {
  idle: '点击开始',
  listening: '监听中...',
  recognizing: '识别中...',
  thinking: '思考中...',
  speaking: '播报中...',
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


export default function App() {
  const [status, setStatus] = useState<Status>('idle')
  const [messages, setMessages] = useState<Message[]>([])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [showSettings, setShowSettings] = useState(false)
  const [verboseNext, setVerboseNext] = useState(false)
  const [error, setError] = useState('')
  const mediaRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const lastAudioRef = useRef<ArrayBuffer | null>(null)
  const abortRef = useRef(false)

  const addMsg = (role: 'user' | 'ai', text: string) =>
    setMessages(prev => {
      const next = [...prev, { id: createMessageId(), role, text }]
      return next.slice(-MAX_MESSAGES)
    })

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

  const handleVoiceCommand = (text: string): boolean => {
    if (text.includes('详细播报')) {
      setVerboseNext(true)
      return true
    }
    if (text.includes('停止') || text.includes('算了')) {
      abortRef.current = true
      return true
    }
    if (text.includes('重复一遍') && lastAudioRef.current) {
      setStatus('speaking')
      playAudio(lastAudioRef.current).then(() => setStatus('idle'))
      return true
    }
    return false
  }

  const process = useCallback(
    async (blob: Blob) => {
      const s = loadSettings()
      abortRef.current = false
      try {
        setStatus('recognizing')
        const text = await transcribeAudio(blob, s)
        if (!text.trim()) {
          setStatus('idle')
          return
        }
        addMsg('user', text)
        if (handleVoiceCommand(text)) {
          setStatus('idle')
          return
        }

        setStatus('thinking')
        const reply = await sendToGateway(text, s)
        if (abortRef.current) {
          setStatus('idle')
          return
        }

        const verbose = verboseNext
        setVerboseNext(false)
        const toSpeak = verbose ? reply : await summarize(reply, s)
        addMsg('ai', toSpeak)

        setStatus('speaking')
        const audio = await textToSpeech(toSpeak, s)
        lastAudioRef.current = audio
        await playAudio(audio)
      } catch (e: any) {
        setError(e.message)
      } finally {
        setStatus('idle')
      }
    },
    [verboseNext]
  )

  const startListening = async () => {
    setError('')
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const mr = new MediaRecorder(stream)
    chunksRef.current = []
    mr.ondataavailable = e => chunksRef.current.push(e.data)
    mr.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
      stream.getTracks().forEach(t => t.stop())
      process(blob)
    }
    mr.start()
    mediaRef.current = mr
    setStatus('listening')
  }

  const stopListening = () => {
    mediaRef.current?.stop()
    mediaRef.current = null
  }

  const toggleListen = () => {
    if (status === 'listening') stopListening()
    else if (status === 'idle') startListening()
  }

  const isActive = status !== 'idle'
  const handleToggleMessage = (id: string) =>
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }))
  const handleClearHistory = () => {
    setMessages([])
    localStorage.removeItem(STORAGE_KEY)
  }

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
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">哄娃助手</h1>
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
          <section className="flex min-h-0 flex-1 flex-col rounded-2xl border border-white/10 bg-card/70 p-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
                  Conversation
                </p>
                <h2 className="mt-2 text-base font-semibold">对话记录</h2>
                <p className="mt-1 text-xs text-muted-foreground">最近 10 条信息</p>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`rounded-full border px-3 py-1 text-[10px] uppercase tracking-[0.3em] ${
                    status === 'idle'
                      ? 'border-white/10 text-muted-foreground'
                      : 'border-accent/60 text-accent'
                  }`}
                >
                  {STATUS_LABEL[status]}
                </span>
                {verboseNext && (
                  <span className="rounded-full border border-white/10 px-3 py-1 text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
                    下次详细播报
                  </span>
                )}
              </div>
            </div>

            <div className="mt-4 min-h-0 flex-1 overflow-hidden">
              <div className="h-full overflow-y-auto pr-2">
                <div className="flex flex-col gap-4">
                  {messages.length === 0 && (
                    <div className="rounded-xl border border-dashed border-white/10 bg-background/40 p-6 text-center text-sm text-muted-foreground">
                      点击下方按钮开始说话
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

            {error && (
              <div className="mt-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                {error}
              </div>
            )}
          </section>

          <section className="flex items-center justify-between rounded-2xl border border-white/10 bg-card/70 px-6 py-4">
            <div>
              <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
                Status
              </p>
              <div
                className={`mt-2 inline-flex items-center rounded-full border px-3 py-1 text-[11px] uppercase tracking-[0.3em] ${
                  isActive ? 'border-accent/60 text-accent' : 'border-white/10 text-muted-foreground'
                }`}
              >
                {STATUS_LABEL[status]}
              </div>
            </div>
            <div className="flex flex-col items-center gap-3">
              <button
                type="button"
                onClick={toggleListen}
                disabled={isActive && status !== 'listening'}
                className={`flex h-20 w-20 items-center justify-center rounded-full border text-2xl transition ${
                  status === 'listening'
                    ? 'border-accent text-accent shadow-[0_0_35px_rgba(0,212,255,0.7)]'
                    : 'border-accent/60 text-accent/80 shadow-[0_0_20px_rgba(0,212,255,0.35)]'
                } ${isActive && status !== 'listening' ? 'opacity-60' : 'hover:scale-[1.02]'}`}
              >
                {status === 'listening' ? '■' : '●'}
              </button>
              <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
                点击开始/结束
              </p>
            </div>
          </section>
        </main>
      </div>
    </div>
  )
}
