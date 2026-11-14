// lib/engine/index.js — 声音引擎：讯飞、Edge、Ming 用同一种方式调用
//
// 插件自己的工具、音色库界面、对外接口（lib/engine/server.js）都走这里。
// 统一的约定：
//   voice   音色编号。讯飞用原编码（x6_lingfeihan_pro），其他写成 edge:zh-CN-XiaoxiaoNeural、ming:灵小雅；名字也认
//   speed   语速倍数，1 是正常，0.5–2
//   format  mp3 或 wav（没有 ffmpeg 时只能给 wav）
// 只有讯飞扣额度；Edge、Ming 免费，结果也缓存在本机，同样的内容第二次直接给。

import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { engineOpenCached, hasCredentialsCached, openEnginesCached, paths, sourceOnCached } from '../config.js'
import { probeDuration } from '../listen.js'
import { SpeakError, assertSource, countChars, describeResult, findFfmpeg, pcmDurationMs, resolveOutput, synthesize, wavFromPcm, writeOutput } from '../speak.js'
import { defaultVoiceAny, findVoice, resolveVoice, searchVoices } from '../voices.js'
import { ENGINE_INFO, OTHER_VOICES, findOtherVoice, otherCode, splitVoiceId, trialTextFor } from './catalog.js'
import { edgeSpeak, edgeStatus } from './edge.js'
import { mingSpeak, mingStatus } from './ming.js'

export const MAX_FREE_CHARS = 3000
const CACHE_VERSION = 1

const paramError = (summary, hint) => new SpeakError({ kind: 'param', summary, hint })

/** 编号或名字 → { engine, id, name }。不认识的按讯飞处理，让讯飞自己报错 */
export function parseVoice(input) {
  const text = String(input ?? '').trim()
  const split = splitVoiceId(text)
  if (split?.engine === 'xfyun') {
    const code = resolveVoice(split.id)
    return { engine: 'xfyun', id: code, name: findVoice(code)?.name ?? code }
  }
  if (!split && text) {
    const code = resolveVoice(text)
    if (findVoice(code)?.engine) return { engine: 'xfyun', id: code, name: findVoice(code).name }
  }
  const other = findOtherVoice(text)
  if (other) return { engine: other.engine, id: other.voice.id, name: other.voice.name, voice: other.voice }
  if (split) throw paramError(`没有这个音色：${text}`, '用 voices 接口或 voice_voices 查可用的编号')
  return { engine: 'xfyun', id: text, name: text }
}

export const isOtherEngineVoice = (input) => Boolean(input) && parseVoice(input).engine !== 'xfyun'

/** 对外接口用：每家再带上 open，表示别的插件和产品现在能不能用这一家 */
export function engineStatusOpen(env = process.env) {
  const status = engineStatus(env)
  for (const id of Object.keys(status)) status[id].open = engineOpenCached(id)
  return status
}

/** 来源没对外开放时的拒绝理由；开放了返回 null */
export function closedEngine(engine) {
  if (engineOpenCached(engine)) return null
  const where = '到 DSH「设置 → 声音引擎 → 声音引擎接口」勾选'
  if (engine === 'xfyun') return { kind: 'xfyun-closed', summary: '讯飞会扣用户的额度，现在没有对外开放', hint: `要用的话，${where}讯飞，并在展开的详细里打开「允许别的产品用讯飞」；或者换 edge:、ming: 开头的免费音色` }
  const open = openEnginesCached().map((e) => ENGINE_INFO[e].name).join('、')
  return { kind: 'engine-closed', summary: `${ENGINE_INFO[engine].name} 现在没有对外开放`, hint: `要用的话，${where} ${ENGINE_INFO[engine].name}${open ? `；或者换已开放的：${open}` : ''}` }
}

export function engineStatus(env = process.env) {
  return {
    xfyun: { ...ENGINE_INFO.xfyun, ready: hasCredentialsCached(), ...(hasCredentialsCached() ? {} : { reason: '还没有配置讯飞凭据', fix: '到 DSH「设置 → 声音引擎」填写' }) },
    edge: { ...ENGINE_INFO.edge, ...edgeStatus(env) },
    ming: { ...ENGINE_INFO.ming, ...mingStatus(env) },
  }
}

/** Edge、Ming 的音色，字段和讯飞的一致，界面和接口可以混着用 */
export function describeOtherVoice(engine, v, status) {
  return {
    code: otherCode(engine, v),
    name: v.name,
    engine,
    gender: v.gender,
    lang: v.lang,
    ...(v.dialect ? { dialect: v.dialect } : {}),
    ...(v.style ? { style: v.style } : {}),
    hasSample: false,
    free: true,
    status: status.ready ? 'ok' : 'unavailable',
    trialText: trialTextFor(v.lang),
  }
}

