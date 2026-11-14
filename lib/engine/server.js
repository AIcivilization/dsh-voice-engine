// lib/engine/server.js — 对外接口：别的插件、别的产品通过本机 HTTP 用这个声音引擎
//
// 说明文档：docs/声音引擎接口.md
//   - 只监听 127.0.0.1，别的电脑连不上
//   - 要带令牌。地址和令牌写在 ~/.dsh/dsh-voice-engine/engine.json（权限 600），只有本机这个用户读得到
//   - 检查 Host 头，网页用 DNS 重绑定也打不进来
//   - 讯飞会扣用户的额度，默认不对外开放，要用户在设置页打开；Edge、Ming 免费，默认可用

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { atomicWrite, paths, settingsCached } from '../config.js'
import { SpeakError } from '../speak.js'
import { engineStatus, listAllVoices, parseVoice, synthesizeAny } from './index.js'

export const DEFAULT_PORT = 18321
const MAX_BODY = 64 * 1024
const { version } = createRequire(import.meta.url)('../../package.json')

export const engineFile = (env = process.env) => join(paths(env).root, 'engine.json')

/** 令牌一直用同一个，别的产品配置一次就行；要换就删掉 engine.json 再重启 */
async function loadToken(env) {
  try {
    const saved = JSON.parse(await readFile(engineFile(env), 'utf8'))
    if (typeof saved.token === 'string' && saved.token.length >= 32) return saved.token
  } catch {
    // 第一次
  }
  return randomBytes(24).toString('base64url')
}

const sameToken = (a, b) => {
  const x = Buffer.from(String(a ?? ''))
  const y = Buffer.from(String(b ?? ''))
  return x.length === y.length && timingSafeEqual(x, y)
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

const fail = (res, status, kind, error, hint) => json(res, status, { ok: false, kind, error, ...(hint ? { hint } : {}) })

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('请求太大'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 请求处理，单独导出方便测试 */
export function createEngineHandler({ token, port, deps = {} }) {
  const env = deps.env ?? process.env
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`])

  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (!allowedHosts.has(String(req.headers.host ?? ''))) return fail(res, 403, 'host', '只接受本机地址的请求')
      if (url.pathname === '/v1/health') return json(res, 200, { ok: true, name: 'dsh-voice-engine', version })

      const given = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || req.headers['x-voice-token']
      if (!sameToken(given, token)) return fail(res, 401, 'token', '令牌不对', `令牌在 ${engineFile(env)} 的 token 字段`)

      if (req.method === 'GET' && url.pathname === '/v1/engines') {
        const status = engineStatus(env)
        status.xfyun.open = settingsCached().engineAllowXfyun
        return json(res, 200, { ok: true, engines: status })
      }
      if (req.method === 'GET' && url.pathname === '/v1/voices') {
        const q = Object.fromEntries(url.searchParams)
        const list = listAllVoices({ engine: q.engine || undefined, query: q.q, gender: q.gender || undefined, lang: q.lang || undefined, limit: Math.min(Number(q.limit) || 500, 1000) }, env)
        return json(res, 200, { ok: true, ...list })
      }
      if (req.method === 'POST' && url.pathname === '/v1/speak') {
        let body
        try {
          body = JSON.parse(await readBody(req))
        } catch (error) {
          return fail(res, error.status ?? 400, 'param', error.status ? error.message : '请求体要是 JSON')
        }
        const text = String(body?.text ?? '')
        let voice
        try {
          voice = parseVoice(body?.voice || settingsCached().defaultVcn || '')
        } catch (error) {
          return fail(res, 400, 'param', error.message, error.hint)
        }
        if (voice.engine === 'xfyun') {
          if (!settingsCached().engineAllowXfyun) {
            return fail(res, 403, 'xfyun-closed', '讯飞会扣你的额度，现在没有对外开放', '要用的话，到 DSH「设置 → 声音引擎 → 声音引擎接口」打开；或者换 edge:、ming: 开头的免费音色')
          }
          const limit = settingsCached().confirmChars
          if ([...text].length > limit) return fail(res, 400, 'too-long', `讯飞一次最多 ${limit} 字（设置页的确认阈值）`, '请分段')
        }
        const r = await synthesizeAny({ voice: body.voice, text, speed: body.speed ?? 1, format: body.format }, deps)
        res.writeHead(200, {
          'content-type': r.contentType,
          'cache-control': 'no-store',
          'x-voice-engine': r.engine,
          'x-voice-id': encodeURIComponent(r.voice),
          'x-voice-format': r.format,
          'x-voice-duration-ms': String(r.durationMs ?? ''),
          'x-voice-charged-chars': String(r.charged),
          'x-voice-cached': String(r.cached),
        })
        return res.end(r.audio)
      }
      return fail(res, 404, 'not-found', '没有这个接口', '可用：GET /v1/health、GET /v1/engines、GET /v1/voices、POST /v1/speak')
    } catch (error) {
      if (error instanceof SpeakError) return fail(res, error.kind === 'param' ? 400 : 502, error.kind, error.message, error.hint)
      return fail(res, 500, 'unknown', error.message ?? String(error))
    }
  }
}

/** 启动。端口被占就往后找；地址和令牌写进 engine.json */
export async function startEngineServer({ port = DEFAULT_PORT, deps = {}, tries = 10 } = {}) {
  const env = deps.env ?? process.env
  const token = await loadToken(env)
  let lastError
  for (let p = port; p < port + tries; p += 1) {
    const server = createServer(createEngineHandler({ token, port: p, deps }))
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(p, '127.0.0.1', resolve)
      })
      server.unref() // 不因为它而不让进程退出：DSH 自己会一直开着，测试和命令行跑完就该退出
      const url = `http://127.0.0.1:${p}`
      await atomicWrite(engineFile(env), `${JSON.stringify({ url, port: p, token, pid: process.pid, startedAt: new Date().toISOString(), docs: 'docs/声音引擎接口.md' }, null, 2)}\n`)
      return { url, port: p, token, close: () => new Promise((done) => server.close(() => done())) }
    } catch (error) {
      lastError = error
      server.close()
      if (error.code !== 'EADDRINUSE') break
    }
  }
  throw lastError ?? new Error('启动失败')
}

// —— 插件里用：按设置开关，只跑一份 ——

let current = null
let starting = null

export const engineServerInfo = () => (current ? { running: true, url: current.url, port: current.port } : { running: false })

export async function applyEngineSettings(deps = {}) {
  await starting
  const want = settingsCached().engineApi
  if (want && !current) {
    starting = startEngineServer({ port: settingsCached().enginePort, deps }).then((s) => { current = s }).finally(() => { starting = null })
    await starting
  } else if (!want && current) {
    const s = current
    current = null
    await s.close()
  }
  return engineServerInfo()
}

export async function stopEngineServer() {
  await starting?.catch(() => {})
  const s = current
  current = null
  if (s) await s.close()
}
