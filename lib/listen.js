// lib/listen.js — 转写：音频或视频 → 文稿和字幕
//
//   - 同一个文件加同样的选项只花一次钱：任务号一拿到就落盘，结果也落盘，中断或重复调用都接得上
//   - 长文稿不塞进对话：给模型看摘要和文件路径，要细看就读文件
//   - 只等一会儿：超时返回 running，模型再调一次就接着等，不会重新提交

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { addListenUsage, credentialProblem, loadCredentials, paths } from './config.js'
import { SpeakError, findFfmpeg } from './speak.js'
import { cuesFromTokens, polishCues, spreadTime, toSrt, toVtt, tokenize } from './subtitle.js'
import { MAX_DURATION_MS, MAX_FILE_BYTES, OstError, RESULT_KEEP_MS, SERVICE_URL, createTask, parseOstResult, queryTask, uploadAudio } from './xf/ost.js'

const CACHE_VERSION = 1
const WAIT_MS = 180_000
const POLL_MS = [2000, 3000, 5000]
const NOT_FOUND_RETRIES = 8
const PREVIEW_CHARS = 1500
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.flv', '.m4v', '.wmv', '.ts'])

export const DOMAINS = ['court', 'edu', 'finance', 'medical', 'tech', 'sport', 'gov', 'game', 'ecom', 'car']

const paramError = (summary, hint) => new SpeakError({ kind: 'param', summary, hint })

/** 把转写接口的错误翻译成下一步该做什么 */
export function explainOst(error) {
  const code = String(error.code ?? '')
  const text = String(error.message ?? '')
  if (/licc/i.test(text)) return { kind: 'service', summary: '极速录音转写还不能用', hint: `服务没开通或时长用完了，请到 ${SERVICE_URL} 确认选的是同一个应用` }
  if (error.status === 401 || /signature|apikey/i.test(text)) return { kind: 'credentials', summary: '讯飞凭据没通过校验', hint: '请用户到「设置 → 声音引擎」确认三项凭据来自同一个应用' }
  if (error.status === 403 || /clock|date/i.test(text)) return { kind: 'clock', summary: '电脑时间不准', hint: '讯飞要求和服务器时间相差不超过 5 分钟，请校准系统时间' }
  if (code === '20304') return { kind: 'audio', summary: '讯飞认为这段音频是静音或格式不对', hint: '确认文件里有声音；可以安装 ffmpeg，插件会自动转换格式' }
  if (code === '10043' || code === '10107') return { kind: 'audio', summary: '讯飞解不开这段音频', hint: '文件可能损坏或加密。安装 ffmpeg 后插件会先转换格式' }
  if (code === '10303') return { kind: 'param', summary: '讯飞不接受这次的参数', hint: `检查选项。讯飞原话：${text}` }
  if (code === 'task-failed') return { kind: 'audio', summary: `讯飞转写失败：${text}`, hint: '确认音频能正常播放，再请用户决定要不要重试' }
  return { kind: 'unknown', summary: `转写失败（${code}）：${text}`, hint: '告诉用户原因，用户同意才能换别的方案' }
}

// —— 文件和 ffmpeg ——

function resolveInput(file, cwd, env) {
  if (!file) throw paramError('缺少文件', '请传本机的音频或视频路径')
  if (/^https?:\/\//i.test(file)) throw paramError('暂不支持网址', '请先把文件下载到本机')
  return isAbsolute(file) ? file : resolve(cwd ?? paths(env).output, file)
}

async function hashFile(path, options) {
  const hash = createHash('sha256').update(JSON.stringify([CACHE_VERSION, options]))
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** ffmpeg 不带输出时把信息写到 stderr，从那里读时长 */
export function parseFfmpegDuration(text) {
  const m = String(text).match(/Duration:\s*(\d+):(\d{2}):(\d{2})(?:\.(\d+))?/)
  if (!m) return null
  return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 + Math.round(Number(`0.${m[4] ?? 0}`) * 1000)
}

function ffmpegRun(bin, args, signal) {
  return new Promise((done) => {
    let stderr = ''
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], signal })
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-20000) })
    child.on('error', () => done({ ok: false, stderr }))
    child.on('exit', (code) => done({ ok: code === 0, stderr }))
  })
}

const ffmpegOf = ({ env = process.env, findFfmpeg: find = findFfmpeg } = {}) => find(env)

export async function probeDuration(path, deps = {}) {
  const bin = await ffmpegOf(deps)
  if (!bin) return null
  const { stderr } = await ffmpegRun(bin, ['-hide_banner', '-i', path])
  return parseFfmpegDuration(stderr)
}

