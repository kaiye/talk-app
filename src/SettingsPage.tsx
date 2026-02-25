import React from 'react'
import type { Settings } from './settings'
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './settings'

interface Props {
  onClose: () => void
}

export default function SettingsPage({ onClose }: Props) {
  const [s, setS] = React.useState<Settings>(loadSettings)
  const [toast, setToast] = React.useState<{ type: 'success' | 'error'; text: string } | null>(
    null
  )
  const [helpOpen, setHelpOpen] = React.useState(false)

  function update(path: string, value: string | number) {
    const [section, key] = path.split('.')
    setS(prev => ({ ...prev, [section]: { ...(prev as any)[section], [key]: value } }))
  }

  function parseThreshold(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.max(0, Math.floor(value))
    }
    if (typeof value === 'string') {
      const parsed = Number.parseInt(value.trim(), 10)
      if (Number.isFinite(parsed)) return Math.max(0, parsed)
    }
    return null
  }

  function parseBoundedNumber(value: unknown, min: number, max: number): number | null {
    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number.parseFloat(value.trim())
          : Number.NaN
    if (!Number.isFinite(parsed)) return null
    return Math.min(max, Math.max(min, parsed))
  }

  function save() {
    saveSettings(s)
    onClose()
  }

  function resetApiDefaults() {
    setS(prev => ({
      ...prev,
      asr: { ...DEFAULT_SETTINGS.asr, apiKey: '' },
      llm: { ...DEFAULT_SETTINGS.llm, apiKey: '' },
      tts: { ...DEFAULT_SETTINGS.tts, apiKey: '' },
      gateway: { ...prev.gateway, url: DEFAULT_SETTINGS.gateway.url },
    }))
    showToast('success', '已重置默认 API 配置，请填写 API Key')
  }

  function showToast(type: 'success' | 'error', text: string) {
    setToast({ type, text })
    window.setTimeout(() => setToast(null), 4000)
  }

  async function handleQuickPaste() {
    if (!navigator.clipboard?.readText) {
      showToast('error', '剪切板内容无法识别，请粘贴 API Key 或 JSON 配置')
      return
    }

    let text = ''
    try {
      text = (await navigator.clipboard.readText()).trim()
    } catch {
      showToast('error', '剪切板内容无法识别，请粘贴 API Key 或 JSON 配置')
      return
    }

    if (!text) {
      showToast('error', '剪切板内容无法识别，请粘贴 API Key 或 JSON 配置')
      return
    }

    if (text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>
        const updates: Array<{ path: string; value: string | number }> = []
        const filled: string[] = []

        const pushUpdate = (path: string, value: unknown, label: string) => {
          if (typeof value === 'string' && value.trim()) {
            updates.push({ path, value })
            filled.push(label)
          }
        }

        const asr = parsed.asr as Record<string, unknown> | undefined
        const llm = parsed.llm as Record<string, unknown> | undefined
        const tts = parsed.tts as Record<string, unknown> | undefined
        const gateway = parsed.gateway as Record<string, unknown> | undefined
        const summary = parsed.summary as Record<string, unknown> | undefined

        if (asr) {
          pushUpdate('asr.baseURL', asr.baseURL, 'ASR Base URL')
          pushUpdate('asr.apiKey', asr.apiKey, 'ASR API Key')
          pushUpdate('asr.model', asr.model, 'ASR Model')
        }
        if (llm) {
          pushUpdate('llm.baseURL', llm.baseURL, 'LLM Base URL')
          pushUpdate('llm.apiKey', llm.apiKey, 'LLM API Key')
          pushUpdate('llm.model', llm.model, 'LLM Model')
        }
        if (tts) {
          pushUpdate('tts.baseURL', tts.baseURL, 'TTS Base URL')
          pushUpdate('tts.apiKey', tts.apiKey, 'TTS API Key')
          pushUpdate('tts.model', tts.model, 'TTS Model')
          pushUpdate('tts.voice', tts.voice, 'TTS Voice')
          const speed = parseBoundedNumber(tts.speed, 0.25, 4)
          if (speed !== null) {
            updates.push({ path: 'tts.speed', value: speed })
            filled.push('TTS Speed')
          }
          const gain = parseBoundedNumber(tts.gain, -10, 10)
          if (gain !== null) {
            updates.push({ path: 'tts.gain', value: gain })
            filled.push('TTS Gain')
          }
        }
        if (gateway) {
          pushUpdate('gateway.url', gateway.url, 'Gateway URL')
          pushUpdate('gateway.token', gateway.token, 'Gateway Token')
        }
        if (summary) {
          const threshold = parseThreshold(summary.thresholdChars)
          if (threshold !== null) {
            updates.push({ path: 'summary.thresholdChars', value: threshold })
            filled.push('摘要阈值')
          }
        }

        if (updates.length === 0) {
          showToast('error', '剪切板内容无法识别，请粘贴 API Key 或 JSON 配置')
          return
        }

        setS(prev => {
          const next = { ...prev } as any
          updates.forEach(({ path, value }) => {
            const [section, key] = path.split('.')
            next[section] = { ...next[section], [key]: value }
          })
          return next
        })
        showToast('success', `已填入：${filled.join('、')}`)
        return
      } catch {
        // fall through to API key check
      }
    }

    const looksLikeKey = /^[a-zA-Z]{2,}-[a-zA-Z0-9_-]{6,}$/.test(text)
    if (looksLikeKey) {
      setS(prev => ({
        ...prev,
        asr: { ...prev.asr, apiKey: text },
        llm: { ...prev.llm, apiKey: text },
        tts: { ...prev.tts, apiKey: text }
      }))
      showToast('success', '已填入 API Key')
      return
    }

    showToast('error', '剪切板内容无法识别，请粘贴 API Key 或 JSON 配置')
  }

  const field = (label: string, path: string, placeholder = '') => (
    <div className="grid gap-2">
      <label className="text-[11px] uppercase tracking-[0.25em] text-muted-foreground">
        {label}
      </label>
      <input
        value={(s as any)[path.split('.')[0]][path.split('.')[1]]}
        placeholder={placeholder}
        onChange={e => update(path, e.target.value)}
        className="rounded-lg border border-white/10 bg-background/60 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40"
      />
    </div>
  )

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm">
      <div className="mx-auto flex h-[100dvh] w-full max-w-3xl flex-col border border-white/10 bg-card/90">
        <header className="flex items-start justify-between border-b border-white/10 px-6 py-6">
          <div>
            <p className="text-[10px] uppercase tracking-[0.35em] text-muted-foreground">
              Settings
            </p>
            <h2 className="mt-2 text-2xl font-semibold">配置中心</h2>
            <p className="mt-2 text-xs text-muted-foreground">
              调整语音识别、LLM、语音合成和网关配置。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-white/10 px-3 py-2 text-xs uppercase tracking-[0.3em] text-muted-foreground transition hover:text-foreground"
          >
            关闭
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-6">
          <div className="grid gap-6">
            <section className="grid gap-3 rounded-2xl border border-white/10 bg-background/50 p-4">
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={handleQuickPaste}
                  className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/60 bg-black/60 px-4 py-3 text-sm font-semibold text-cyan-200 transition hover:bg-cyan-950/40"
                >
                  📋 一键粘贴配置
                </button>
                <button
                  type="button"
                  onClick={resetApiDefaults}
                  className="inline-flex items-center gap-2 rounded-xl border border-white/20 bg-black/60 px-4 py-3 text-sm font-semibold text-foreground transition hover:bg-white/5"
                >
                  ↺ 重置默认
                </button>
                <div className="relative group">
                  <button
                    type="button"
                    aria-label="Quick Paste 帮助"
                    onClick={() => setHelpOpen(prev => !prev)}
                    className="flex h-8 w-8 items-center justify-center rounded-full border border-cyan-400/50 bg-black/50 text-xs font-semibold text-cyan-200 transition hover:bg-cyan-950/40"
                  >
                    ?
                  </button>
                  <div
                    className={`absolute left-0 top-10 z-10 w-[320px] rounded-xl border border-cyan-400/40 bg-black/90 p-3 text-[11px] text-cyan-100 shadow-xl transition ${
                      helpOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
                    } group-hover:pointer-events-auto group-hover:opacity-100`}
                  >
                    <p className="mb-2 text-[10px] uppercase tracking-[0.25em] text-cyan-200/80">
                      JSON 示例
                    </p>
                    <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-cyan-100/90">
{`{
  "asr": { "baseURL": "https://api.siliconflow.cn/v1", "apiKey": "sk-xxx", "model": "FunAudioLLM/SenseVoiceSmall" },
  "llm": { "baseURL": "https://api.siliconflow.cn/v1", "apiKey": "sk-xxx", "model": "Qwen/Qwen2.5-7B-Instruct" },
  "tts": { "baseURL": "https://api.siliconflow.cn/v1", "apiKey": "sk-xxx", "model": "FunAudioLLM/CosyVoice2-0.5B", "voice": "FunAudioLLM/CosyVoice2-0.5B:alex", "speed": 1.0, "gain": 0.0 },
  "gateway": { "url": "wss://oc.dingsum.com", "token": "..." },
  "summary": { "thresholdChars": 100 }
}`}
                    </pre>
                  </div>
                </div>
              </div>
              {toast && (
                <div
                  className={`rounded-lg border px-3 py-2 text-xs ${
                    toast.type === 'success'
                      ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200'
                      : 'border-rose-400/40 bg-rose-500/10 text-rose-200'
                  }`}
                >
                  {toast.text}
                </div>
              )}
            </section>
            <section className="grid gap-4 rounded-2xl border border-white/10 bg-background/50 p-4">
              <div>
                <h3 className="text-[11px] uppercase tracking-[0.3em] text-muted-foreground">
                  OpenClaw Gateway
                </h3>
                <p className="mt-2 text-xs text-muted-foreground">
                  用于转发消息和会话处理，格式如 wss://oc.dingsum.com。
                </p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                {field('Gateway URL', 'gateway.url', 'wss://oc.dingsum.com')}
                {field('Token', 'gateway.token', 'your-token')}
              </div>
            </section>

            <section className="grid gap-4 rounded-2xl border border-white/10 bg-background/50 p-4">
              <div>
                <h3 className="text-[11px] uppercase tracking-[0.3em] text-muted-foreground">
                  ASR（语音识别）
                </h3>
                <p className="mt-2 text-xs text-muted-foreground">语音转文字服务配置。</p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                {field('API Base URL', 'asr.baseURL', 'https://api.siliconflow.cn/v1')}
                {field('API Key', 'asr.apiKey', 'sk-...')}
                {field('ASR Model', 'asr.model', 'FunAudioLLM/SenseVoiceSmall')}
              </div>
            </section>

            <section className="grid gap-4 rounded-2xl border border-white/10 bg-background/50 p-4">
              <div>
                <h3 className="text-[11px] uppercase tracking-[0.3em] text-muted-foreground">
                  LLM（摘要）
                </h3>
                <p className="mt-2 text-xs text-muted-foreground">
                  对话理解与摘要模型。回复字数超过阈值时才启用摘要。
                </p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                {field('API Base URL', 'llm.baseURL', 'https://api.siliconflow.cn/v1')}
                {field('API Key', 'llm.apiKey', 'sk-...')}
                {field('Model', 'llm.model', 'Qwen/Qwen2.5-7B-Instruct')}
                <div className="grid gap-2">
                  <label className="text-[11px] uppercase tracking-[0.25em] text-muted-foreground">
                    Summary Threshold (Chars)
                  </label>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={s.summary.thresholdChars}
                    onChange={e => {
                      const parsed = parseThreshold(e.target.value)
                      update('summary.thresholdChars', parsed ?? 0)
                    }}
                    className="rounded-lg border border-white/10 bg-background/60 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40"
                  />
                </div>
              </div>
            </section>

            <section className="grid gap-4 rounded-2xl border border-white/10 bg-background/50 p-4">
              <div>
                <h3 className="text-[11px] uppercase tracking-[0.3em] text-muted-foreground">
                  TTS（语音合成）
                </h3>
                <p className="mt-2 text-xs text-muted-foreground">
                  语音合成与播报配置。按官方文档，voice 使用 `模型名:音色`（如
                  `fnlp/MOSS-TTSD-v0.5:alex`）。
                </p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                {field('API Base URL', 'tts.baseURL', 'https://api.siliconflow.cn/v1')}
                {field('API Key', 'tts.apiKey', 'sk-...')}
                {field('Model', 'tts.model', 'FunAudioLLM/CosyVoice2-0.5B')}
                {field('Voice', 'tts.voice', 'FunAudioLLM/CosyVoice2-0.5B:alex')}
                <div className="grid gap-2">
                  <label className="text-[11px] uppercase tracking-[0.25em] text-muted-foreground">
                    Speed (0.25-4)
                  </label>
                  <input
                    type="number"
                    min={0.25}
                    max={4}
                    step={0.05}
                    value={s.tts.speed}
                    onChange={e => {
                      const parsed = parseBoundedNumber(e.target.value, 0.25, 4)
                      if (parsed !== null) update('tts.speed', parsed)
                    }}
                    className="rounded-lg border border-white/10 bg-background/60 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40"
                  />
                </div>
                <div className="grid gap-2">
                  <label className="text-[11px] uppercase tracking-[0.25em] text-muted-foreground">
                    Gain dB (-10~10)
                  </label>
                  <input
                    type="number"
                    min={-10}
                    max={10}
                    step={0.5}
                    value={s.tts.gain}
                    onChange={e => {
                      const parsed = parseBoundedNumber(e.target.value, -10, 10)
                      if (parsed !== null) update('tts.gain', parsed)
                    }}
                    className="rounded-lg border border-white/10 bg-background/60 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40"
                  />
                </div>
              </div>
            </section>
          </div>
        </div>

        <footer className="flex flex-col-reverse gap-3 border-t border-white/10 px-6 py-5 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-white/10 px-4 py-2 text-xs uppercase tracking-[0.3em] text-muted-foreground transition hover:text-foreground"
          >
            取消
          </button>
          <button
            type="button"
            onClick={save}
            className="rounded-full border border-accent/60 bg-accent/10 px-4 py-2 text-xs uppercase tracking-[0.3em] text-accent transition hover:bg-accent/20"
          >
            保存设置
          </button>
        </footer>
      </div>
    </div>
  )
}
