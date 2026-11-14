// lib/project.js — 配音工程：以句为单位记录文稿和合成结果，改一句只重配一句
//
// 工程放在 <工作目录>/voice-output/<名字>/，用户能直接看到和备份：
//   manifest.json   文稿、音色、参数、每句的合成记录
//   <名字>.mp3 .srt .ass .vtt
//
// 关键约定（spike/M0-验证报告.md）：
//   - 按句合成，时间轴来自音素时长，音频和读音来自同一次合成（缓存里存在一起）
//   - 没有读音信息的 v2/tts 音色，句子时段按音频字节算，句内按字数估算，并标明来源

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { paths } from './config.js'
import { SpeakError, countChars, describeResult, isCached, pcmDurationMs, planSynth, stripAnnotations, synthesize, writeOutput } from './speak.js'
import { alignTokens, cuesFromTokens, estimateTokens, polishCues, toAss, toSrt, toVtt, tokenize } from './subtitle.js'
import { defaultVoice, findVoice, resolveVoice } from './voices.js'
import { parseRhy, speechSpan } from './xf/rhy.js'

const SCHEMA = 1
const CONCURRENCY = 2
const SPEECH_PAD_MS = 30 // 裁静音时保留一点，避免吃掉字头字尾
const MAX_DRIFT_MS = 200 // 音素合计和音频差这么多，就不能信音素时间了（M0 实测偏差是 0）
const STOP_KINDS = new Set(['credentials', 'service', 'network', 'clock', 'quota'])
// 语速、音调、音量只能整个工程一起调：单独调一句，听起来像换了个人（M2 验收实测）
const PROJECT_ONLY = ['speed', 'pitch', 'volume']
export const SUBTITLE_FORMATS = ['srt', 'ass', 'vtt']

const paramError = (summary, hint) => new SpeakError({ kind: 'param', summary, hint })

// —— 切句 ——

/** 按句末标点和换行切句。模型可以自己断句后传 sentences，这里是没传时的默认做法 */
export function splitSentences(text) {
  const out = []
  const push = (s) => {
    const clean = s.trim()
    if (/[\p{L}\p{N}]/u.test(clean)) out.push(clean)
  }
  for (const para of String(text ?? '').split(/\r?\n+/)) {
    const chars = [...para]
    let current = ''
    for (let i = 0; i < chars.length; i += 1) {
      current += chars[i]
      // 3.14、v1.2 里的点不是句号
      const ends = /[。！？!?；;]/.test(chars[i]) || (chars[i] === '.' && !/[\p{L}\p{N}]/u.test(chars[i + 1] ?? ''))
      if (!ends) continue
      while (/[。！？!?；;.…”’」』）)]/.test(chars[i + 1] ?? '')) current += chars[(i += 1)]
      push(current)
      current = ''
    }
    push(current)
  }
  return out
}

// —— 存取 ——

const rootOf = (cwd, env) => (cwd ? join(cwd, 'voice-output') : paths(env).output)

function safeName(name) {
  const clean = String(name ?? '').trim().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  if (!clean) throw paramError('工程名不能为空', '给工程起个名字，比如「宣传片旁白」')
  return clean
}

const dirOf = (name, cwd, env) => join(rootOf(cwd, env), safeName(name))
const manifestPath = (dir) => join(dir, 'manifest.json')

async function loadProject(name, cwd, env) {
  const dir = dirOf(name, cwd, env)
  try {
    return { dir, project: JSON.parse(await readFile(manifestPath(dir), 'utf8')) }
  } catch (error) {
    if (error.code === 'ENOENT') throw paramError(`没有这个工程：${name}`, '用 action=list 查看工程，或用 action=create 新建')
    throw paramError(`工程文件损坏：${manifestPath(dir)}（${error.message}）`, '请用户检查这个文件')
  }
}

async function saveProject(dir, project) {
  project.updatedAt = new Date().toISOString()
  await mkdir(dir, { recursive: true })
  const tmp = `${manifestPath(dir)}.tmp-${process.pid}`
  await writeFile(tmp, `${JSON.stringify(project, null, 2)}\n`)
  await rename(tmp, manifestPath(dir))
}

