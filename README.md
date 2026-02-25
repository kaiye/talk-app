# 哈吉语音助手 (Haji Voice Assistant)

哈吉语音助手是一款解放双手的语音 AI 助手 H5 应用，面向“手上正忙”的场景（如抱着宝宝、做饭、开车时的副驾驶）。你只需开口说话，就能获得 AI 的语音回复。

## 项目简介 (Project Overview)
A hands-free voice AI assistant H5 app. Designed for situations where your hands are occupied (e.g. holding a baby). Talk to AI, get voice responses.

## 功能特性 (Features)
- VAD (Voice Activity Detection) - 自动检测说话起止
- ASR - 语音转文本（OpenAI 兼容 API）
- OpenClaw Gateway - 通过 WebSocket 将文本发送至 AI 后端
- LLM - 默认摘要回复，或在详细模式返回完整内容
- TTS - 文本转语音并播放
- Conversation history - 本地 localStorage 保存，LRU 保留 10 条
- Quick-paste config - 一次性粘贴 JSON 自动填充配置
- Terminal minimal dark theme - 终端风极简暗色主题

## 技术架构 (Architecture)
语音 → VAD → ASR → WebSocket(OpenClaw Gateway) → LLM摘要 → TTS → 播放

## 快速开始 (Quick Start)
- Prerequisites: Node.js 18+
- 开发启动：`npm install && npm run dev`
- 构建：`npm run build`

## 配置说明 (Configuration)
应用配置分为 4 个部分，支持“Quick-paste config”一次性粘贴 JSON：

### ASR
- `baseURL`: OpenAI 兼容 ASR 服务地址
- `apiKey`: 访问密钥
- `model`: 模型名称（推荐：`FunAudioLLM/SenseVoiceSmall` via siliconflow）

### LLM
- `baseURL`: OpenAI 兼容 LLM 服务地址
- `apiKey`: 访问密钥
- `model`: 模型名称（推荐：`Qwen/Qwen2.5-7B-Instruct` via siliconflow）

### TTS
- `baseURL`: OpenAI 兼容 TTS 服务地址
- `apiKey`: 访问密钥
- `voice`: 语音名称（推荐：`FunAudioLLM/CosyVoice2-0.5B:alex` via siliconflow）

### Gateway
- `url`: WebSocket 地址（如 `wss://your-openclaw-gateway`）
- `token`: 鉴权令牌

#### Quick-paste JSON 示例
```json
{
  "asr": {
    "baseURL": "https://api.siliconflow.cn/v1",
    "apiKey": "sk-xxxx",
    "model": "FunAudioLLM/SenseVoiceSmall"
  },
  "llm": {
    "baseURL": "https://api.siliconflow.cn/v1",
    "apiKey": "sk-xxxx",
    "model": "Qwen/Qwen2.5-7B-Instruct"
  },
  "tts": {
    "baseURL": "https://api.siliconflow.cn/v1",
    "apiKey": "sk-xxxx",
    "voice": "FunAudioLLM/CosyVoice2-0.5B:alex"
  },
  "gateway": {
    "url": "wss://your-openclaw-gateway",
    "token": "your-token"
  }
}
```

## 推荐服务商 (Recommended Providers)
- 硅基流动 (siliconflow.cn) - 支持 ASR/LLM/TTS，OpenAI 兼容，支持 CORS
- OpenClaw Gateway - https://openclaw.ai

## 语音指令 (Voice Commands)
- “详细播报” - 跳过摘要，播报完整回复
- “停止” / “算了” - 取消当前播报或对话
- “重复一遍” - 复述上一次回复

## 部署 (Deployment)
项目为纯静态资源应用，构建后输出 `dist/`，可部署到任意静态文件服务器。若需要自定义静态资源路径，请修改 `vite.config.ts` 的 `base` 配置。

## 已知问题
详见 `ISSUES.md`。

## License
MIT