/** 讯飞要 16k 单声道。说话人分离不支持 mp3，要转成 wav */
async function prepareAudio(path, { speakers, signal }, key, deps) {
  const env = deps.env ?? process.env
  const ext = extname(path).toLowerCase()
  const bin = await ffmpegOf(deps)
  if (!bin) {
    if (VIDEO_EXT.has(ext)) throw paramError('处理视频需要 ffmpeg', '请用户安装 ffmpeg，比如 brew install ffmpeg')
    if (ext !== '.mp3' && ext !== '.wav') throw paramError(`没有 ffmpeg，转换不了 ${ext || '这种'} 格式`, '请用户安装 ffmpeg，或提供 16k 单声道的 mp3、wav')
    if (speakers && ext === '.mp3') throw paramError('说话人分离不支持 mp3，转换格式需要 ffmpeg', '请用户安装 ffmpeg，或提供 16k 单声道的 wav')
    return { file: path, encoding: ext === '.mp3' ? 'lame' : 'raw', temp: false }
  }
  const dir = join(paths(env).cache, 'listen', key)
  await mkdir(dir, { recursive: true })
  const out = join(dir, speakers ? 'audio.wav' : 'audio.mp3')
  const codec = speakers ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'libmp3lame', '-b:a', '48k']
  const { ok, stderr } = await ffmpegRun(bin, ['-y', '-hide_banner', '-loglevel', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '16000', ...codec, out], signal)
  if (!ok) throw new SpeakError({ kind: 'audio', summary: '这个文件提取不出音频', hint: `确认文件里有声音、能正常播放。ffmpeg：${stderr.trim().slice(0, 200)}` })
  return { file: out, encoding: speakers ? 'raw' : 'lame', temp: true }
}

// —— 记录：任务号和结果立即落盘 ——

const recordDir = (key, env) => join(paths(env).cache, 'listen', key)

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

async function writeJson(path, value) {
  const tmp = `${path}.tmp-${process.pid}`
  await writeFile(tmp, JSON.stringify(value))
  await rename(tmp, path)
}

const locks = new Map()
/** 同一个文件同时只提交一次，否则并行调用会重复扣费 */
function withLock(key, fn) {
  const run = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(fn)
  const tail = run.catch(() => {})
  locks.set(key, tail)
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key) })
  return run
}

const defaultSleep = (ms, signal) => new Promise((done) => {
  const timer = setTimeout(done, ms)
  signal?.addEventListener('abort', () => { clearTimeout(timer); done() }, { once: true })
})

async function pollResult(taskId, opts, { waitMs, sleep, signal, now }) {
  const deadline = now() + waitMs
  let notFound = 0
  for (let round = 0; ; round += 1) {
    const r = await queryTask(taskId, opts)
    if (r.done) return r.result
    if (r.notFound) {
      notFound += 1
      if (notFound > NOT_FOUND_RETRIES) return { lost: true }
    }
    if (signal?.aborted || now() >= deadline) return null
    await sleep(POLL_MS[Math.min(round, POLL_MS.length - 1)], signal)
  }
}

// —— 导出 ——