const locks = new Map()
/** 模型可能并行调用：同一个工程的操作排队，免得互相覆盖 */
function withLock(dir, fn) {
  const run = (locks.get(dir) ?? Promise.resolve()).catch(() => {}).then(fn)
  const tail = run.catch(() => {})
  locks.set(dir, tail)
  tail.then(() => { if (locks.get(dir) === tail) locks.delete(dir) })
  return run
}

// —— 词表和每句的实际内容 ——

function checkGlossaryEntry(word, marked) {
  if (stripAnnotations(marked) !== word || marked === word) {
    throw paramError(`词表「${word}」的写法不对：${marked}`, '值是加了读音标注的同一个词，如 "调用": "调[=diao4]用"')
  }
}

export function applyGlossary(text, glossary = {}) {
  const words = Object.keys(glossary).sort((a, b) => b.length - a.length)
  if (!words.length) return text
  const escape = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 已经带标注的字不再套词表，免得标注叠加
  const pattern = new RegExp(`(?:${words.map(escape).join('|')})(?!\\[=)`, 'g')
  return text.replace(pattern, (w) => glossary[w] ?? w)
}

function effective(project, sentence) {
  const { speed, pitch, volume } = project.defaults
  return { vcn: sentence.vcn ?? project.defaults.vcn, speed, pitch, volume, text: applyGlossary(sentence.text, project.glossary) }
}

/** 每句这次要发什么，和上次比变没变，有没有缓存 */
async function planSentences(project, env) {
  const out = []
  for (const sentence of project.sentences) {
    const input = effective(project, sentence)
    const plan = planSynth(input)
    out.push({
      sentence,
      input,
      plan,
      changed: sentence.build?.key !== plan.key,
      cached: await isCached(plan.key, env),
      chars: countChars(plan.body),
    })
  }
  return out
}

const scriptChars = (project) => project.sentences.reduce((n, s) => n + countChars(s.text), 0)

// —— 操作 ——

export async function createProject({ name, sentences, text, vcn, speed, pitch, volume, gapMs, targetSeconds, glossary, cwd }, { env = process.env } = {}) {
  const dir = dirOf(name, cwd, env)
  return withLock(dir, async () => {
    const exists = await readFile(manifestPath(dir), 'utf8').then(() => true, () => false)
    if (exists) throw paramError(`工程「${safeName(name)}」已经存在`, '用 action=edit 修改它，或换个名字')
    const list = Array.isArray(sentences) && sentences.length ? sentences.map((s) => String(s).trim()).filter(Boolean) : splitSentences(text)
    if (!list.length) throw paramError('工程没有内容', '请传 sentences（已断好的句子，推荐）或 text')
    for (const [word, marked] of Object.entries(glossary ?? {})) checkGlossaryEntry(word, marked)
    const project = {
      schema: SCHEMA,
      name: safeName(name),
      createdAt: new Date().toISOString(),
      // 音色在创建时定下来，免得默认音色变了之后整个工程都要重配
      defaults: { vcn: resolveVoice(vcn) ?? defaultVoice(), speed: speed ?? 50, pitch: pitch ?? 50, volume: volume ?? 50 },
      gapMs: gapMs ?? null,
      targetMs: targetSeconds ? Math.round(targetSeconds * 1000) : null,
      glossary: glossary ?? {},
      nextId: list.length + 1,
      spentChars: 0,
      builds: 0,
      sentences: list.map((t, i) => ({ id: `s${i + 1}`, text: t })),
      lastBuild: null,
    }
    await saveProject(dir, project)
    return { ok: true, created: true, dir, ...summarize(project) }
  })
}

function summarize(project) {
  return {
    name: project.name,
    vcn: project.defaults.vcn,
    voiceName: findVoice(project.defaults.vcn)?.name ?? project.defaults.vcn,
    speed: project.defaults.speed,
    gapMs: project.gapMs,
    targetMs: project.targetMs,
    chars: scriptChars(project),
    builds: project.builds,
    glossary: project.glossary,
    sentences: project.sentences.map((s) => ({
      id: s.id,
      text: s.text,
      ...(s.vcn !== undefined ? { vcn: s.vcn } : {}),
      ...(s.gapAfterMs !== undefined ? { gapAfterMs: s.gapAfterMs } : {}),
      ...(s.build ? { durationMs: s.build.durationMs, startMs: s.build.startMs, endMs: s.build.endMs, readings: s.build.readings } : {}),
    })),
    lastBuild: project.lastBuild ? { at: project.lastBuild.at, totalMs: project.lastBuild.totalMs, files: project.lastBuild.files } : null,
  }
}

