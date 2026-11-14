// spike/xf.mjs — M0 验证用的讯飞客户端（超拟人、v2/tts、极速转写），零依赖
//
// 只用于验证，不是插件代码。凭据读环境变量 IFLY_* 或 $DSH_HOME/dsh-xfyun/credentials.json，
// 报错信息和日志都不带密钥，也不带签名后的 URL。

import { createHash, createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const HYPER_URL = 'wss://cbm01.cn-huabei-1.xf-yun.com/v1/private/mcd9m97e6'
export const V2_URL = 'wss://tts-api.xfyun.cn/v2/tts'
const UPLOAD_HOST = 'upload-ost-api.xfyun.cn'
const API_HOST = 'ost-api.xfyun.cn'

export const FRAME_MS = 5 // 官方文档：rhy 的 1 帧约 5ms

export function credentialsPath(env = process.env) {
  const home = env.DSH_HOME?.trim() ? resolve(env.DSH_HOME.trim()) : join(homedir(), '.dsh')
  return join(home, 'dsh-xfyun', 'credentials.json')
}

export function loadCredentials(env = process.env) {
  const fromEnv = { appId: env.IFLY_APP_ID, apiKey: env.IFLY_API_KEY, apiSecret: env.IFLY_API_SECRET }
  if (fromEnv.appId && fromEnv.apiKey && fromEnv.apiSecret) return fromEnv
  let file
  try {
    file = JSON.parse(readFileSync(credentialsPath(env), 'utf8'))
  } catch {
    throw new Error(`没有讯飞凭据。请先运行 spike/setup-creds.sh（会写入 ${credentialsPath(env)}）`)
  }
  const problem = credentialProblem(file)
  if (problem) throw new Error(`${problem}。请重新运行 spike/setup-creds.sh`)
  return file
}

/** ak- 开头的密钥走 x-api-key 请求头，其余走 APIKey + APISecret 签名 */
export const usesKeyHeader = (creds) => String(creds.apiKey ?? '').startsWith('ak-')

/** 检查形状，发现填错位置就直说。返回的文字不带凭据内容 */
export function credentialProblem({ appId, apiKey, apiSecret } = {}) {
  if (!appId) return '缺少 AppID'
  if (/[@/:]/.test(appId) || /\s/.test(appId)) return 'AppID 填错了：它应该是控制台应用详情里的一串字母数字，不是邮箱或网址'
  if (!apiKey) return '缺少 APIKey'
  if (usesKeyHeader({ apiKey })) return null
  if (!apiSecret) return '缺少 APISecret（只有 ak- 开头的密钥可以不填）'
  if (/^https?:/.test(apiSecret)) return 'APISecret 填错了：它不是网址'
  return null
}

/** 一次 WebSocket 连接需要的地址和请求头 */
export function connection(url, creds) {
  return usesKeyHeader(creds)
    ? { url, headers: { 'x-api-key': creds.apiKey } }
    : { url: signWsUrl(url, creds), headers: undefined }
}

// —— 鉴权 ——

function hmacBase64(secret, text) {
  return createHmac('sha256', secret).update(text, 'utf8').digest('base64')
}

/** WebSocket 接口：把签名放进 URL */
export function signWsUrl(url, { apiKey, apiSecret }, date = new Date().toUTCString()) {
  const u = new URL(url)
  const signature = hmacBase64(apiSecret, `host: ${u.host}\ndate: ${date}\nGET ${u.pathname} HTTP/1.1`)
  const origin = `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`
  const query = new URLSearchParams({
    authorization: Buffer.from(origin).toString('base64'),
    date,
    host: u.host,
  })
  return `${url}?${query}`
}

/** 极速转写的 HTTP 接口：签名放请求头，多一个 body 摘要 */
export function signHttpHeaders({ host, path, body, contentType }, { apiKey, apiSecret }, date = new Date().toUTCString()) {
  const digest = `SHA-256=${createHash('sha256').update(body).digest('base64')}`
  const signature = hmacBase64(apiSecret, `host: ${host}\ndate: ${date}\nPOST ${path} HTTP/1.1\ndigest: ${digest}`)
  return {
    host,
    date,
    digest,
    authorization: `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line digest", signature="${signature}"`,
    'content-type': contentType,
  }
}

// —— 超拟人的拼音标注 ——

/**
 * 解析 rhy=1 返回的文本。文档示例：sil:6;欢[=huan1]-h1:16;@-uan1:24;
 * 真实格式还没见过，所以写得宽松：不认识的片段放进 unparsed，绝不悄悄丢掉。
 */
export function parseRhy(text) {
  const units = []
  const pauses = []
  const unparsed = []
  let frames = 0
  let current = null
  let boundaries = 0
  const ms = () => frames * FRAME_MS

  for (let raw of String(text).split(';')) {
    let token = raw.replace(/\{[^}]*\}/g, '').trim()
    if (token.startsWith('*')) {
      boundaries += 1
      token = token.slice(1).trim()
    }
    if (!token) continue

    let m = token.match(/^(sil|sp):(\d+)$/)
    if (m) {
      const n = Number(m[2])
      pauses.push({ kind: m[1], startMs: ms(), endMs: ms() + n * FRAME_MS })
      frames += n
      current = null
      continue
    }
    // 实测：@ 后面也可能跟 *（英文常见，如 @*-iy:16）；句中停顿写成 @-sp3:68，不算这个字的发音时长
    m = token.match(/^@(\*)?-(.+):(\d+)$/)
    if (m && current) {
      const n = Number(m[3])
      if (m[1]) boundaries += 1
      if (/^sp\d*$/.test(m[2])) {
        pauses.push({ kind: 'sp', startMs: ms(), endMs: ms() + n * FRAME_MS })
        frames += n
        continue
      }
      current.phonemes.push({ phoneme: m[2], frames: n })
      frames += n
      current.endMs = ms()
      continue
    }
    // 实测：韵律符号 * 紧贴在拼音后面，比如 好[=hao3]*-h3:24
    m = token.match(/^(.+?)(?:\[=([^\]]+)\])?(\*)?-([^-]+):(\d+)$/)
    if (m) {
      const n = Number(m[5])
      if (m[3]) boundaries += 1
      current = {
        text: m[1],
        pinyin: m[2] ?? null,
        phonemes: [{ phoneme: m[4], frames: n }],
        startMs: ms(),
        endMs: ms() + n * FRAME_MS,
      }
      frames += n
      units.push(current)
      continue
    }
    unparsed.push(token)
    m = token.match(/:(\d+)$/)
    if (m) frames += Number(m[1]) // 时长仍然计入，否则后面的时间全部错位
  }
  return { units, pauses, unparsed, boundaries, frames, totalMs: ms() }
}

