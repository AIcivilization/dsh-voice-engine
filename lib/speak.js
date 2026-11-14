// lib/speak.js — 合成：缓存、路由到引擎、把结果变成模型读得懂的文字
//
// 关键约定（都来自 spike/M0-验证报告.md）：
//   - 读音用 字[=拼音] 标注，只有超拟人支持；发给 v2/tts 会被念成「调94用」，必须去掉
//   - 音频和读音必须来自同一次合成：同一段文字两次合成时长会不同，所以缓存里存在一起
//   - 时长看音素，不看字节：音频首尾带静音，字节时长不等于说话时长

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { addUsage, credentialProblem, loadCredentials, markVoice, paths, sourceOnCached, sourcesOnCached } from './config.js'
import { explainCode, explainHandshake } from './xf/errors.js'
import { inlineReadings, parseRhy, speechSpan } from './xf/rhy.js'
import { ConnectError, HYPER_MAX_BYTES, V2_MAX_BYTES, XfError, handshakeMessage, hyperSynth, v2Synth } from './xf/tts.js'
import { POLYPHONES, PREFERRED_HYPER, V2_PROBE, defaultVoice, engineOf, findVoice, knownOkVoices, resolveVoice } from './voices.js'

const CACHE_VERSION = 1
const ANNOTATION = /([一-鿿])\[=[a-z]+[1-5]\]/g
const READINGS_LIMIT = 3000

export class SpeakError extends Error {
  constructor(explained, { code, alternatives } = {}) {
    super(explained.summary)
    this.name = 'SpeakError'
    this.kind = explained.kind
    this.hint = explained.hint
    this.code = code
    this.alternatives = alternatives
  }
}

const SOURCE_NAME = { xfyun: '讯飞', edge: 'Edge', ming: 'Ming' }

/** 用户在设置页没勾选这个来源就不用它，并告诉模型换哪家 */
export function assertSource(engine) {
  if (sourceOnCached(engine)) return
  const on = sourcesOnCached().map((e) => SOURCE_NAME[e]).join('、')
  throw new SpeakError({
    kind: 'source-off',
    summary: `用户没有启用${SOURCE_NAME[engine] ?? engine}`,
    hint: `${on ? `换已启用的来源：${on}` : '现在一个来源都没启用'}；要用${SOURCE_NAME[engine] ?? engine}，请用户到「设置 → 声音引擎 → 声音引擎接口」勾选`,
  })
}

export const stripAnnotations = (text) => String(text).replace(ANNOTATION, '$1')
export const hasAnnotations = (text) => stripAnnotations(text) !== String(text)
export const countChars = (text) => [...stripAnnotations(text)].filter((c) => !/\s/.test(c)).length

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

// —— ffmpeg：桌面版启动的进程 PATH 很短，常见位置都试一遍 ——

function ffmpegCandidates(env) {
  return [env.FFMPEG_PATH, 'ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', join(homedir(), 'bin/ffmpeg')].filter(Boolean)
}

function runFfmpeg(bin, args) {
  return new Promise((done) => {
    const child = spawn(bin, args, { stdio: 'ignore' })
    child.on('error', () => done(false))
    child.on('exit', (code) => done(code === 0))
  })
}

let ffmpegBin
export async function findFfmpeg(env = process.env) {
  if (ffmpegBin !== undefined) return ffmpegBin
  for (const bin of ffmpegCandidates(env)) {
    if (await runFfmpeg(bin, ['-version'])) {
      ffmpegBin = bin
      return bin
    }
  }
  ffmpegBin = null
  return null
}
export const _resetFfmpeg = () => { ffmpegBin = undefined }

// —— 输出位置 ——

function slugOf(text) {
  return [...stripAnnotations(text).replace(/[^\p{L}\p{N}]+/gu, '')].slice(0, 12).join('') || 'audio'
}

export function resolveOutput({ output, cwd, env, text, key, format }) {
  const name = `${slugOf(text)}-${key.slice(0, 8)}`
  if (!output) {
    const dir = cwd ? join(cwd, 'voice-output') : paths(env).output
    return { file: join(dir, `${name}.${format}`), format }
  }
  const absolute = isAbsolute(output) ? output : resolve(cwd ?? paths(env).output, output)
  if (/[/\\]$/.test(output) || !extname(absolute)) return { file: join(absolute, `${name}.${format}`), format }
  const ext = extname(absolute).slice(1).toLowerCase()
  return { file: absolute, format: ext === 'wav' ? 'wav' : 'mp3' }
}

// —— 合成和缓存 ——