export async function listProjects({ cwd }, { env = process.env } = {}) {
  const root = rootOf(cwd, env)
  const names = await readdir(root).catch(() => [])
  const projects = []
  for (const name of names) {
    try {
      const p = JSON.parse(await readFile(manifestPath(join(root, name)), 'utf8'))
      projects.push({ name: p.name, sentences: p.sentences.length, chars: scriptChars(p), totalMs: p.lastBuild?.totalMs ?? null, updatedAt: p.updatedAt })
    } catch { /* 不是工程目录 */ }
  }
  return { ok: true, projects }
}

export async function showProject({ name, cwd }, { env = process.env } = {}) {
  const { dir, project } = await loadProject(name, cwd, env)
  return { ok: true, dir, ...summarize(project) }
}

/** 按句修改。edits 里的 op：set（默认）、delete、insert（插到 id 这句后面，不传 id 插到开头） */
export async function editProject({ name, edits, glossary, vcn, speed, pitch, volume, gapMs, targetSeconds, cwd }, { env = process.env } = {}) {
  const dir = dirOf(name, cwd, env)
  return withLock(dir, async () => {
    const { project } = await loadProject(name, cwd, env)
    for (const edit of edits ?? []) {
      const op = edit.op ?? 'set'
      const index = project.sentences.findIndex((s) => s.id === edit.id)
      if (op === 'insert') {
        if (edit.id && index < 0) throw paramError(`没有这一句：${edit.id}`, '用 action=show 查看句子编号')
        const text = String(edit.text ?? '').trim()
        if (!text) throw paramError('插入的句子是空的', '请传 text')
        const added = { id: `s${project.nextId}`, text }
        project.nextId += 1
        applySentenceFields(added, edit)
        project.sentences.splice(edit.id ? index + 1 : 0, 0, added)
        continue
      }
      if (index < 0) throw paramError(`没有这一句：${edit.id}`, '用 action=show 查看句子编号')
      if (op === 'delete') {
        if (project.sentences.length === 1) throw paramError('不能删掉最后一句', '要废弃整个工程请新建一个')
        project.sentences.splice(index, 1)
        continue
      }
      if (op !== 'set') throw paramError(`不认识的操作：${op}`, 'op 只能是 set、delete、insert')
      applySentenceFields(project.sentences[index], edit)
    }
    for (const [word, marked] of Object.entries(glossary ?? {})) {
      if (marked === null || marked === '') {
        delete project.glossary[word]
      } else {
        checkGlossaryEntry(word, marked)
        project.glossary[word] = marked
      }
    }
    if (vcn !== undefined) project.defaults.vcn = resolveVoice(vcn) ?? project.defaults.vcn
    if (speed !== undefined) project.defaults.speed = speed
    if (pitch !== undefined) project.defaults.pitch = pitch
    if (volume !== undefined) project.defaults.volume = volume
    if (gapMs !== undefined) project.gapMs = gapMs
    if (targetSeconds !== undefined) project.targetMs = targetSeconds ? Math.round(targetSeconds * 1000) : null
    await saveProject(dir, project)
    return { ok: true, edited: true, ...(await diffOf(project, env)) }
  })
}

function applySentenceFields(sentence, edit) {
  if (edit.text !== undefined) {
    const text = String(edit.text).trim()
    if (!text) throw paramError('句子不能改成空的', '要去掉这一句请用 op=delete')
    sentence.text = text
  }
  const refused = PROJECT_ONLY.filter((key) => edit[key] !== undefined)
  if (refused.length) {
    throw paramError(`不能单独调一句的 ${refused.join('、')}，这样听起来像换了个人`, '要改语气就改这句的文字；要调快慢，用 edit 的顶层 speed 调整个工程')
  }
  if (edit.vcn === null) delete sentence.vcn
  else if (edit.vcn !== undefined) sentence.vcn = resolveVoice(edit.vcn)
  if (edit.gapAfterMs === null) delete sentence.gapAfterMs
  else if (edit.gapAfterMs !== undefined) sentence.gapAfterMs = edit.gapAfterMs
}

