export interface Settings {
  asr: { baseURL: string; apiKey: string; model: string }
  llm: { baseURL: string; apiKey: string; model: string }
  tts: {
    baseURL: string
    apiKey: string
    model: string
    voice: string
    speed: number
    gain: number
  }
  gateway: { url: string; token: string }
  summary: { thresholdChars: number }
}

export const DEFAULT_SETTINGS: Settings = {
  asr: { baseURL: 'https://api.siliconflow.cn/v1', apiKey: '', model: 'FunAudioLLM/SenseVoiceSmall' },
  llm: { baseURL: 'https://api.siliconflow.cn/v1', apiKey: '', model: 'Qwen/Qwen2.5-7B-Instruct' },
  tts: {
    baseURL: 'https://api.siliconflow.cn/v1',
    apiKey: '',
    model: 'FunAudioLLM/CosyVoice2-0.5B',
    voice: 'FunAudioLLM/CosyVoice2-0.5B:alex',
    speed: 1,
    gain: 0,
  },
  gateway: { url: 'wss://oc.dingsum.com', token: '' },
  summary: { thresholdChars: 100 },
}

const normalizeThreshold = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value))
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10)
    if (Number.isFinite(parsed)) return Math.max(0, parsed)
  }
  return DEFAULT_SETTINGS.summary.thresholdChars
}

const normalizeFloat = (value: unknown, fallback: number) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem('talk-app-settings')
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings> & {
        summary?: { thresholdChars?: unknown }
      }
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        asr: { ...DEFAULT_SETTINGS.asr, ...parsed.asr },
        llm: { ...DEFAULT_SETTINGS.llm, ...parsed.llm },
        tts: {
          ...DEFAULT_SETTINGS.tts,
          ...parsed.tts,
          speed: clamp(
            normalizeFloat(parsed.tts?.speed, DEFAULT_SETTINGS.tts.speed),
            0.25,
            4
          ),
          gain: clamp(
            normalizeFloat(parsed.tts?.gain, DEFAULT_SETTINGS.tts.gain),
            -10,
            10
          ),
        },
        gateway: { ...DEFAULT_SETTINGS.gateway, ...parsed.gateway },
        summary: {
          ...DEFAULT_SETTINGS.summary,
          ...parsed.summary,
          thresholdChars: normalizeThreshold(parsed.summary?.thresholdChars),
        },
      }
    }
  } catch {}
  return DEFAULT_SETTINGS
}

export function saveSettings(s: Settings) {
  localStorage.setItem('talk-app-settings', JSON.stringify(s))
}