function cacheKey({ engine, vcn, text, speed, volume, pitch }) {
  return createHash('sha256').update(JSON.stringify([CACHE_VERSION, engine, vcn, text, speed, volume, pitch])).digest('hex')
}

async function readCache(key, env) {
  const base = join(paths(env).cache, key.slice(0, 2), key)
  try {
    const [pcm, meta] = await Promise.all([readFile(`${base}.pcm`), readFile(`${base}.json`, 'utf8')])
    return { pcm, ...JSON.parse(meta) }
  } catch {
    return null
  }
}

async function writeCache(key, result, env) {
  const base = join(paths(env).cache, key.slice(0, 2), key)
  await mkdir(dirname(base), { recursive: true })
  await writeFile(`${base}.pcm`, result.pcm)
  await writeFile(`${base}.json`, JSON.stringify({ engine: result.engine, sampleRate: result.sampleRate, rhy: result.rhy }))
}

/** 拿不到凭据或填错时报告，不去请求接口 */
async function requireCredentials(env) {
  const creds = await loadCredentials(env)
  if (!creds) {
    throw new SpeakError({ kind: 'credentials', summary: '还没有配置讯飞凭据', hint: '请用户到「设置 → 声音引擎」填写 AppID、APISecret、APIKey' })
  }
  const problem = credentialProblem(creds)
  if (problem) throw new SpeakError({ kind: 'credentials', summary: problem.text, hint: '请用户到「设置 → 声音引擎」重新填写' })
  return creds
}

const SYNTH = { hyper: hyperSynth, v2: v2Synth }

/** 一个音色的轻量探测：能用就顺手记下。只合成两个字 */
export async function probeVoice(code, { creds, env = process.env, synth = SYNTH, signal } = {}) {
  const engine = engineOf(code)
  try {
    await synth[engine]('你好', { creds, vcn: code, signal })
    await markVoice(code, 'ok', env)
    return { code, ok: true }
  } catch (error) {
    if (error instanceof XfError && error.code === 11200) await markVoice(code, 'denied', env)
    return { code, ok: false, error }
  }
}

/** 11200 分不清是服务没开还是音色没授权：没有任何已知可用音色时，用官方免费音色试一下才知道 */
async function explainDenied(engine, vcn, { creds, env, synth, signal }) {
  let ok = knownOkVoices(engine).filter((code) => code !== vcn)
  if (!ok.length) {
    const probes = engine === 'hyper' ? PREFERRED_HYPER.slice(0, 3) : [V2_PROBE]
    for (const code of probes.filter((c) => c !== vcn)) {
      const r = await probeVoice(code, { creds, env, synth, signal })
      if (r.ok) ok = [code]
      if (r.ok) break
    }
  }
  const explained = explainCode(11200, { engine, vcn, allFailed: ok.length === 0 })
  return new SpeakError(explained, { code: 11200, alternatives: ok.slice(0, 5) })
}

async function explainConnect(error, creds, fetchImpl) {
  const info = await handshakeMessage(error.url, creds, { fetchImpl })
  return new SpeakError(explainHandshake(info, creds))
}

/** 算出这次合成实际发给讯飞的内容和缓存 key，不发请求。工程靠它判断哪些句子变了 */
export function planSynth({ text, vcn, speed = 50, volume = 50, pitch = 50 }) {
  const code = resolveVoice(vcn) ?? defaultVoice()
  const engine = engineOf(code)
  const warnings = []
  let body = String(text ?? '').trim()
  if (!body) throw new SpeakError({ kind: 'param', summary: '文本是空的', hint: '请传入要合成的文字' })

  if (engine === 'v2' && hasAnnotations(body)) {
    body = stripAnnotations(body)
    warnings.push(`音色 ${code} 走 v2/tts，不支持读音标注，已去掉标注。需要改读音请换超拟人音色`)
  }
  const bytes = Buffer.byteLength(body)
  const limit = engine === 'hyper' ? HYPER_MAX_BYTES : V2_MAX_BYTES
  if (bytes > limit) {
    throw new SpeakError({ kind: 'param', summary: `文本太长（${bytes} 字节，上限 ${limit}）`, hint: '请分段合成' })
  }
  return { code, engine, body, warnings, key: cacheKey({ engine, vcn: code, text: body, speed, volume, pitch }) }
}

export async function isCached(key, env = process.env) {
  const base = join(paths(env).cache, key.slice(0, 2), key)
  try {
    await Promise.all([access(`${base}.pcm`), access(`${base}.json`)])
    return true
  } catch {
    return false
  }
}