/** 和上次导出比，哪些句子要重新合成，要花多少字 */
async function diffOf(project, env) {
  const planned = await planSentences(project, env)
  const previous = project.lastBuild?.order ?? []
  const ids = new Set(project.sentences.map((s) => s.id))
  const kindOfChange = (before, after) => {
    if (before === undefined) return 'new'
    if (before === after) return 'params'
    return stripAnnotations(before) === stripAnnotations(after) ? 'reading' : 'text'
  }
  const changed = planned.filter((p) => p.changed).map((p) => {
    const before = p.sentence.build?.text
    const change = kindOfChange(before, p.plan.body)
    // 只改读音时原文一样，要把标注显示出来才看得出改了什么
    const show = change === 'reading' ? (t) => t : stripAnnotations
    return { id: p.sentence.id, change, ...(before !== undefined ? { before: show(before) } : {}), after: show(p.plan.body), cached: p.cached }
  })
  const removed = previous.filter((p) => !ids.has(p.id))
  const moved = previous.filter((p) => ids.has(p.id)).map((p) => p.id).join() !== project.sentences.filter((s) => previous.some((p) => p.id === s.id)).map((s) => s.id).join()
  return {
    name: project.name,
    changed,
    removed,
    reordered: moved,
    unchanged: planned.length - changed.length,
    charsToSynth: planned.filter((p) => !p.cached).reduce((n, p) => n + p.chars, 0),
  }
}

export async function diffProject({ name, cwd }, { env = process.env } = {}) {
  const { project } = await loadProject(name, cwd, env)
  return { ok: true, ...(await diffOf(project, env)) }
}

/** 导出前算花费，工具用它决定要不要请用户确认 */
export async function planBuild({ name, cwd }, { env = process.env } = {}) {
  const { project } = await loadProject(name, cwd, env)
  const planned = await planSentences(project, env)
  const newChars = planned.filter((p) => !p.cached).reduce((n, p) => n + p.chars, 0)
  return { newChars, spentChars: project.spentChars, scriptChars: scriptChars(project) }
}

// —— 拼接 ——

/** 16 位单声道线性重采样。工程里可能同时有 24k 的超拟人和 16k 的 v2 */
export function resamplePcm(pcm, from, to) {
  if (from === to) return pcm
  const inCount = Math.floor(pcm.length / 2)
  const outCount = Math.round((inCount * to) / from)
  const out = Buffer.alloc(outCount * 2)
  if (!inCount) return out
  for (let i = 0; i < outCount; i += 1) {
    const pos = (i * from) / to
    const left = Math.min(Math.floor(pos), inCount - 1)
    const right = Math.min(left + 1, inCount - 1)
    const frac = pos - left
    const a = pcm.readInt16LE(left * 2)
    const b = pcm.readInt16LE(right * 2)
    out.writeInt16LE(Math.round(a + (b - a) * frac), i * 2)
  }
  return out
}

const msToBytes = (ms, rate) => Math.floor((ms * rate) / 1000) * 2

/**
 * 拼成一条音频，算出每句在成品里的位置。
 * gap 为 null 时保留合成自带的句首句尾静音，听感和 M0 验证过的一致；
 * 设了 gap 就裁掉静音换成固定间隔。v2 没有音素信息，不裁，只加间隔。
 */
export function compose(segments, { gapMs = null } = {}) {
  const rate = Math.max(...segments.map((s) => s.sampleRate))
  const parts = []
  const placed = []
  let bytes = 0
  segments.forEach((seg, i) => {
    const pcm = resamplePcm(seg.pcm, seg.sampleRate, rate)
    const gapAfter = seg.gapAfterMs ?? gapMs
    const gapBefore = i === 0 ? gapMs : (segments[i - 1].gapAfterMs ?? gapMs)
    let from = 0
    let to = pcm.length
    if (seg.speech && gapBefore !== null) from = msToBytes(Math.max(0, seg.speech.startMs - SPEECH_PAD_MS), rate)
    if (seg.speech && gapAfter !== null) to = Math.min(pcm.length, msToBytes(seg.speech.endMs + SPEECH_PAD_MS, rate))
    if (to <= from) { from = 0; to = pcm.length }
    const fromMs = (from / 2 / rate) * 1000
    const startMs = (bytes / 2 / rate) * 1000
    parts.push(pcm.subarray(from, to))
    bytes += to - from
    placed.push({ startMs: Math.round(startMs), endMs: Math.round((bytes / 2 / rate) * 1000), offsetMs: startMs - fromMs })
    if (i < segments.length - 1 && gapAfter !== null && gapAfter > 0) {
      const silence = Buffer.alloc(msToBytes(gapAfter, rate))
      parts.push(silence)
      bytes += silence.length
    }
  })
  return { pcm: Buffer.concat(parts), sampleRate: rate, placed, totalMs: Math.round((bytes / 2 / rate) * 1000) }
}

