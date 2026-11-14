// lib/scenes.js — 30 个固定场景：声明在 scenes/scenes.json，手册在 scenes/playbooks/
//
// 手册按需读取，不一次塞给模型。代码类场景可以直接运行，不经过模型判断；
// AI 类场景没有 run，模型读手册后用基本能力完成。

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { paths } from './config.js'
import { SpeakError, countChars, speak } from './speak.js'
import { searchVoices } from './voices.js'

export const AVAILABLE_MILESTONES = new Set(['M1', 'M2', 'M3'])
const STOP_KINDS = new Set(['credentials', 'service', 'network', 'clock', 'quota'])
const MAX_BATCH = 500
const MAX_COMPARE = 5
const MAX_TRY_CHARS = 200
const MODE_LABEL = { code: '代码', hybrid: '混合', ai: 'AI' }

const SCENES = JSON.parse(readFileSync(new URL('../scenes/scenes.json', import.meta.url), 'utf8'))

const withStatus = (scene) => ({ ...scene, status: AVAILABLE_MILESTONES.has(scene.milestone) ? 'available' : 'planned' })

export function listScenes({ status } = {}) {
  return SCENES.map(withStatus)
    .filter((s) => !status || s.status === status)
    .map(({ id, name, group, mode, say, status: st, milestone }) => ({ id, name, group, mode: MODE_LABEL[mode], say, status: st, milestone }))
}

export async function getScene(id) {
  const scene = SCENES.find((s) => s.id === String(id ?? '').toUpperCase())
  if (!scene) return null
  const out = withStatus(scene)
  if (scene.playbook) {
    out.playbookText = await readFile(new URL(`../scenes/playbooks/${scene.playbook}`, import.meta.url), 'utf8')
  }
  return out
}

/** 清单文件：每行一条，「文件名,文本」或只有文本；# 开头和空行跳过 */
export function parseBatch(content) {
  const items = []
  const used = new Set()
  String(content).split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const m = line.match(/^([\w一-鿿.-]{1,80})[,，\t]\s*(.+)$/)
    const text = m ? m[2].trim() : line
    const base = (m ? m[1] : `${String(items.length + 1).padStart(3, '0')}`).replace(/\.[^.]+$/, '')
    let name = base
    for (let n = 2; used.has(name); n += 1) name = `${base}-${n}`
    used.add(name)
    items.push({ line: index + 1, name, text })
  })
  return items
}

export async function planBatch({ file, cwd, env = process.env }) {
  if (!file) throw new SpeakError({ kind: 'param', summary: '缺少清单文件', hint: '请传 file，每行一条提示语' })
  const path = isAbsolute(file) ? file : resolve(cwd ?? paths(env).output, file)
  let content
  try {
    content = await readFile(path, 'utf8')
  } catch {
    throw new SpeakError({ kind: 'param', summary: `读不到清单文件：${path}`, hint: '检查路径' })
  }
  const items = parseBatch(content)
  if (!items.length) throw new SpeakError({ kind: 'param', summary: '清单是空的', hint: '每行一条提示语，# 开头的行会跳过' })
  if (items.length > MAX_BATCH) throw new SpeakError({ kind: 'param', summary: `清单有 ${items.length} 条，上限 ${MAX_BATCH}`, hint: '请分批处理' })
  return { path, items, chars: items.reduce((n, item) => n + countChars(item.text), 0) }
}

/** 批量合成。已合成的走缓存，所以中断后重跑不重复扣量 */
export async function runBatch({ file, vcn, format = 'mp3', outputDir, cwd, signal, concurrency = 2 }, deps = {}) {
  const env = deps.env ?? process.env
  const plan = await planBatch({ file, cwd, env })
  const base = cwd ?? paths(env).output
  const dir = outputDir
    ? (isAbsolute(outputDir) ? outputDir : resolve(base, outputDir))
    : join(base, 'voice-output', basename(plan.path, extname(plan.path)))
  const queue = [...plan.items]
  const done = []
  const failed = []
  let stopped = null

  const worker = async () => {
    while (queue.length && !stopped && !signal?.aborted) {
      const item = queue.shift()
      try {
        const r = await speak({ text: item.text, vcn, format, output: join(dir, `${item.name}.${format}`), cwd, signal }, deps)
        done.push({
          line: item.line,
          name: item.name,
          file: r.file,
          durationMs: r.durationMs,
          cached: r.cached,
          // 没有多音字的行不用模型看，省上下文
          ...(r.readings?.includes('[') ? { readings: r.readings } : {}),
          ...(r.warnings.length ? { warnings: r.warnings } : {}),
        })
      } catch (error) {
        if (!(error instanceof SpeakError)) throw error
        failed.push({ line: item.line, name: item.name, kind: error.kind, error: error.message, hint: error.hint, alternatives: error.alternatives })
        // 凭据、服务这类问题后面每条都会失败，没必要继续请求
        if (STOP_KINDS.has(error.kind)) stopped = error.kind
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  done.sort((a, b) => a.line - b.line)
  failed.sort((a, b) => a.line - b.line)
  return {
    ok: failed.length === 0 && !stopped,
    outputDir: dir,
    total: plan.items.length,
    chars: plan.chars,
    done,
    failed,
    ...(stopped ? { stopped, skipped: queue.length } : {}),
  }
}

/** 同一句话用几个音色各合成一次。某个音色未授权不影响其他音色 */
export async function compareVoices({ voices, text, format = 'mp3', cwd, signal }, deps = {}) {
  const list = (Array.isArray(voices) ? voices : String(voices ?? '').split(/[,，\s]+/)).map((v) => String(v).trim()).filter(Boolean)
  if (!list.length) throw new SpeakError({ kind: 'param', summary: '没有指定音色', hint: '请传 voices' })
  if (list.length > MAX_COMPARE) throw new SpeakError({ kind: 'param', summary: `一次最多比较 ${MAX_COMPARE} 个音色`, hint: '先用 voice_voices 缩小范围' })
  if (countChars(text ?? '') > MAX_TRY_CHARS) throw new SpeakError({ kind: 'param', summary: `试音文本超过 ${MAX_TRY_CHARS} 字`, hint: '取一两句就够了' })
  const results = []
  for (const vcn of list) {
    try {
      results.push(await speak({ text, vcn, format, cwd, signal }, deps))
    } catch (error) {
      if (!(error instanceof SpeakError)) throw error
      if (STOP_KINDS.has(error.kind)) throw error
      results.push({ ok: false, vcn, kind: error.kind, error: error.message, hint: error.hint, alternatives: error.alternatives })
    }
  }
  return { ok: results.some((r) => r.ok), results }
}

export async function runScene(id, args = {}, deps = {}) {
  const scene = await getScene(id)
  if (!scene) throw new SpeakError({ kind: 'param', summary: `没有这个场景：${id}`, hint: '用 action=list 查看清单' })
  if (scene.status === 'planned') {
    throw new SpeakError({ kind: 'planned', summary: `「${scene.name}」还没做好（计划在 ${scene.milestone}）`, hint: '如实告诉用户，并询问是否用别的方式完成' })
  }
  switch (scene.id) {
    case 'S08':
      return speak(args, deps)
    case 'S13':
      return runBatch(args, deps)
    case 'S21':
      return { ok: true, ...searchVoices(args) }
    case 'S22':
      return compareVoices(args, deps)
    default:
      throw new SpeakError({ kind: 'param', summary: `「${scene.name}」不能直接运行`, hint: '这个场景由你来完成：用 action=get 读手册，然后按手册操作' })
  }
}