// —— 合成 ——

function concatText(chunks) {
  // pybuf 可能分多帧，一个汉字会被切开，所以先拼字节再解码
  return Buffer.concat(chunks).toString('utf8')
}

function runSocket({ url, headers, request, onFrame, WebSocketImpl = globalThis.WebSocket, timeoutMs = 120000 }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const ws = headers ? new WebSocketImpl(url, { headers }) : new WebSocketImpl(url)
    let settled = false
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ws.close() } catch { /* 已经断开 */ }
      fn(value)
    }
    const timer = setTimeout(() => settle(rejectPromise, new Error('合成超时')), timeoutMs)
    ws.onopen = () => ws.send(JSON.stringify(request))
    ws.onerror = () => settle(rejectPromise, new Error('连接失败：多半是鉴权不对、时钟偏差或网络问题'))
    ws.onclose = () => settle(rejectPromise, new Error('连接在合成结束前断开'))
    ws.onmessage = (event) => {
      try {
        const done = onFrame(JSON.parse(String(event.data)))
        if (done) settle(resolvePromise, undefined)
      } catch (error) {
        settle(rejectPromise, error)
      }
    }
  })
}

export class XfError extends Error {
  constructor(code, message, sid) {
    super(`讯飞错误 ${code}：${message}${sid ? `（sid ${sid}）` : ''}`)
    this.name = 'XfError'
    this.code = code
    this.sid = sid
  }
}