// —— 导出 ——

/** 一句的字幕，时间相对这句音频的开头 */
export function sentenceCues(text, result, { maxWidth } = {}) {
  const tokens = tokenize(text)
  const parsed = result.rhy ? parseRhy(result.rhy) : null
  const audioMs = pcmDurationMs(result.pcm, result.sampleRate)
  let report = { missed: [], extra: [], lost: false }
  let source = 'phoneme'
  let driftMs = 0
  if (parsed?.units.length) {
    report = alignTokens(tokens, parsed.units)
    driftMs = Math.round(Math.abs(parsed.totalMs - audioMs))
    if (report.lost || driftMs > MAX_DRIFT_MS) source = 'estimate'
  } else {
    source = 'bytes'
    estimateTokens(tokens, 0, Math.round(audioMs))
  }
  return { cues: cuesFromTokens(tokens, { maxWidth }), report, source, driftMs }
}

function shift(cues, offsetMs) {
  const move = (ms) => Math.round(ms + offsetMs)
  return cues.map((c) => ({ ...c, startMs: move(c.startMs), endMs: move(c.endMs), words: c.words.map((w) => ({ ...w, startMs: move(w.startMs), endMs: move(w.endMs) })) }))
}

function durationCheck(project, totalMs) {
  if (!project.targetMs) return { ok: true, skipped: true, actualMs: totalMs }
  const tolerance = Math.max(1000, project.targetMs * 0.03)
  const deltaMs = totalMs - project.targetMs
  return { ok: Math.abs(deltaMs) <= tolerance, actualMs: totalMs, targetMs: project.targetMs, deltaMs, toleranceMs: Math.round(tolerance) }
}

function coverageCheck(records, cues) {
  const problems = []
  for (const r of records) {
    if (r.durationMs <= 0) problems.push(`${r.id} 没有音频`)
    if (r.report.missed.length) problems.push(`${r.id} 可能漏读：${r.report.missed.join('')}`)
    if (r.report.extra.length) problems.push(`${r.id} 读音里有原文没有的内容：${r.report.extra.join('')}`)
    if (r.report.lost) problems.push(`${r.id} 读音和原文对不上，这句字幕时间不准`)
    if (r.driftMs > MAX_DRIFT_MS) problems.push(`${r.id} 音素时长和音频差 ${r.driftMs} 毫秒，这句字幕时间不准`)
  }
  cues.forEach((c, i) => {
    if (i && c.startMs < cues[i - 1].endMs) problems.push(`字幕 ${i} 和 ${i + 1} 时间重叠`)
  })
  return { ok: problems.length === 0, problems }
}

