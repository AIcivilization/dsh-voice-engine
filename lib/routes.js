// lib/routes.js — 界面调 host 的接口
//
// 挂在 ctx.connection.fetch（/api 通道）：DSH 自己做 Host/Origin 围栏和登录校验，跨站网页调不到。
// 做法来自 dsh-vps（deepseek-harness-vps）。webServer 本身没有鉴权还可能绑 0.0.0.0，所以不用它。
//
// 凭据只进不出：任何接口都不返回密钥，状态里只有 AppID 尾号。

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  credentialStatus, getState, loadCredentials, markCredentials, paths, saveCredentials, settingsCached, updateSettings,
} from './config.js'
import { formatDoctor, runDoctor, scanVoices } from './doctor.js'
import { partsSnapshot } from './health.js'
import { LANG_HEADER, L, withLang } from './i18n.js'
import { clearPicker, pendingVoices, takeLibraryRequest } from './picker.js'
import { listScenes } from './scenes.js'
import { SpeakError, assertSource, countChars, isCached, pcmDurationMs, planSynth, synthesize, wavFromPcm } from './speak.js'
import { engineStatus, isOtherEngineVoice, parseVoice, searchOtherVoices, synthesizeAny } from './engine/index.js'
import { trialTextFor } from './engine/catalog.js'
import { installEdge } from './engine/edge.js'
import { applyEngineSettings, engineFile, engineServerInfo } from './engine/server.js'
import { defaultVoiceInfo, findVoice, hyperTotal, searchVoices, setDefaultVoice, usableTotal, voiceFacets } from './voices.js'

export const API_PATH = '/api/dsh-voice-engine'
export const AUDIO_PATH = '/api/dsh-voice-engine.audio'
const MAX_TRY_CHARS = 200

const { version } = createRequire(import.meta.url)('../package.json')

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

