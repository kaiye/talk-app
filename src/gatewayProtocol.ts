const readString = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return null
}

// Keep legacy "operator" for older gateway builds while supporting scoped auth.
export const OPERATOR_SCOPES = ['operator', 'operator.read', 'operator.write'] as const
export const DEFAULT_GATEWAY_SESSION_KEY = 'main'

const DEVICE_IDENTITY_STORAGE_KEY = 'talk-app.gateway.device-identity.v1'
const ED25519_ALGORITHM = 'Ed25519'

type GatewayDeviceIdentity = {
  deviceId: string
  publicKey: string
  privateKeyJwk: JsonWebKey
}

type StoredGatewayDeviceIdentity = GatewayDeviceIdentity & {
  version: 1
  createdAtMs: number
}

export type GatewayDeviceAuth = {
  id: string
  publicKey: string
  signature: string
  signedAt: number
  nonce: string
}

export type GatewayErrorInfo = {
  message: string
  code: string | null
  detailCode: string | null
  requestId: string | null
}

export type GatewayChatState = 'delta' | 'final' | 'aborted' | 'error' | null

export type GatewayChatPayloadInfo = {
  state: GatewayChatState
  runId: string
  text: string
  errorMessage: string | null
}

const textEncoder = new TextEncoder()

const hasWebCrypto = () =>
  typeof globalThis !== 'undefined' &&
  typeof globalThis.crypto !== 'undefined' &&
  typeof globalThis.crypto.subtle !== 'undefined'

const hasStorage = () =>
  typeof globalThis !== 'undefined' &&
  typeof globalThis.localStorage !== 'undefined'

const toHex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer))
    .map(v => v.toString(16).padStart(2, '0'))
    .join('')

