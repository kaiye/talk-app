import React from 'react'
import type { Settings } from './settings'
import { loadSettings, saveSettings } from './settings'

interface Props {
  onClose: () => void
}

export default function SettingsPage({ onClose }: Props) {
  const [s, setS] = React.useState<Settings>(loadSettings)
  const [toast, setToast] = React.useState<{ type: 'success' | 'error'; text: string } | null>(
    null
  )
  const [helpOpen, setHelpOpen] = React.useState(false)

  function update(path: string, value: string) {
    const [section, key] = path.split('.')
    setS(prev => ({ ...prev, [section]: { ...(prev as any)[section], [key]: value } }))
  }

  function save() {
    saveSettings(s)
    onClose()
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
        const updates: Array<{ path: string; value: string }> = []
        const filled: string[] = []
        const isNestedFormat =
          'asr' in parsed || 'llm' in parsed || 'tts' in parsed || 'gateway' in parsed

        const pushUpdate = (path: string, value: unknown, label: string) => {
          if (typeof value === 'string' && value.trim()) {
            updates.push({ path, value })
            filled.push(label)
          }
        }

        if (isNestedFormat) {
          const asr = parsed.asr as Record<string, unknown> | undefined
          const llm = parsed.llm as Record<string, unknown> | undefined
          const tts = parsed.tts as Record<string, unknown> | undefined
          const gateway = parsed.gateway as Record<string, unknown> | undefined

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
            pushUpdate('tts.voice', tts.voice, 'TTS Voice')
          }
          if (gateway) {
            pushUpdate('gateway.url', gateway.url, 'Gateway URL')
            pushUpdate('gateway.token', gateway.token, 'Gateway Token')
          }
        } else {
          if (typeof parsed.baseURL === 'string' && parsed.baseURL.trim()) {
            updates.push(
              { path: 'asr.baseURL', value: parsed.baseURL },
              { path: 'llm.baseURL', value: parsed.baseURL },
              { path: 'tts.baseURL', value: parsed.baseURL }
            )
            filled.push('Base URL（ASR/LLM/TTS）')
          }
          if (typeof parsed.apiKey === 'string' && parsed.apiKey.trim()) {
            updates.push(
              { path: 'asr.apiKey', value: parsed.apiKey },
              { path: 'llm.apiKey', value: parsed.apiKey },
              { path: 'tts.apiKey', value: parsed.apiKey }
            )
            filled.push('API Key（ASR/LLM/TTS）')
          }
          if (typeof parsed.llmModel === 'string' && parsed.llmModel.trim()) {
            updates.push({ path: 'llm.model', value: parsed.llmModel })
            filled.push('LLM Model')
          }
          if (typeof parsed.ttsVoice === 'string' && parsed.ttsVoice.trim()) {
            updates.push({ path: 'tts.voice', value: parsed.ttsVoice })
            filled.push('TTS Voice')
          }
          if (typeof parsed.gatewayUrl === 'string' && parsed.gatewayUrl.trim()) {
            updates.push({ path: 'gateway.url', value: parsed.gatewayUrl })
            filled.push('Gateway URL')
          }
          if (typeof parsed.gatewayToken === 'string' && parsed.gatewayToken.trim()) {
            updates.push({ path: 'gateway.token', value: parsed.gatewayToken })
            filled.push('Gateway Token')
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
  "asr": { "baseURL": "https://api.siliconflow.cn/v1", "apiKey": "sk-xxx", "model": "whisper-1" },
  "llm": { "baseURL": "https://api.siliconflow.cn/v1", "apiKey": "sk-xxx", "model": "Qwen/Qwen2.5-7B-Instruct" },
  "tts": { "baseURL": "https://api.siliconflow.cn/v1", "apiKey": "sk-xxx", "voice": "FunAudioLLM/CosyVoice2-0.5B:alex" },
  "gateway": { "url": "...", "token": "..." }
}

旧版（仍支持）:
{
  "baseURL": "https://api.siliconflow.cn/v1",
  "apiKey": "sk-xxx",
  "llmModel": "Qwen/Qwen2.5-7B-Instruct",
  "ttsVoice": "FunAudioLLM/CosyVoice2-0.5B:alex",
  "gatewayUrl": "...",
  "gatewayToken": "..."
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
                <p className="mt-2 text-xs text-muted-foreground">用于转发消息和会话处理。</p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                {field('Gateway URL', 'gateway.url', 'https://your-gateway.com/api/message')}
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
                {field('API Base URL', 'asr.baseURL', 'https://api.openai.com/v1')}
                {field('API Key', 'asr.apiKey', 'sk-...')}
                {field('ASR Model', 'asr.model', 'FunAudioLLM/SenseVoiceSmall')}
              </div>
            </section>

            <section className="grid gap-4 rounded-2xl border border-white/10 bg-background/50 p-4">
              <div>
                <h3 className="text-[11px] uppercase tracking-[0.3em] text-muted-foreground">
                  LLM（摘要）
                </h3>
                <p className="mt-2 text-xs text-muted-foreground">对话理解与摘要模型。</p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                {field('API Base URL', 'llm.baseURL', 'https://api.openai.com/v1')}
                {field('API Key', 'llm.apiKey', 'sk-...')}
                {field('Model', 'llm.model', 'gpt-4o-mini')}
              </div>
            </section>

            <section className="grid gap-4 rounded-2xl border border-white/10 bg-background/50 p-4">
              <div>
                <h3 className="text-[11px] uppercase tracking-[0.3em] text-muted-foreground">
                  TTS（语音合成）
                </h3>
                <p className="mt-2 text-xs text-muted-foreground">语音合成与播报配置。</p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                {field('API Base URL', 'tts.baseURL', 'https://api.openai.com/v1')}
                {field('API Key', 'tts.apiKey', 'sk-...')}
                {field('Voice', 'tts.voice', 'alloy')}
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