export async function buildProject({ name, formats, audioFormat = 'mp3', karaoke = false, portrait = false, maxWidth, cwd, signal }, deps = {}) {
  const env = deps.env ?? process.env
  const dir = dirOf(name, cwd, env)
  return withLock(dir, async () => {
    const { project } = await loadProject(name, cwd, env)
    const wanted = (formats?.length ? formats : ['srt']).map((f) => String(f).toLowerCase())
    const unknown = wanted.filter((f) => !SUBTITLE_FORMATS.includes(f))
    if (unknown.length) throw paramError(`不支持的字幕格式：${unknown.join('、')}`, `可选：${SUBTITLE_FORMATS.join('、')}`)

    const planned = await planSentences(project, env)
    const results = new Array(planned.length)
    const failed = []
    let stopped = null
    let next = 0
    const worker = async () => {
      while (next < planned.length && !stopped && !signal?.aborted) {
        const index = next
        next += 1
        const p = planned[index]
        try {
          results[index] = await synthesize({ ...p.input, signal }, deps)
        } catch (error) {
          if (!(error instanceof SpeakError)) throw error
          failed.push({ id: p.sentence.id, text: stripAnnotations(p.plan.body), kind: error.kind, error: error.message, hint: error.hint, alternatives: error.alternatives })
          if (STOP_KINDS.has(error.kind)) stopped = error.kind
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))

    const spent = planned.reduce((n, p, i) => n + (results[i] && !results[i].cached ? p.chars : 0), 0)
    project.spentChars += spent
    if (failed.length || stopped || signal?.aborted) {
      await saveProject(dir, project)
      return {
        ok: false,
        kind: failed[0]?.kind ?? 'aborted',
        error: failed.length ? `${failed.length} 句合成失败，没有导出` : '已中止，没有导出',
        hint: failed[0]?.hint ?? '再次调用 build 继续，已合成的句子不重复扣量',
        failed,
        ...(failed[0]?.alternatives?.length ? { alternatives: failed[0].alternatives } : {}),
        doneSentences: results.filter(Boolean).length,
        totalSentences: planned.length,
        chars: spent,
      }
    }

    const segments = planned.map((p, i) => {
      const r = results[i]
      const parsed = r.rhy ? parseRhy(r.rhy) : null
      return { pcm: r.pcm, sampleRate: r.sampleRate, speech: parsed ? speechSpan(parsed) : null, gapAfterMs: p.sentence.gapAfterMs ?? null }
    })
    const { pcm, sampleRate, placed, totalMs } = compose(segments, { gapMs: project.gapMs })

    let cues = []
    const records = planned.map((p, i) => {
      const r = results[i]
      const { cues: own, report, source, driftMs } = sentenceCues(p.plan.body, r, { maxWidth })
      cues = cues.concat(shift(own, placed[i].offsetMs))
      const described = describeResult(r)
      p.sentence.build = {
        key: p.plan.key,
        text: p.plan.body,
        vcn: p.plan.code,
        engine: p.plan.engine,
        durationMs: described.durationMs,
        startMs: placed[i].startMs,
        endMs: placed[i].endMs,
        ...(described.readings ? { readings: described.readings } : {}),
        timing: source,
      }
      return { id: p.sentence.id, durationMs: described.durationMs, readings: described.readings, changed: p.changed, report, source, driftMs, warnings: r.warnings ?? [] }
    })
    cues = polishCues(cues)

    const base = project.name
    const audio = await writeOutput({ pcm, sampleRate }, { file: join(dir, `${base}.${audioFormat}`), format: audioFormat }, env)
    const files = { audio: audio.file }
    for (const format of wanted) {
      const content = format === 'srt' ? toSrt(cues) : format === 'vtt' ? toVtt(cues) : toAss(cues, { karaoke, portrait })
      files[format] = join(dir, `${base}.${format}`)
      await writeFile(files[format], content)
    }

    const checks = {
      duration: durationCheck(project, totalMs),
      coverage: coverageCheck(records, cues),
    }
    const timing = { phoneme: 0, bytes: 0, estimate: 0 }
    for (const r of records) timing[r.source] += 1
    project.builds += 1
    project.lastBuild = {
      at: new Date().toISOString(),
      totalMs,
      files,
      checks,
      order: project.sentences.map((s) => ({ id: s.id, text: stripAnnotations(s.text) })),
    }
    await saveProject(dir, project)

    const changed = records.filter((r) => r.changed)
    return {
      ok: true,
      built: true,
      name: project.name,
      dir,
      files,
      totalMs,
      sentences: records.length,
      cues: cues.length,
      resynthesized: changed.map((r) => r.id),
      reused: records.length - changed.length,
      chars: spent,
      spentChars: project.spentChars,
      builds: project.builds,
      timing,
      maxDriftMs: Math.max(...records.map((r) => r.driftMs)),
      checks,
      // 只给这次变了的句子的读音：没变的上次已经查过，省上下文
      pronunciation: changed.filter((r) => r.readings?.includes('[')).map((r) => ({ id: r.id, readings: r.readings })),
      warnings: [...new Set(records.flatMap((r) => r.warnings)), ...(audio.note ? [audio.note] : [])],
    }
  })
}