export function searchOtherVoices({ engine, query, gender, lang } = {}, env = process.env) {
  const q = String(query ?? '').trim().toLowerCase()
  const status = engineStatus(env)
  const engines = (engine ? [engine] : Object.keys(OTHER_VOICES)).filter(sourceOnCached) // 没勾选的来源不列
  const voices = []
  for (const e of engines) {
    for (const v of OTHER_VOICES[e] ?? []) {
      if (gender && v.gender !== gender) continue
      if (lang && v.lang !== lang) continue
      if (q && ![v.id, v.name, v.style, v.dialect, ENGINE_INFO[e].name].some((s) => String(s ?? '').toLowerCase().includes(q))) continue
      voices.push(describeOtherVoice(e, v, status[e]))
    }
  }
  return { total: voices.length, voices }
}

/** 三家一起查。给对外接口用：讯飞的编号也带上前缀，免得别的产品分不清。only 是对外开放的来源，没开放的不列 */
export function listAllVoices({ engine, query, gender, lang, limit = 500, only } = {}, env = process.env) {
  const out = []
  const allow = (e) => !only || only.includes(e)
  if ((!engine || engine === 'xfyun') && allow('xfyun')) {
    const xf = searchVoices({ query, gender, lang, limit: 1000 })
    out.push(...xf.voices.map((v) => ({ ...v, id: `xfyun:${v.code}`, free: false })))
  }
  if (engine !== 'xfyun') out.push(...searchOtherVoices({ engine, query, gender, lang }, env).voices.filter((v) => allow(v.engine)).map((v) => ({ ...v, id: v.code })))
  return { total: out.length, voices: out.slice(0, limit) }
}

// —— 合成 ——

/** 讯飞的语速是 0–100、50 正常；按倍数大致换算，2 倍约等于 100 */
export const xfyunSpeed = (speed = 1) => Math.round(Math.min(100, Math.max(0, 50 + (Number(speed) - 1) * 50)))

async function viaTemp(ext, write, env) {
  const file = join(tmpdir(), `dsh-voice-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`)
  try {
    const written = await write(file)
    return { ...written, audio: await readFile(written.file) }
  } finally {
    await rm(file, { force: true })
    await rm(file.replace(/\.[^.]+$/, '.wav'), { force: true })
  }
}

/** PCM → 想要的格式。没有 ffmpeg 时给 wav，并说明 */
async function encodePcm(pcm, sampleRate, format, env) {
  if (format === 'wav') return { audio: wavFromPcm(pcm, sampleRate), format: 'wav' }
  const r = await viaTemp('mp3', (file) => writeOutput({ pcm, sampleRate }, { file, format: 'mp3' }, env), env)
  return { audio: r.audio, format: r.format, note: r.note }
}

/** mp3 → wav 要 ffmpeg */
async function mp3To(audio, format, env) {
  if (format !== 'wav') return { audio, format: 'mp3' }
  const bin = await findFfmpeg(env)
  if (!bin) return { audio, format: 'mp3', note: '没有找到 ffmpeg，给的是 mp3' }
  const { spawnSync } = await import('node:child_process')
  const src = join(tmpdir(), `dsh-voice-${process.pid}-${Date.now()}.mp3`)
  const out = src.replace(/\.mp3$/, '.wav')
  try {
    await writeFile(src, audio)
    const r = spawnSync(bin, ['-y', '-loglevel', 'error', '-i', src, '-ac', '1', out])
    if (r.status !== 0) return { audio, format: 'mp3', note: 'ffmpeg 转 wav 失败，给的是 mp3' }
    return { audio: await readFile(out), format: 'wav' }
  } finally {
    await rm(src, { force: true })
    await rm(out, { force: true })
  }
}

const durationOf = async (audio, format, env) => {
  if (format === 'wav' && audio.length > 44) return Math.round(pcmDurationMs(audio.subarray(44), audio.readUInt32LE(24)))
  const file = join(tmpdir(), `dsh-voice-probe-${process.pid}-${Date.now()}.${format}`)
  try {
    await writeFile(file, audio)
    return await probeDuration(file, { env })
  } finally {
    await rm(file, { force: true })
  }
}

/**
 * 合成一段，返回音频内容。
 * @returns {{ audio: Buffer, format: 'mp3'|'wav', contentType: string, engine: string, voice: string, name: string,
 *   durationMs: number|null, charged: number, cached: boolean, warnings: string[], readings?: string }}
 */
