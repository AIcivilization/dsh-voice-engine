// lib/xf/ost.js — 极速录音转写：上传、建任务、查结果、解析
//
// 官方文档：https://www.xfyun.cn/doc/asr/speedTranscription/API.html
// 实测（spike/M0-验证报告.md）：
//   - 任务刚创建就查可能返回 10401 no data found，不代表失败
//   - 服务没开通时报 licc failed
// 文档：文件不超过 500M、不超过 5 小时；小于 30M 直接上传，大的分块；说话人分离不支持 mp3；结果保留 7 天

import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'

const UPLOAD_HOST = 'upload-ost-api.xfyun.cn'
const API_HOST = 'ost-api.xfyun.cn'

export const DIRECT_UPLOAD_LIMIT = 30 * 1024 * 1024
export const SLICE_BYTES = 20 * 1024 * 1024
export const MAX_FILE_BYTES = 500 * 1024 * 1024
export const MAX_DURATION_MS = 5 * 60 * 60 * 1000
export const RESULT_KEEP_MS = 7 * 24 * 60 * 60 * 1000
export const SERVICE_URL = 'https://console.xfyun.cn/services/ost'

/** 接口返回的业务错误 */
export class OstError extends Error {
  constructor(code, message, { status } = {}) {
    super(String(message ?? `讯飞错误 ${code}`))
    this.name = 'OstError'
    this.code = code
    this.status = status
  }
}

export function signHeaders({ host, path, body, contentType }, { apiKey, apiSecret }, date = new Date().toUTCString()) {
  const digest = `SHA-256=${createHash('sha256').update(body).digest('base64')}`
  const signature = createHmac('sha256', apiSecret).update(`host: ${host}\ndate: ${date}\nPOST ${path} HTTP/1.1\ndigest: ${digest}`, 'utf8').digest('base64')
  return {
    host,
    date,
    digest,
    'content-type': contentType,
    authorization: `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line digest", signature="${signature}"`,
  }
}

async function post({ host, path, body, contentType, creds, fetchImpl = fetch, signal }) {
  const response = await fetchImpl(`https://${host}${path}`, { method: 'POST', headers: signHeaders({ host, path, body, contentType }, creds), body, signal })
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new OstError(`http-${response.status}`, text.slice(0, 200) || `HTTP ${response.status}`, { status: response.status })
  }
  // 鉴权失败时返回的是 {"message":"..."}，没有 code
  if (!response.ok && parsed?.code === undefined) throw new OstError(`http-${response.status}`, parsed?.message ?? `HTTP ${response.status}`, { status: response.status })
  return parsed
}

const assertOk = (result) => {
  if (result?.code !== 0) throw new OstError(result?.code ?? 'unknown', result?.message)
  return result
}

const requestId = () => randomUUID().replace(/-/g, '')

function multipart(fields, file) {
  const boundary = `----xf${randomBytes(12).toString('hex')}`
  const parts = Object.entries(fields).map(([name, value]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="data"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), file.data, Buffer.from('\r\n'))
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
}

const postUpload = async (path, fields, file, opts) => {
  const { body, contentType } = multipart(fields, file)
  return assertOk(await post({ host: UPLOAD_HOST, path, body, contentType, ...opts }))
}

/**
 * 上传音频，返回讯飞给的地址。
 * read(start, end) 读文件的一段，大文件不用整个放进内存。
 */
export async function uploadAudio({ size, name, read }, opts) {
  const { creds } = opts
  const base = { app_id: creds.appId, request_id: requestId() }
  if (size < DIRECT_UPLOAD_LIMIT) {
    const result = await postUpload('/file/upload', base, { name, data: await read(0, size) }, opts)
    return result.data.url
  }
  const init = await postUpload('/file/mpupload/init', base, null, opts)
  const uploadId = init.data.upload_id
  let slice = 1
  for (let start = 0; start < size; start += SLICE_BYTES) {
    const data = await read(start, Math.min(start + SLICE_BYTES, size))
    await postUpload('/file/mpupload/upload', { ...base, upload_id: uploadId, slice_id: slice }, { name, data }, opts)
    slice += 1
  }
  const done = await postUpload('/file/mpupload/complete', { ...base, upload_id: uploadId }, null, opts)
  return done.data.url
}