/** 接口的业务逻辑单独写，测试不用经过 HTTP */
export function createActions(deps = {}) {
  const env = deps.env ?? process.env
  const synthDeps = { env, ...(deps.synth ? { synth: deps.synth } : {}), ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), ...(deps.findFfmpeg ? { findFfmpeg: deps.findFfmpeg } : {}), ...(deps.edgeRun ? { edgeRun: deps.edgeRun } : {}), ...(deps.mingWorker ? { mingWorker: deps.mingWorker } : {}) }

  const trialCost = async (code, text) => {
    if (isOtherEngineVoice(code)) return { chars: 0, cached: false, free: true }
    const plan = planSynth({ text, vcn: code })
    return { chars: countChars(plan.body), cached: await isCached(plan.key, env) }
  }

  const engineInfo = async () => {
    const settings = settingsCached()
    return { ...engineServerInfo(), enabled: settings.engineApi, allowXfyun: settings.engineAllowXfyun, sources: { xfyun: settings.useXfyun, edge: settings.useEdge, ming: settings.useMing }, file: engineFile(env), engines: engineStatus(env) }
  }

  const status = async () => {
    const state = getState()
    const statuses = Object.values(state.voices).map((v) => v.status)
    return {
      version,
      credentials: credentialStatus(await loadCredentials(env)),
      settings: settingsCached(),
      voicesOk: statuses.filter((s) => s === 'ok').length,
      voicesDenied: statuses.filter((s) => s === 'denied').length,
      today: state.usage[new Date().toISOString().slice(0, 10)] ?? { chars: 0, calls: 0 },
      default: defaultVoiceInfo(),
      parts: partsSnapshot(),
      scenes: listScenes(),
    }
  }

  return {
    status,
    async saveCredentials(body) {
      const { swapped } = await saveCredentials(body, env)
      const report = await runDoctor(synthDeps)
      return { swapped, doctor: report, doctorText: formatDoctor(report), status: await status() }
    },
    async clearCredentials() {
      await rm(paths(env).credentials, { force: true })
      markCredentials(false)
      return { status: await status() }
    },
    async doctor() {
      const report = await runDoctor(synthDeps)
      return { doctor: report, doctorText: formatDoctor(report) }
    },
    async scan() {
      const scan = await scanVoices(synthDeps)
      return { scan, status: await status() }
    },
    async settings(body) {
      return { settings: await updateSettings(body, env) }
    },
    async voices(body) {
      if (body.engine === 'edge' || body.engine === 'ming') {
        return searchOtherVoices({ engine: body.engine, query: body.query, gender: body.gender || undefined, lang: body.lang || undefined }, env)
      }
      const found = searchVoices({
        query: body.query,
        gender: body.gender || undefined,
        lang: body.lang || undefined,
        dialect: body.dialect || undefined,
        status: body.status || undefined,
        sample: Boolean(body.sample),
        limit: Math.min(Number(body.limit) || 60, 400),
      })
      // 没有样音的音色要合成才能听：告诉界面要不要花钱
      if (body.trialText) {
        found.voices = await Promise.all(found.voices.map(async (v) => (v.hasSample ? v : { ...v, trial: await trialCost(v.code, body.trialText) })))
      }
      return found
    },
    async voiceMeta() {
      const state = getState()
      const statuses = Object.values(state.voices).map((v) => v.status)
      return {
        default: defaultVoiceInfo(),
        configured: Boolean(await loadCredentials(env)),
        total: usableTotal(),
        // 不能叫 ok：接口外层的 ok 表示成功，0 会把它盖成失败
        readyCount: statuses.filter((s) => s === 'ok').length,
        deniedCount: statuses.filter((s) => s === 'denied').length,
        hyperTotal: hyperTotal(),
        today: state.usage[new Date().toISOString().slice(0, 10)] ?? { chars: 0, calls: 0 },
        facets: voiceFacets(),
        engines: engineStatus(env),
        sources: { xfyun: settingsCached().useXfyun, edge: settingsCached().useEdge, ming: settingsCached().useMing },
      }
    },
    /** 对比前先算：这句话用这几个音色要扣多少字。听过的走缓存，不扣 */
    async trialPlan(body) {
      const codes = Array.isArray(body.codes) ? body.codes.map(String).slice(0, 5) : []
      const text = String(body.text ?? '').trim()
      if (!text) return { voices: codes.map((code) => ({ code, chars: 0, cached: false })), charge: 0 }
      if (countChars(text) > MAX_TRY_CHARS) throw new SpeakError({ kind: 'param', summary: L(`试听文字超过 ${MAX_TRY_CHARS} 字`, `Trial text over ${MAX_TRY_CHARS} characters`), hint: L('取一两句就够了', 'One or two sentences are enough') })
      const voices = await Promise.all(codes.map(async (code) => ({ code, ...(await trialCost(code, text)) })))
      return { voices, charge: voices.reduce((n, v) => n + (v.cached ? 0 : v.chars), 0) }
    },
    async setDefault(body) {
      try {
        return { default: await setDefaultVoice(body.code, env) }
      } catch (error) {
        throw new SpeakError({ kind: 'param', summary: error.message, hint: L('用音色库里的音色', 'Use a voice from the library') })
      }
    },
    engineInfo,
    async engineSettings(body) {
      await updateSettings({
        ...Object.fromEntries(['engineApi', 'engineAllowXfyun', 'useXfyun', 'useEdge', 'useMing'].filter((key) => typeof body[key] === 'boolean').map((key) => [key, body[key]])),
      }, env)
      await applyEngineSettings(deps)
      return engineInfo()
    },
    async installEdge() {
      return { edge: await installEdge(env), engines: engineStatus(env) }
    },
    async picker(body) {
      return { pending: pendingVoices(body.sessionId), openLibrary: takeLibraryRequest(body.sessionId) }
    },
    async pickerClear(body) {
      clearPicker(body.sessionId)
      return {}
    },
  }
}

