export interface Settings {
  asr: { baseURL: string; apiKey: string; model: string }
  llm: { baseURL: string; apiKey: string; model: string }
  tts: { baseURL: string; apiKey: string; voice: string }
  gateway: { url: string; token: string }
}

const DEFAULTS: Settings = {
  asr: { baseURL: 'https://api.openai.com/v1', apiKey: '', model: 'FunAudioLLM/SenseVoiceSmall' },
  llm: { baseURL: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
  tts: { baseURL: 'https://api.openai.com/v1', apiKey: '', voice: 'alloy' },
  gateway: { url: '', token: '' },
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem('talk-app-settings')
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings>
      return {
        ...DEFAULTS,
        ...parsed,
        asr: { ...DEFAULTS.asr, ...parsed.asr },
        llm: { ...DEFAULTS.llm, ...parsed.llm },
        tts: { ...DEFAULTS.tts, ...parsed.tts },
        gateway: { ...DEFAULTS.gateway, ...parsed.gateway },
      }
    }
  } catch {}
  return DEFAULTS
}

export function saveSettings(s: Settings) {
  localStorage.setItem('talk-app-settings', JSON.stringify(s))
}
