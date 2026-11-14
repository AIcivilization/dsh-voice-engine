// lib/xf/tts.js — 超拟人和 v2/tts 两个合成接口，都返回 16bit 单声道 PCM

import { signWsUrl } from './auth.js'

export const HYPER_URL = 'wss://cbm01.cn-huabei-1.xf-yun.com/v1/private/mcd9m97e6'
export const V2_URL = 'wss://tts-api.xfyun.cn/v2/tts'
export const HYPER_RATE = 24000
export const V2_RATE = 16000
export const HYPER_MAX_BYTES = 60 * 1024 // 官方上限 64K，留点余量
export const V2_MAX_BYTES = 7900 // 官方要求小于 8000 字节

export class XfError extends Error {
  constructor(code, message, sid) {
    super(`讯飞错误 ${code}：${message}`)
    this.name = 'XfError'
    this.code = code
    this.sid = sid
  }
}

export class ConnectError extends Error {
  constructor(url) {
    super('连接讯飞失败')
    this.name = 'ConnectError'
    this.url = url // 不带签名的地址，诊断时用
  }
}

function runSocket({ url, plainUrl, request, onFrame, signal, WebSocketImpl = globalThis.WebSocket, timeoutMs = 120000 }) {
  return new Promise((done, fail) => {
    if (signal?.aborted) {
      fail(new Error('已取消'))
      return
    }
    const ws = new WebSocketImpl(url)
    let settled = false
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      try { ws.close() } catch { /* 已经断开 */ }
      fn(value)
    }
    const onAbort = () => settle(fail, new Error('已取消'))
    const timer = setTimeout(() => settle(fail, new Error('合成超时')), timeoutMs)
    signal?.addEventListener?.('abort', onAbort)
    ws.onopen = () => ws.send(JSON.stringify(request))
    ws.onerror = () => settle(fail, new ConnectError(plainUrl))
    ws.onclose = () => settle(fail, new ConnectError(plainUrl))
    ws.onmessage = (event) => {
      try {
        if (onFrame(JSON.parse(String(event.data)))) settle(done, undefined)
      } catch (error) {
        settle(fail, error)
      }
    }
  })
}

/**
 * 超拟人合成。官方脚本收到音频结束就退出；这里等 header.status=2，否则会丢掉后到的 pybuf。
 * pybuf 分多帧，一个汉字可能被切开，所以先拼字节再解码。
 */
export async function hyperSynth(text, { creds, vcn, speed = 50, volume = 50, pitch = 50, signal, WebSocketImpl } = {}) {
  const audio = []
  const pybuf = []
  let sid
  await runSocket({
    url: signWsUrl(HYPER_URL, creds),
    plainUrl: HYPER_URL,
    signal,
    WebSocketImpl,
    request: {
      header: { app_id: creds.appId, status: 2 },
      parameter: {
        tts: {
          vcn, speed, volume, pitch, bgs: 0, reg: 0, rdn: 0, rhy: 1,
          audio: { encoding: 'raw', sample_rate: HYPER_RATE, channels: 1, bit_depth: 16, frame_size: 0 },
          pybuf: { encoding: 'utf8', compress: 'raw', format: 'plain' },
        },
      },
      payload: {
        text: { encoding: 'utf8', compress: 'raw', format: 'plain', status: 2, seq: 0, text: Buffer.from(text).toString('base64') },
      },
    },
    onFrame(frame) {
      const header = frame.header ?? {}
      if (header.sid) sid = header.sid
      if (header.code !== 0) throw new XfError(header.code, header.message ?? '未知错误', sid)
      if (frame.payload?.audio?.audio) audio.push(Buffer.from(frame.payload.audio.audio, 'base64'))
      if (frame.payload?.pybuf?.text) pybuf.push(Buffer.from(frame.payload.pybuf.text, 'base64'))
      return header.status === 2
    },
  })
  return { engine: 'hyper', pcm: Buffer.concat(audio), sampleRate: HYPER_RATE, rhy: pybuf.length ? Buffer.concat(pybuf).toString('utf8') : null, sid }
}

export async function v2Synth(text, { creds, vcn, speed = 50, volume = 50, pitch = 50, signal, WebSocketImpl } = {}) {
  const audio = []
  let sid
  await runSocket({
    url: signWsUrl(V2_URL, creds),
    plainUrl: V2_URL,
    signal,
    WebSocketImpl,
    request: {
      common: { app_id: creds.appId },
      business: { aue: 'raw', auf: `audio/L16;rate=${V2_RATE}`, vcn, tte: 'UTF8', speed, volume, pitch },
      data: { status: 2, text: Buffer.from(text).toString('base64') },
    },
    onFrame(frame) {
      if (frame.sid) sid = frame.sid
      if (frame.code !== 0) throw new XfError(frame.code, frame.message ?? '未知错误', sid)
      if (frame.data?.audio) audio.push(Buffer.from(frame.data.audio, 'base64'))
      return frame.data?.status === 2
    },
  })
  return { engine: 'v2', pcm: Buffer.concat(audio), sampleRate: V2_RATE, rhy: null, sid }
}

/** WebSocket 握手失败时看不到原因：用同样的签名发一次普通请求，读服务器的错误文字 */
export async function handshakeMessage(url, creds, { fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(signWsUrl(url, creds).replace(/^wss:/, 'https:'), { signal: AbortSignal.timeout(10000) })
    const body = await response.text()
    try {
      return { status: response.status, message: JSON.parse(body).message ?? '' }
    } catch {
      return { status: response.status, message: '' }
    }
  } catch (error) {
    return { status: 0, message: error.cause?.code ?? error.message }
  }
}
