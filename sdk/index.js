// dsh-voice-engine/sdk — 别的程序引用声音引擎，不用自己处理地址和令牌
//
//   import { speak } from 'dsh-voice-engine/sdk'
//   const { audio } = await speak('你好，欢迎收听。', { voice: 'edge:zh-CN-XiaoxiaoNeural', out: 'hello.mp3' })
//
// 只依赖 Node 自带的 fetch（Node 18 以上）。它读 ~/.dsh/dsh-voice-engine/engine.json 里的地址和令牌，
// 调 DSH 里正在运行的声音引擎（或 `dsh-voice-engine serve` 起的那一份）。说明：docs/声音引擎接口.md

import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** engine.json 在哪：DSH_HOME 可以改位置，和插件一致 */
export function engineFilePath(env = process.env) {
  const home = env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'dsh-voice-engine', 'engine.json')
}

export class VoiceEngineError extends Error {
  constructor(message, { kind = 'unknown', hint, status } = {}) {
    super(message)
    this.name = 'VoiceEngineError'
    this.kind = kind
    this.hint = hint
    this.status = status
  }
}

/** 读地址和令牌。可以直接传 { url, token } 跳过 */
export async function connect({ url, token, file = engineFilePath() } = {}) {
  if (url && token) return { url, token }
  let saved
  try {
    saved = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    throw new VoiceEngineError(`没找到 ${file}`, { kind: 'not-running', hint: '打开 DSH（装了 dsh-voice-engine 插件），或运行 dsh-voice-engine serve' })
  }
  return { url: url ?? saved.url, token: token ?? saved.token }
}

async function call(path, { method = 'GET', body, connection } = {}) {
  const { url, token } = await connect(connection)
  let res
  try {
    res = await fetch(`${url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  } catch (error) {
    throw new VoiceEngineError(`连不上声音引擎（${url}）`, { kind: 'not-running', hint: '打开 DSH，或运行 dsh-voice-engine serve', status: 0 })
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new VoiceEngineError(data.error ?? `HTTP ${res.status}`, { kind: data.kind, hint: data.hint, status: res.status })
  }
  return res
}

/** 声音引擎在不在、能不能用。不抛异常，方便先判断再决定要不要退回自己的方案 */
export async function available(connection) {
  try {
    const { url } = await connect(connection)
    const res = await fetch(`${url}/v1/health`)
    return res.ok
  } catch {
    return false
  }
}

/**
 * 合成一段。
 * @param {string} text
 * @param {{ voice?: string, speed?: number, format?: 'mp3'|'wav', out?: string, connection?: {url:string, token:string} }} [options]
 *   voice 如 edge:zh-CN-XiaoxiaoNeural、ming:灵小雅、xfyun:x6_lingfeihan_pro，或只写名字；不传用用户选的默认音色
 *   out 给了就顺手存成文件
 * @returns {Promise<{ audio: Buffer, engine: string, voice: string, format: string, durationMs: number|null, chargedChars: number, cached: boolean, file?: string }>}
 */
export async function speak(text, { voice, speed, format, out, connection } = {}) {
  const res = await call('/v1/speak', { method: 'POST', body: { text, voice, speed, format }, connection })
  const audio = Buffer.from(await res.arrayBuffer())
  const result = {
    audio,
    engine: res.headers.get('x-voice-engine'),
    voice: decodeURIComponent(res.headers.get('x-voice-id') ?? ''),
    format: res.headers.get('x-voice-format'),
    durationMs: Number(res.headers.get('x-voice-duration-ms')) || null,
    chargedChars: Number(res.headers.get('x-voice-charged-chars')) || 0,
    cached: res.headers.get('x-voice-cached') === 'true',
  }
  if (out) {
    await writeFile(out, audio)
    result.file = out
  }
  return result
}

/** 查音色。filter：{ engine: 'edge'|'ming'|'xfyun', q, gender, lang, limit } */
export async function voices(filter = {}, connection) {
  const query = new URLSearchParams(Object.entries(filter).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]))
  return (await call(`/v1/voices${query.size ? `?${query}` : ''}`, { connection })).json()
}

/** 三家现在能不能用 */
export async function engines(connection) {
  return (await (await call('/v1/engines', { connection })).json()).engines
}