export async function createTask({ url, encoding, size, durationMs, speakers = false, speakerCount = 0, hotwords = [], domain }, opts) {
  const business = { request_id: requestId(), language: 'zh_cn', accent: 'mandarin', domain: 'pro_ost_ed' }
  if (speakers) {
    business.vspp_on = 1
    business.speaker_num = speakerCount
  }
  if (hotwords.length) business.dhw = hotwords.join(',')
  if (domain) business.pd = domain
  if (durationMs) business.duration = Math.ceil(durationMs / 1000)
  const body = JSON.stringify({
    common: { app_id: opts.creds.appId },
    business,
    data: { audio_url: url, audio_src: 'http', format: 'audio/L16;rate=16000', encoding, ...(size ? { audio_size: size } : {}) },
  })
  const result = assertOk(await post({ host: API_HOST, path: '/v2/ost/pro_create', body, contentType: 'application/json', ...opts }))
  return result.data.task_id
}

/** 查一次。返回 { done, result }；还没好时 done 是 false */
export async function queryTask(taskId, opts) {
  const body = JSON.stringify({ common: { app_id: opts.creds.appId }, business: { task_id: taskId } })
  const raw = await post({ host: API_HOST, path: '/v2/ost/query', body, contentType: 'application/json', ...opts })
  if (raw?.code === 10401) return { done: false, notFound: true }
  const result = assertOk(raw)
  const status = String(result.data?.task_status ?? '')
  if (status === '3' || status === '4') return { done: true, result }
  if (status === '-1') throw new OstError('task-failed', result.data?.message ?? '讯飞转写失败')
  return { done: false, status }
}

const stOf = (item) => {
  // 官方两种接口格式不同：这里是对象，录音文件转写是 JSON 字符串
  const best = typeof item?.json_1best === 'string' ? JSON.parse(item.json_1best) : item?.json_1best
  return best?.st ?? null
}

/**
 * 变成按句的结构，时间都换算成整段音频的毫秒。
 * wb、we 是相对于句子开头的帧，1 帧 10ms。标点也算进文字，但没有时长。
 */
export function parseOstResult(result, { speakers = false } = {}) {
  const lattice = result?.data?.result?.lattice ?? []
  const names = new Map()
  const speakerOf = (raw) => {
    if (!speakers || raw === undefined || raw === null) return null
    const key = String(raw)
    if (!names.has(key)) names.set(key, `说话人${names.size + 1}`)
    return names.get(key)
  }
  const segments = []
  for (const item of lattice) {
    const st = stOf(item)
    if (!st) continue
    const bg = Number(st.bg ?? item.begin ?? 0)
    const words = []
    for (const rt of st.rt ?? []) {
      for (const ws of rt.ws ?? []) {
        const cw = ws.cw?.[0]
        if (!cw?.w || cw.wp === 'g') continue
        words.push({ text: cw.w, startMs: bg + Number(ws.wb ?? 0) * 10, endMs: bg + Number(ws.we ?? 0) * 10, punct: cw.wp === 'p' })
      }
    }
    if (!words.length) continue
    segments.push({
      startMs: bg,
      endMs: Number(st.ed ?? item.end ?? bg),
      speaker: speakerOf(st.rl ?? item.spk),
      text: words.map((w) => w.text).join(''),
      words,
    })
  }
  // file_length 是文件字节数，不是时长（实测：23 秒的 48kbps mp3 返回 138500）
  return { segments, durationMs: segments.at(-1)?.endMs ?? 0, speakers: [...names.values()] }
}