const toBase64Url = (input: ArrayBuffer | Uint8Array) => {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

const fromBase64Url = (value: string) => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

const normalizeScopes = (scopes: readonly string[]) => {
  const out: string[] = []
  const seen = new Set<string>()
  for (const scope of scopes) {
    const trimmed = scope.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

const readObject = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

const flattenMessageText = (value: unknown): string[] => {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? [trimmed] : []
  }
  if (Array.isArray(value)) {
    return value.flatMap(flattenMessageText)
  }
  const obj = readObject(value)
  if (!obj) return []

  const directText = readString(obj.text)
  if (directText) return [directText]

  const nestedContent = obj.content
  if (typeof nestedContent === 'string') {
    const trimmed = nestedContent.trim()
    return trimmed ? [trimmed] : []
  }
  if (Array.isArray(nestedContent)) {
    return nestedContent.flatMap(flattenMessageText)
  }

  return []
}

const buildDeviceAuthPayload = (params: {
  deviceId: string
  clientId: string
  clientMode: string
  role: string
  scopes: readonly string[]
  signedAtMs: number
  token: string | null
  nonce: string
}) =>
  [
    'v2',
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(','),
    String(params.signedAtMs),
    params.token ?? '',
    params.nonce,
  ].join('|')

const parseStoredIdentity = (raw: string): StoredGatewayDeviceIdentity | null => {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredGatewayDeviceIdentity>
    if (
      parsed.version !== 1 ||
      typeof parsed.deviceId !== 'string' ||
      typeof parsed.publicKey !== 'string' ||
      !parsed.privateKeyJwk ||
      typeof parsed.privateKeyJwk !== 'object'
    ) {
      return null
    }
    return parsed as StoredGatewayDeviceIdentity
  } catch {
    return null
  }
}

const createDeviceIdentity = async (): Promise<GatewayDeviceIdentity> => {
  if (!hasWebCrypto()) throw new Error('WebCrypto is unavailable')

  const keyPair = (await crypto.subtle.generateKey(
    { name: ED25519_ALGORITHM },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair

  const rawPublicKey = await crypto.subtle.exportKey('raw', keyPair.publicKey)
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey)
  const publicKey = toBase64Url(rawPublicKey)
  const deviceId = toHex(await crypto.subtle.digest('SHA-256', rawPublicKey))

  return { deviceId, publicKey, privateKeyJwk }
}

const readStoredIdentity = (): StoredGatewayDeviceIdentity | null => {
  if (!hasStorage()) return null
  const raw = localStorage.getItem(DEVICE_IDENTITY_STORAGE_KEY)
  if (!raw) return null
  return parseStoredIdentity(raw)
}

const persistIdentity = (identity: GatewayDeviceIdentity) => {
  if (!hasStorage()) return
  const payload: StoredGatewayDeviceIdentity = {
    version: 1,
    createdAtMs: Date.now(),
    ...identity,
  }
  localStorage.setItem(DEVICE_IDENTITY_STORAGE_KEY, JSON.stringify(payload))
}

const verifyStoredIdentity = async (
  identity: StoredGatewayDeviceIdentity
): Promise<GatewayDeviceIdentity | null> => {
  if (!hasWebCrypto()) return null
  try {
    const rawPublicKey = fromBase64Url(identity.publicKey)
    const derivedId = toHex(await crypto.subtle.digest('SHA-256', rawPublicKey.buffer))
    if (derivedId !== identity.deviceId) return null
    await crypto.subtle.importKey(
      'jwk',
      identity.privateKeyJwk,
      { name: ED25519_ALGORITHM },
      false,
      ['sign']
    )
    return {
      deviceId: identity.deviceId,
      publicKey: identity.publicKey,
      privateKeyJwk: identity.privateKeyJwk,
    }
  } catch {
    return null
  }
}

const loadOrCreateDeviceIdentity = async (): Promise<GatewayDeviceIdentity> => {
  if (!hasWebCrypto()) {
    throw new Error(
      '当前浏览器不支持 WebCrypto Ed25519 设备签名，请使用最新 Chrome，或临时在网关开启 dangerouslyDisableDeviceAuth。'
    )
  }

  const stored = readStoredIdentity()
  if (stored) {
    const verified = await verifyStoredIdentity(stored)
    if (verified) return verified
  }

  const created = await createDeviceIdentity()
  persistIdentity(created)
  return created
}

export async function buildGatewayDeviceAuth(params: {
  clientId: string
  clientMode: string
  role: string
  scopes: readonly string[]
  token: string | null
  nonce: string
}): Promise<GatewayDeviceAuth> {
  const nonce = params.nonce.trim()
  if (!nonce) throw new Error('Gateway connect challenge missing nonce')

  const identity = await loadOrCreateDeviceIdentity()
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    identity.privateKeyJwk,
    { name: ED25519_ALGORITHM },
    false,
    ['sign']
  )

  const scopes = normalizeScopes(params.scopes)
  const signedAt = Date.now()
  const payload = buildDeviceAuthPayload({
    deviceId: identity.deviceId,
    clientId: params.clientId,
    clientMode: params.clientMode,
    role: params.role,
    scopes,
    signedAtMs: signedAt,
    token: params.token,
    nonce,
  })
  const signature = await crypto.subtle.sign(
    { name: ED25519_ALGORITHM },
    privateKey,
    textEncoder.encode(payload)
  )

  return {
    id: identity.deviceId,
    publicKey: identity.publicKey,
    signature: toBase64Url(signature),
    signedAt,
    nonce,
  }
}

export function getGatewayErrorInfo(
  frame: unknown,
  fallback = 'Gateway error'
): GatewayErrorInfo {
  if (!frame || typeof frame !== 'object') {
    return { message: fallback, code: null, detailCode: null, requestId: null }
  }

  const topLevel = frame as { message?: unknown; error?: unknown; code?: unknown }
  const nested = topLevel.error && typeof topLevel.error === 'object'
    ? (topLevel.error as { message?: unknown; code?: unknown; details?: unknown })
    : null
  const details = nested?.details && typeof nested.details === 'object'
    ? (nested.details as { code?: unknown; requestId?: unknown })
    : null

  const message =
    readString(topLevel.message) ||
    readString(topLevel.error) ||
    readString(nested?.message) ||
    fallback

  return {
    message,
    code: readString(nested?.code) || readString(topLevel.code),
    detailCode: readString(details?.code),
    requestId: readString(details?.requestId),
  }
}

export function parseGatewayChatPayload(payload: unknown): GatewayChatPayloadInfo {
  const frame = readObject(payload) || {}
  const stateRaw = readString(frame.state)?.toLowerCase() || ''

  let state: GatewayChatState = null
  if (stateRaw === 'delta' || stateRaw === 'final' || stateRaw === 'aborted' || stateRaw === 'error') {
    state = stateRaw
  }

  const textParts = flattenMessageText(frame.message)
  const text = (readString(frame.text) || textParts.join('\n') || '').trim()
  const errorObject = readObject(frame.error)
  const errorMessage = readString(frame.errorMessage) || readString(errorObject?.message)

  return {
    state,
    runId: readString(frame.runId) || '',
    text,
    errorMessage,
  }
}

export function getGatewayErrorMessage(
  frame: unknown,
  fallback = 'Gateway error'
): string {
  return getGatewayErrorInfo(frame, fallback).message
}