/** 样音首次播放后落盘：讯飞哪天给 CDN 加防盗链，已听过的还能放 */
async function sampleAudio(code, env, fetchImpl = fetch) {
  const voice = findVoice(code)
  if (!voice?.sample) return null // 只接受目录里的音色编码，不接受任意网址
  const file = join(paths(env).samples, `${createHash('sha256').update(voice.sample).digest('hex').slice(0, 24)}.bin`)
  try {
    return await readFile(file)
  } catch {
    // 还没缓存
  }
  const res = await fetchImpl(encodeURI(voice.sample), { signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new Error(L(`样音下载失败（HTTP ${res.status}）`, `Sample download failed (HTTP ${res.status})`))
  const bytes = Buffer.from(await res.arrayBuffer())
  await mkdir(paths(env).samples, { recursive: true })
  await writeFile(file, bytes)
  return bytes
}

export function createHandlers(deps = {}) {
  const env = deps.env ?? process.env
  const actions = createActions(deps)
  const synthDeps = { env, ...(deps.synth ? { synth: deps.synth } : {}), ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), ...(deps.findFfmpeg ? { findFfmpeg: deps.findFfmpeg } : {}), ...(deps.edgeRun ? { edgeRun: deps.edgeRun } : {}), ...(deps.mingWorker ? { mingWorker: deps.mingWorker } : {}) }

  const readJson = async (request) => {
    if (!String(request.headers.get('content-type') ?? '').includes('application/json')) return null
    try {
      return await request.json()
    } catch {
      return null
    }
  }

  const api = (request) => withLang(request.headers.get(LANG_HEADER), async () => {
    const body = await readJson(request)
    if (!body) return json({ ok: false, error: L('请求格式不对', 'Bad request') }, 400)
    const action = actions[body.action]
    if (typeof action !== 'function') return json({ ok: false, error: L('没有这个操作', 'Unknown action') }, 404)
    try {
      return json({ ok: true, ...(await action(body)) })
    } catch (error) {
      return json({ ok: false, error: error.message, ...(error instanceof SpeakError ? { hint: error.hint, kind: error.kind } : {}) })
    }
  })

  const audio = (request) => withLang(request.headers.get(LANG_HEADER), async () => {
    const body = await readJson(request)
    if (!body?.code) return json({ ok: false, error: L('请求格式不对', 'Bad request') }, 400)
    try {
      assertSource(parseVoice(body.code).engine) // 没勾选的来源连样音也不放
      // Edge、Ming：免费，合成一句来听；结果有缓存
      if (isOtherEngineVoice(body.code)) {
        const r = await synthesizeAny({ voice: body.code, text: body.text || trialTextFor(parseVoice(body.code).voice?.lang), format: 'mp3' }, synthDeps)
        return new Response(r.audio, { headers: { 'content-type': r.contentType, 'cache-control': 'no-store', 'x-xfyun-charged': '0', ...(r.durationMs ? { 'x-xfyun-duration-ms': String(r.durationMs) } : {}) } })
      }
      if (body.text) {
        // 音色库的朗读框也走这里：上限跟设置里的确认阈值一致
        const limit = settingsCached().confirmChars
        if (countChars(body.text) > limit) return json({ ok: false, error: L(`一次最多 ${limit} 字`, `At most ${limit} characters at a time`), hint: L('长文请在对话里让 AI 分段合成', 'For long text, ask the AI to split it') }, 400)
        const r = await synthesize({ text: body.text, vcn: body.code }, synthDeps)
        return new Response(wavFromPcm(r.pcm, r.sampleRate), {
          headers: {
            'content-type': 'audio/wav',
            'cache-control': 'no-store',
            'x-xfyun-charged': String(r.cached ? 0 : countChars(r.text)),
            'x-xfyun-duration-ms': String(Math.round(pcmDurationMs(r.pcm, r.sampleRate))),
          },
        })
      }
      const bytes = await sampleAudio(body.code, env, deps.fetchImpl)
      if (!bytes) return json({ ok: false, error: L('这个音色没有样音，可以用文字试听', 'This voice has no sample. Try it with text') }, 404)
      return new Response(bytes, { headers: { 'content-type': 'audio/wav', 'cache-control': 'no-store', 'x-xfyun-charged': '0' } })
    } catch (error) {
      return json({ ok: false, error: error.message, ...(error instanceof SpeakError ? { hint: error.hint, kind: error.kind } : {}) })
    }
  })

  return { api, audio, actions }
}

export function registerRoutes(fetchApi, deps = {}) {
  const { api, audio } = createHandlers(deps)
  const disposers = [
    fetchApi.register({ path: API_PATH, methods: ['POST'], requestBody: 'buffered', fetch: api }),
    fetchApi.register({ path: AUDIO_PATH, methods: ['POST'], requestBody: 'buffered', fetch: audio }),
  ]
  return () => {
    for (const dispose of disposers) {
      try {
        dispose?.()
      } catch {
        // 反注册失败不影响卸载
      }
    }
  }
}