export async function synthesizeAny({ voice, text, speed = 1, format = 'mp3', signal }, deps = {}) {
  const env = deps.env ?? process.env
  const body = String(text ?? '').trim()
  if (!body) throw paramError('文本是空的', '请传入要合成的文字')
  const target = format === 'wav' ? 'wav' : 'mp3'
  const rate = Number(speed) || 1
  if (rate < 0.5 || rate > 2) throw paramError('speed 要在 0.5 到 2 之间', '1 是正常语速')
  // 没指定音色时用用户选的默认音色，哪家都行
  const parsed = parseVoice(voice || defaultVoiceAny())
  assertSource(parsed.engine)
  const warnings = []

  if (parsed.engine === 'xfyun') {
    const r = await synthesize({ text: body, vcn: parsed.id, speed: xfyunSpeed(rate), signal }, deps)
    const described = describeResult(r)
    const encoded = await encodePcm(r.pcm, r.sampleRate, target, env)
    if (encoded.note) warnings.push(encoded.note)
    return {
      audio: encoded.audio,
      format: encoded.format,
      contentType: encoded.format === 'wav' ? 'audio/wav' : 'audio/mpeg',
      engine: 'xfyun',
      voice: r.vcn,
      name: described.voiceName,
      durationMs: described.durationMs,
      charged: r.cached ? 0 : countChars(r.text),
      cached: r.cached,
      warnings: [...described.warnings, ...warnings],
      ...(described.readings ? { readings: described.readings } : {}),
    }
  }

  if (countChars(body) > MAX_FREE_CHARS) throw paramError(`一次最多 ${MAX_FREE_CHARS} 字`, '请分段合成')
  const key = createHash('sha256').update(JSON.stringify([CACHE_VERSION, parsed.engine, parsed.id, body, rate, target])).digest('hex')
  const cacheFile = join(paths(env).cache, 'engine', key.slice(0, 2), `${key}.${target}`)
  const meta = `${cacheFile}.json`
  try {
    const [audio, info] = await Promise.all([readFile(cacheFile), readFile(meta, 'utf8')])
    const saved = JSON.parse(info)
    return { audio, ...saved, charged: 0, cached: true, warnings: saved.warnings ?? [] }
  } catch {
    // 还没合成过
  }

  let encoded
  try {
    if (parsed.engine === 'edge') {
      encoded = await mp3To(await edgeSpeak(body, parsed.id, { speed: rate, env, ...(deps.edgeRun ? { run: deps.edgeRun } : {}) }), target, env)
    } else {
      const { pcm, sampleRate } = await mingSpeak(body, parsed.id, { env, ...(deps.mingWorker ? { workerImpl: deps.mingWorker } : {}) })
      encoded = await encodePcm(pcm, sampleRate, target, env)
      if (Math.abs(rate - 1) > 0.01) warnings.push('Ming 没有调语速，用的是正常语速')
    }
  } catch (error) {
    if (error instanceof SpeakError) throw error
    const kind = error.kind === 'missing' || error.kind === 'unsupported' ? 'engine' : (error.kind ?? 'engine')
    const status = engineStatus(env)[parsed.engine]
    throw new SpeakError({ kind, summary: error.message, hint: status.fix ?? status.reason ?? '换一个引擎试试' })
  }
  if (encoded.note) warnings.push(encoded.note)
  const result = {
    format: encoded.format,
    contentType: encoded.format === 'wav' ? 'audio/wav' : 'audio/mpeg',
    engine: parsed.engine,
    voice: otherCode(parsed.engine, { id: parsed.id }),
    name: parsed.name,
    durationMs: await durationOf(encoded.audio, encoded.format, env).catch(() => null),
    warnings: [...warnings, `${ENGINE_INFO[parsed.engine].name} 没有读音反馈，查不了多音字`],
  }
  if (encoded.format === target) {
    await mkdir(dirname(cacheFile), { recursive: true })
    await writeFile(cacheFile, encoded.audio)
    await writeFile(meta, JSON.stringify(result))
  }
  return { audio: encoded.audio, ...result, charged: 0, cached: false }
}

/** 合成后存成文件，voice_speak 用 */
export async function speakAnyToFile({ voice, text, speed = 1, output, format = 'mp3', cwd, signal }, deps = {}) {
  const env = deps.env ?? process.env
  const r = await synthesizeAny({ voice, text, speed, format, signal }, deps)
  const key = createHash('sha256').update(`${r.voice}\n${text}\n${speed}`).digest('hex')
  const target = resolveOutput({ output, cwd, env, text, key, format: r.format })
  const file = target.file.replace(/\.[^.]+$/, `.${r.format}`)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, r.audio)
  return {
    ok: true,
    file,
    format: r.format,
    vcn: r.voice,
    voiceName: r.name,
    engine: r.engine,
    durationMs: r.durationMs ?? 0,
    chars: countChars(text),
    cached: r.cached,
    warnings: r.warnings,
  }
}