/** 超拟人合成。官方脚本在音频结束时就退出；这里等 header.status=2，避免丢掉后到的 pybuf */
export async function hyperSynth(text, { creds, vcn = 'x5_lingxiaoxuan_flow', speed = 50, rhy = 1, sampleRate = 24000, WebSocketImpl } = {}) {
  const audio = []
  const pybuf = []
  const pybufFrameKeys = new Set()
  let sid
  const started = Date.now()
  let firstAudioMs = null

  await runSocket({
    ...connection(HYPER_URL, creds),
    WebSocketImpl,
    request: {
      header: { app_id: creds.appId, status: 2 },
      parameter: {
        tts: {
          vcn, speed, volume: 50, pitch: 50, bgs: 0, reg: 0, rdn: 0, rhy,
          audio: { encoding: 'raw', sample_rate: sampleRate, channels: 1, bit_depth: 16, frame_size: 0 },
          ...(rhy ? { pybuf: { encoding: 'utf8', compress: 'raw', format: 'plain' } } : {}),
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
      const a = frame.payload?.audio
      if (a?.audio) {
        firstAudioMs ??= Date.now() - started
        audio.push(Buffer.from(a.audio, 'base64'))
      }
      const p = frame.payload?.pybuf
      if (p) {
        Object.keys(p).forEach((k) => pybufFrameKeys.add(k))
        if (p.text) pybuf.push(Buffer.from(p.text, 'base64'))
      }
      return header.status === 2
    },
  })

  const pcm = Buffer.concat(audio)
  return {
    engine: 'hyper',
    vcn, sid, sampleRate,
    pcm,
    durationMs: pcmDurationMs(pcm, sampleRate),
    firstAudioMs,
    totalMs: Date.now() - started,
    rhyText: pybuf.length ? concatText(pybuf) : null,
    pybufFrameKeys: [...pybufFrameKeys],
  }
}

export async function v2Synth(text, { creds, vcn = 'xiaoyan', speed = 50, WebSocketImpl } = {}) {
  const audio = []
  let sid
  const started = Date.now()
  let firstAudioMs = null

  await runSocket({
    ...connection(V2_URL, creds),
    WebSocketImpl,
    request: {
      common: { app_id: creds.appId },
      business: { aue: 'raw', auf: 'audio/L16;rate=16000', vcn, tte: 'UTF8', speed, volume: 50, pitch: 50 },
      data: { status: 2, text: Buffer.from(text).toString('base64') },
    },
    onFrame(frame) {
      if (frame.sid) sid = frame.sid
      if (frame.code !== 0) throw new XfError(frame.code, frame.message ?? '未知错误', sid)
      if (frame.data?.audio) {
        firstAudioMs ??= Date.now() - started
        audio.push(Buffer.from(frame.data.audio, 'base64'))
      }
      return frame.data?.status === 2
    },
  })

  const pcm = Buffer.concat(audio)
  return { engine: 'v2', vcn, sid, sampleRate: 16000, pcm, durationMs: pcmDurationMs(pcm, 16000), firstAudioMs, totalMs: Date.now() - started }
}

// —— 音频小工具 ——

export function pcmDurationMs(pcm, sampleRate) {
  return (pcm.length / (sampleRate * 2)) * 1000
}

export function wavFromPcm(pcm, sampleRate) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** 音频开头和结尾的静音长度：判断「音频时长」和「实际开口时刻」差多少 */
export function silenceEdgesMs(pcm, sampleRate, threshold = 500) {
  const samples = Math.floor(pcm.length / 2)
  let first = samples
  for (let i = 0; i < samples; i += 1) {
    if (Math.abs(pcm.readInt16LE(i * 2)) > threshold) { first = i; break }
  }
  let last = -1
  for (let i = samples - 1; i >= 0; i -= 1) {
    if (Math.abs(pcm.readInt16LE(i * 2)) > threshold) { last = i; break }
  }
  if (last < 0) return { headMs: pcmDurationMs(pcm, sampleRate), tailMs: 0 }
  return { headMs: (first / sampleRate) * 1000, tailMs: ((samples - 1 - last) / sampleRate) * 1000 }
}

export function splitSentences(text) {
  return String(text).match(/[^。！？!?；;\n]+[。！？!?；;]*/g)?.map((s) => s.trim()).filter(Boolean) ?? []
}

// —— 极速转写 ——

function assertOk(result, what) {
  if (result?.code !== 0) throw new XfError(result?.code ?? 'unknown', `${what}：${result?.message ?? '未知错误'}`)
  return result
}

async function postSigned({ host, path, body, contentType, creds, fetchImpl = fetch }) {
  const response = await fetchImpl(`https://${host}${path}`, {
    method: 'POST',
    // ak- 密钥在转写接口上是否可用还没验证，先按同样的请求头方式试
    headers: usesKeyHeader(creds)
      ? { 'x-api-key': creds.apiKey, 'content-type': contentType }
      : signHttpHeaders({ host, path, body, contentType }, creds),
    body,
  })
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`接口 ${path} 返回了非 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`)
  }
}