/** 合成一段文字（有缓存就直接用），不写输出文件 */
export async function synthesize({ text, vcn, speed = 50, volume = 50, pitch = 50, signal }, { env = process.env, synth = SYNTH, fetchImpl } = {}) {
  assertSource('xfyun')
  const creds = await requireCredentials(env)
  const { code, engine, body, warnings, key } = planSynth({ text, vcn, speed, volume, pitch })
  const cached = await readCache(key, env)
  if (cached) return { ...cached, key, vcn: code, text: body, cached: true, warnings }

  try {
    const result = await synth[engine](body, { creds, vcn: code, speed, volume, pitch, signal })
    if (!result.pcm.length) throw new SpeakError({ kind: 'unknown', summary: '讯飞没有返回音频', hint: '检查文本是否只有标点或特殊符号' })
    await writeCache(key, result, env)
    await Promise.all([markVoice(code, 'ok', env), addUsage(countChars(body), env)])
    return { ...result, key, vcn: code, text: body, cached: false, warnings }
  } catch (error) {
    if (error instanceof XfError && error.code === 11200) {
      await markVoice(code, 'denied', env)
      throw await explainDenied(engine, code, { creds, env, synth, signal })
    }
    if (error instanceof XfError) throw new SpeakError(explainCode(error.code, { engine, vcn: code }), { code: error.code })
    if (error instanceof ConnectError) throw await explainConnect(error, creds, fetchImpl)
    throw error
  }
}

export async function writeOutput(result, target, env) {
  await mkdir(dirname(target.file), { recursive: true })
  const wav = wavFromPcm(result.pcm, result.sampleRate)
  if (target.format === 'wav') {
    await writeFile(target.file, wav)
    return { file: target.file, format: 'wav' }
  }
  const bin = await findFfmpeg(env)
  if (!bin) {
    const file = target.file.replace(/\.[^.]+$/, '.wav')
    await writeFile(file, wav)
    return { file, format: 'wav', note: '没有找到 ffmpeg，输出了 wav。要 mp3 请安装 ffmpeg' }
  }
  const tmp = `${target.file}.src.wav`
  await writeFile(tmp, wav)
  const ok = await runFfmpeg(bin, ['-y', '-loglevel', 'error', '-i', tmp, '-codec:a', 'libmp3lame', '-q:a', '2', target.file])
  await rm(tmp, { force: true })
  if (!ok) {
    const file = target.file.replace(/\.[^.]+$/, '.wav')
    await writeFile(file, wav)
    return { file, format: 'wav', note: 'ffmpeg 转 mp3 失败，输出了 wav' }
  }
  return { file: target.file, format: 'mp3' }
}

/** 把合成结果整理成给模型看的内容 */
export function describeResult(result) {
  const parsed = result.rhy ? parseRhy(result.rhy) : null
  const durationMs = Math.round(pcmDurationMs(result.pcm, result.sampleRate))
  const voice = findVoice(result.vcn)
  const out = {
    ok: true,
    vcn: result.vcn,
    voiceName: voice?.name ?? result.vcn,
    engine: result.engine,
    durationMs,
    chars: countChars(result.text),
    cached: result.cached,
    warnings: [...(result.warnings ?? [])],
  }
  if (parsed) {
    const span = speechSpan(parsed)
    out.speech = span
    out.readings = inlineReadings(parsed.units, POLYPHONES)
    if (parsed.unparsed.length) out.warnings.push(`有 ${parsed.unparsed.length} 段读音信息解析不了，时间可能有偏差`)
  } else {
    out.warnings.push('这个音色走 v2/tts，没有读音信息，查不了多音字；时长是音频总长，含首尾静音')
  }
  return out
}

/** 完整流程：合成、写文件、返回描述 */
export async function speak({ text, vcn, speed, volume, pitch, output, format = 'mp3', cwd, signal }, deps = {}) {
  const env = deps.env ?? process.env
  const result = await synthesize({ text, vcn, speed, volume, pitch, signal }, deps)
  const target = resolveOutput({ output, cwd, env, text: result.text, key: result.key, format })
  const written = await writeOutput(result, target, env)
  const out = describeResult(result)
  out.file = written.file
  out.format = written.format
  if (written.note) out.warnings.push(written.note)
  if (out.readings && out.readings.length > READINGS_LIMIT) {
    const readingsFile = `${written.file}.readings.txt`
    await writeFile(readingsFile, out.readings)
    out.readingsFile = readingsFile
    out.readings = `${out.readings.slice(0, READINGS_LIMIT)}…（太长，完整读音见 ${basename(readingsFile)}）`
  }
  return out
}