const clock = (ms) => {
  const s = Math.floor(ms / 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`
}

export function toPlainText(segments, { speakers = false } = {}) {
  if (!speakers) return `${segments.map((s) => s.text).join('\n')}\n`
  const out = []
  let last = null
  for (const s of segments) {
    if (s.speaker !== last) out.push(`\n[${clock(s.startMs)}] ${s.speaker ?? ''}：`)
    last = s.speaker
    out.push(s.text)
  }
  return `${out.join('\n').trim()}\n`
}

/** 字幕按词的时间切，太长的句子拆成几条 */
export function segmentsToCues(segments, { maxWidth, speakers = false } = {}) {
  const cues = []
  let last = null
  for (const seg of segments) {
    const tokens = []
    for (const word of seg.words) {
      const parts = tokenize(word.text)
      spreadTime(parts, word.startMs, word.endMs)
      tokens.push(...parts)
    }
    const own = cuesFromTokens(tokens, { maxWidth })
    if (speakers && seg.speaker && seg.speaker !== last && own[0]) own[0].text = `${seg.speaker}：${own[0].text}`
    last = seg.speaker
    cues.push(...own)
  }
  return polishCues(cues)
}

async function exportResult(parsed, { input, outputDir, cwd, env, speakers, maxWidth }) {
  const base = basename(input, extname(input)).replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'audio'
  const root = cwd ? join(cwd, 'voice-output') : paths(env).output
  const dir = outputDir ? (isAbsolute(outputDir) ? outputDir : resolve(cwd ?? root, outputDir)) : join(root, `${base}-转写`)
  await mkdir(dir, { recursive: true })
  const cues = segmentsToCues(parsed.segments, { maxWidth, speakers })
  const files = { txt: join(dir, `${base}.txt`), srt: join(dir, `${base}.srt`), vtt: join(dir, `${base}.vtt`), json: join(dir, `${base}.json`) }
  await writeFile(files.txt, toPlainText(parsed.segments, { speakers }))
  await writeFile(files.srt, toSrt(cues))
  await writeFile(files.vtt, toVtt(cues))
  await writeFile(files.json, `${JSON.stringify({ source: input, durationMs: parsed.durationMs, speakers: parsed.speakers, segments: parsed.segments }, null, 2)}\n`)
  return { files, cues: cues.length }
}

// —— 对外 ——

const optionsOf = ({ speakers = false, speakerCount = 0, hotwords = [], domain = null }) => ({
  speakers: Boolean(speakers),
  speakerCount: speakers ? Number(speakerCount) || 0 : 0,
  hotwords: [...hotwords].map(String).sort(),
  domain: domain || null,
})

/** 开始之前先看要花多少：有记录就不花钱 */
export async function planTranscribe({ file, cwd, ...rest }, deps = {}) {
  const env = deps.env ?? process.env
  const input = resolveInput(file, cwd, env)
  const info = await stat(input).catch(() => null)
  if (!info?.isFile()) throw paramError(`读不到文件：${input}`, '检查路径')
  if (info.size > MAX_FILE_BYTES * 4) throw paramError('文件太大', '讯飞要求转换后不超过 500M，请先裁剪')
  const key = await hashFile(input, optionsOf(rest))
  const dir = recordDir(key, env)
  const paid = Boolean((await readJson(join(dir, 'result.json'))) || (await readJson(join(dir, 'task.json'))))
  return { input, key, paid, size: info.size, durationMs: paid ? null : await probeDuration(input, deps) }
}

/**
 * 转写一个文件。返回 { ok, status:'done', files, ... }，
 * 等太久时返回 { ok:true, status:'running' }，再调一次会接着等，不重新提交。
 */
export async function transcribe({ file, speakers = false, speakerCount = 0, hotwords = [], domain, outputDir, maxWidth, cwd, signal }, deps = {}) {
  const env = deps.env ?? process.env
  const fetchImpl = deps.fetchImpl
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? Date.now
  const waitMs = deps.waitMs ?? WAIT_MS
  if (domain && !DOMAINS.includes(domain)) throw paramError(`不认识的领域：${domain}`, `可选：${DOMAINS.join('、')}`)
  const options = optionsOf({ speakers, speakerCount, hotwords, domain })
  const plan = await planTranscribe({ file, cwd, ...options }, deps)
  const dir = recordDir(plan.key, env)

  const creds = await loadCredentials(env)
  if (!creds) throw new SpeakError({ kind: 'credentials', summary: '还没有配置讯飞凭据', hint: '请用户到「设置 → 声音引擎」填写' })
  const problem = credentialProblem(creds)
  if (problem) throw new SpeakError({ kind: 'credentials', summary: problem.text, hint: '请用户到「设置 → 声音引擎」重新填写' })
  const opts = { creds, fetchImpl, signal }

  return withLock(plan.key, async () => {
    await mkdir(dir, { recursive: true })
    const resultPath = join(dir, 'result.json')
    const taskPath = join(dir, 'task.json')
    let raw = await readJson(resultPath)
    const reused = Boolean(raw)
    let resumed = false
    let durationMs = plan.durationMs
    try {
      if (!raw) {
        let task = await readJson(taskPath)
        if (task && now() - task.createdAt > RESULT_KEEP_MS) task = null // 讯飞只保留 7 天
        resumed = Boolean(task)
        if (!task) {
          const prepared = await prepareAudio(plan.input, { speakers: options.speakers, signal }, plan.key, deps)
          const info = await stat(prepared.file)
          if (info.size > MAX_FILE_BYTES) throw paramError(`转换后 ${Math.round(info.size / 1048576)}M，超过讯飞 500M 的上限`, '请先裁剪')
          durationMs = (await probeDuration(prepared.file, deps)) ?? durationMs
          if (durationMs && durationMs > MAX_DURATION_MS) throw paramError('音频超过讯飞 5 小时的上限', '请先裁剪')
          const handle = await open(prepared.file)
          let url
          try {
            url = await uploadAudio({
              size: info.size,
              name: basename(prepared.file),
              read: async (start, end) => {
                const buffer = Buffer.alloc(end - start)
                await handle.read(buffer, 0, end - start, start)
                return buffer
              },
            }, opts)
          } finally {
            await handle.close()
          }
          const taskId = await createTask({ url, encoding: prepared.encoding, size: info.size, durationMs, ...options }, opts)
          task = { taskId, createdAt: now(), source: plan.input, durationMs }
          await writeJson(taskPath, task) // 这一步之后才算花钱，马上落盘
          await addListenUsage(durationMs ?? 0, env)
          if (prepared.temp) await rm(prepared.file, { force: true })
        }
        durationMs = task.durationMs ?? durationMs
        const result = await pollResult(task.taskId, opts, { waitMs, sleep, signal, now })
        if (result?.lost) {
          await rm(taskPath, { force: true })
          throw new SpeakError({ kind: 'lost', summary: '讯飞查不到这个任务了', hint: '可能已过期。再次调用会重新提交，要消耗转写额度，先问用户' })
        }
        if (!result) {
          return { ok: true, status: 'running', taskId: task.taskId, durationMs: task.durationMs ?? null, hint: '讯飞还在转写，任务已保存。用同样的参数再调一次就接着等，不会重复扣费' }
        }
        raw = result
        await writeJson(resultPath, raw)
      }
    } catch (error) {
      if (error instanceof OstError) throw new SpeakError(explainOst(error), { code: error.code })
      if (error.name === 'AbortError' || signal?.aborted) throw new SpeakError({ kind: 'aborted', summary: '已中止', hint: '再次调用可以继续，已提交的任务不重复扣费' })
      if (error instanceof SpeakError) throw error
      if (error instanceof TypeError) throw new SpeakError({ kind: 'network', summary: '连不上讯飞服务器', hint: `检查网络或代理设置（${error.cause?.message ?? error.message}）` })
      throw error
    }

    const parsed = parseOstResult(raw, { speakers: options.speakers })
    // 优先用 ffmpeg 读到的真实时长；没有 ffmpeg 时只能用最后一句的结束时间
    const taskDuration = (await readJson(taskPath))?.durationMs
    if (taskDuration) parsed.durationMs = taskDuration
    if (!parsed.segments.length) {
      return { ok: true, status: 'done', empty: true, cached: reused, resumed, hint: '讯飞没有转写出文字。音频可能没有人声，请告诉用户' }
    }
    const { files, cues } = await exportResult(parsed, { input: plan.input, outputDir, cwd, env, speakers: options.speakers, maxWidth })
    const text = parsed.segments.map((s) => s.text).join('')
    return {
      ok: true,
      status: 'done',
      cached: reused,
      resumed,
      durationMs: parsed.durationMs,
      chars: [...text].length,
      segments: parsed.segments.length,
      cues,
      speakers: parsed.speakers,
      files,
      text: [...text].slice(0, PREVIEW_CHARS).join(''),
      truncated: [...text].length > PREVIEW_CHARS,
    }
  })
}

// —— 回听：对比原稿和实际读出来的内容 ——

const normalize = (text) => String(text).toLowerCase().replace(/\[=[a-z]+[1-5]\]/g, '').replace(/[^\p{L}\p{N}]+/gu, '')

/** 逐字比较，返回原稿有、听到没有（missing）和听到有、原稿没有（extra）的片段 */
export function diffText(expected, heard) {
  const a = [...normalize(expected)]
  const b = [...normalize(heard)]
  const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const missing = []
  const extra = []
  const push = (list, c, adjacent) => {
    if (adjacent && list.length) list[list.length - 1] += c
    else list.push(c)
  }
  let i = 0
  let j = 0
  let last = null
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i += 1
      j += 1
      last = null
    } else if (j >= b.length || (i < a.length && table[i + 1][j] >= table[i][j + 1])) {
      push(missing, a[i], last === 'm')
      i += 1
      last = 'm'
    } else {
      push(extra, b[j], last === 'e')
      j += 1
      last = 'e'
    }
  }
  return { missing, extra }
}

/** 按时间把听到的词分给工程里的每一句，然后逐句比较 */
export function compareToScript(sentences, segments) {
  const heard = sentences.map(() => '')
  for (const word of segments.flatMap((s) => s.words)) {
    if (word.punct) continue
    const mid = (word.startMs + word.endMs) / 2
    let best = 0
    let distance = Infinity
    sentences.forEach((s, i) => {
      const d = mid < s.startMs ? s.startMs - mid : mid > s.endMs ? mid - s.endMs : 0
      if (d < distance) {
        distance = d
        best = i
      }
    })
    heard[best] += word.text
  }
  return sentences.flatMap((s, i) => {
    const { missing, extra } = diffText(s.text, heard[i])
    if (!missing.length && !extra.length) return []
    return [{ id: s.id, expected: s.text, heard: heard[i], missing, extra, hasNumbers: /\d/.test(s.text) }]
  })
}
