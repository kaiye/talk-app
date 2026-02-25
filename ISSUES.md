# 已知问题 / Known Issues

## 1. VAD WASM 文件 404

**问题描述：**
`@ricky0123/vad-web` 需要加载以下 WASM/ONNX 文件，但当前从 dingsum.com/talk/ 路径访问时 404：
- `silero_vad_legacy.onnx`
- `ort-wasm-simd-threaded.mjs`
- `ort-wasm-simd-threaded.wasm`
- `vad.worklet.bundle.min.js`

**原因：**
vad-web 默认从相对路径加载这些文件，但 vite base 设置为 `/talk/` 导致路径不匹配。

**待解决方案：**
- 方案A：在 vite.config.ts 中配置 assetsInclude，将 wasm/onnx 文件复制到 dist/
- 方案B：在 App.tsx 中初始化 VAD 时显式指定 `ortConfig.wasmPaths` 和 `modelURL` 为绝对路径
- 参考：https://github.com/ricky0123/vad/issues

## 2. OpenClaw Gateway chat.send 权限错误

**问题描述：**
WebSocket 握手成功（hello-ok），但发送 `chat.send` 时报错：
```
INVALID_REQUEST: missing scope: operator
```

**原因：**
当前 connect 请求中 `role: "operator"` 和 `scopes: ["operator.read", "operator.write"]` 可能需要额外权限配置，或者应该使用不同的 role/scope 组合。

**待解决方案：**
- 查看 OpenClaw Gateway 文档中 webchat role 的正确 scopes
- 可能需要使用 `role: "webchat"` 或不同的 scopes
- 参考文档：/root/.nvm/versions/node/v24.13.0/lib/node_modules/openclaw/docs/gateway/protocol.md