const requestId = () => new Date().toISOString().replace(/\D/g, '').slice(0, 14)

export async function uploadAudio(data, filename, { creds, fetchImpl } = {}) {
  const boundary = `----xf${randomBytes(12).toString('hex')}`
  const field = (name, value) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
  const body = Buffer.concat([
    Buffer.from(field('app_id', creds.appId) + field('request_id', requestId())),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="data"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  const result = assertOk(await postSigned({
    host: UPLOAD_HOST, path: '/file/upload', body, contentType: `multipart/form-data; boundary=${boundary}`, creds, fetchImpl,
  }), '上传')
  return result.data.url
}

export async function createTranscribeTask(audioUrl, { creds, fetchImpl } = {}) {
  const body = JSON.stringify({
    common: { app_id: creds.appId },
    business: { request_id: requestId(), language: 'zh_cn', accent: 'mandarin', domain: 'pro_ost_ed' },
    data: { audio_url: audioUrl, audio_src: 'http', format: 'audio/mp3', encoding: 'lame' },
  })
  const result = assertOk(await postSigned({ host: API_HOST, path: '/v2/ost/pro_create', body, contentType: 'application/json', creds, fetchImpl }), '创建转写任务')
  return result.data.task_id
}

export async function waitTranscribe(taskId, { creds, fetchImpl, intervalMs = 3000, attempts = 100 } = {}) {
  const body = JSON.stringify({ common: { app_id: creds.appId }, business: { task_id: taskId } })
  for (let i = 0; i < attempts; i += 1) {
    const raw = await postSigned({ host: API_HOST, path: '/v2/ost/query', body, contentType: 'application/json', creds, fetchImpl })
    // 实测：任务刚创建就查可能返回 10401 no data found，稍等再查，连续几次才算失败
    if (raw?.code === 10401 && i < 5) {
      await new Promise((r) => setTimeout(r, intervalMs))
      continue
    }
    const result = assertOk(raw, '查询转写任务')
    const status = result.data?.task_status
    if (status === '3' || status === '4') return result
    if (status === '-1') throw new Error(`转写失败：${result.data?.message ?? '未知错误'}`)
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error('转写超时')
}

/** 拆出文字，并检查返回里到底有没有词级时间（这是要验证的问题之一） */
export function parseTranscript(result) {
  const lattice = result?.data?.result?.lattice ?? []
  const wordFields = new Set()
  const segments = []
  const words = []
  for (const item of lattice) {
    const offset = Number(item.begin ?? 0)
    let text = ''
    for (const rt of item.json_1best?.st?.rt ?? []) {
      for (const ws of rt.ws ?? []) {
        Object.keys(ws).forEach((k) => wordFields.add(k))
        for (const cw of ws.cw ?? []) {
          Object.keys(cw).forEach((k) => wordFields.add(`cw.${k}`))
          if (cw.wp === 'g') continue
          text += cw.w ?? ''
          words.push({ w: cw.w, wb: ws.wb, we: ws.we, offset })
        }
      }
    }
    if (text) segments.push({ begin: item.begin, end: item.end, text })
  }
  return { text: segments.map((s) => s.text).join(''), segments, words, wordFields: [...wordFields].sort() }
}

// —— 回听比较 ——

const normalize = (s) => String(s).replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()

/** 原稿和回听文字逐字比较，返回相似度和漏读、多读的片段 */
export function diffText(original, heard) {
  const a = [...normalize(original)]
  const b = [...normalize(heard)]
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const missing = []
  const extra = []
  let i = 0
  let j = 0
  const push = (list, ch) => {
    const last = list[list.length - 1]
    if (last && last.next === (list === missing ? i : j)) {
      last.text += ch
      last.next += 1
    } else {
      list.push({ text: ch, next: (list === missing ? i : j) + 1 })
    }
  }
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i += 1
      j += 1
    } else if (j >= b.length || (i < a.length && dp[i + 1][j] >= dp[i][j + 1])) {
      push(missing, a[i])
      i += 1
    } else {
      push(extra, b[j])
      j += 1
    }
  }
  const denom = Math.max(a.length, b.length) || 1
  return {
    similarity: dp[0][0] / denom,
    missing: missing.map((x) => x.text),
    extra: extra.map((x) => x.text),
  }
}
