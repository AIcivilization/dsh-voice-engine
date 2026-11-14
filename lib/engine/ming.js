// lib/engine/ming.js — Mac 本机 Ming 语音（离线、免费）
//
// Ming-3.0-tts-0.5B（inclusionAI，MIT）的 MLX 8 位版，经 mlx-audio 在 Apple 芯片上合成。
// 本插件不下载模型（约 1.6 GB）：直接用 dsh-her 或「听懂」（dsh-go）已经装好的那一份。
// 合成时起一个常驻的 Python 进程（python/ming_worker.py，来自 dsh-go），占约 2 GB 内存；闲置几分钟自动退出。

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, release } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dshHome } from '../config.js'
import { spokenNumbers } from './spoken.js'

export const MING_WORKER = fileURLToPath(new URL('../../python/ming_worker.py', import.meta.url))
const IDLE_MS = 5 * 60 * 1000

/** 官方声音表里适合旁白、有声书的一部分，照 dsh-go；带「_中性」的有几种情绪版本 */
export const MING_VOICES = [
  { id: '灵小雅', name: '灵小雅', gender: 'female', lang: 'zh', style: '甜美，新闻、有声书' },
  { id: '灵朵儿', name: '灵朵儿', gender: 'female', lang: 'zh', style: '温暖知性，纪录片' },
  { id: '灵小萌', name: '灵小萌', gender: 'female', lang: 'zh', style: '清亮，有声书、电台' },
  { id: '灵小梨', name: '灵小梨', gender: 'female', lang: 'zh', style: '轻柔，有声书' },
  { id: '灵小柔', name: '灵小柔', gender: 'female', lang: 'zh', style: '温柔礼貌' },
  { id: '灵心恬_中性', name: '灵心恬', gender: 'female', lang: 'zh', style: '冷静客观，新闻' },
  { id: '灵风信_中性', name: '灵风信', gender: 'female', lang: 'zh', style: '体贴温暖' },
  { id: '灵楷', name: '灵楷', gender: 'male', lang: 'zh', style: '舒缓温暖，纪录片' },
  { id: '灵阅川_中性', name: '灵阅川', gender: 'male', lang: 'zh', style: '浑厚，纪录片、历史' },
  { id: '灵小锋', name: '灵小锋', gender: 'male', lang: 'zh', style: '温和稳重，讲解' },
  { id: '灵旭', name: '灵旭', gender: 'male', lang: 'zh', style: '清亮温柔，有声书' },
  { id: '灵江', name: '灵江', gender: 'male', lang: 'zh', style: '温暖，旁白' },
  { id: '灵语尘_中性', name: '灵语尘', gender: 'male', lang: 'zh', style: '低沉，独白' },
]

/** 为什么这台电脑用不了；能用就是 undefined */
export function mingUnsupported(platform = process.platform, arch = process.arch, darwin = release()) {
  if (platform !== 'darwin' || arch !== 'arm64') return '本机 Ming 只支持 Apple 芯片的 Mac'
  if (Number.parseInt(darwin, 10) < 23) return '本机 Ming 要 macOS 14 或更新'
  return undefined
}

const pythonOf = (root) => join(root, 'env', 'bin', 'python3')

export function mingRoots(env = process.env) {
  return [
    env.DSH_VOICE_MING_HOME,
    join(homedir(), '.dsh-her', 'ming'),
    join(homedir(), '.dsh-her-dev', 'ming'),
    join(dshHome(env), 'dsh-tingdong', 'ming'),
    join(homedir(), '.dsh', 'dsh-tingdong', 'ming'),
  ].filter(Boolean)
}

/** 找已经装好的：Python 环境在、模型校验过 */
export function findMing(env = process.env, exists = existsSync) {
  for (const root of mingRoots(env)) {
    if (exists(pythonOf(root)) && exists(join(root, 'model', '.verified'))) return { root, python: pythonOf(root), model: join(root, 'model') }
  }
  return null
}

export function mingStatus(env = process.env) {
  const why = mingUnsupported()
  if (why) return { ready: false, reason: why }
  const found = findMing(env)
  if (found) return { ready: true, where: found.root }
  return { ready: false, reason: '这台电脑还没装本机 Ming', fix: '在 dsh-her 或「听懂」插件里装一次本机 Ming（约 2 GB），装好后这里直接能用，不用再下载' }
}

/** 常驻进程：第一次合成时启动、加载模型；闲置一段时间自动退出，释放内存 */
export function createMingWorker({ spawnImpl = spawn, idleMs = IDLE_MS } = {}) {
  let proc = null
  let loaded = null
  let timer = null
  let nextId = 1
  const waiting = new Map()
  let tail = ''

  const stop = () => {
    clearTimeout(timer)
    if (proc) {
      try {
        proc.kill()
      } catch {
        // 已经退出
      }
    }
    proc = null
    loaded = null
  }

  const start = (found) => {
    proc = spawnImpl(found.python, ['-I', MING_WORKER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false', PYTHONUNBUFFERED: '1' },
    })
    const mine = proc
    mine.stdin.on('error', () => {})
    mine.stderr.on('data', (d) => { tail = (tail + d).slice(-1500) })
    createInterface({ input: mine.stdout }).on('line', (line) => {
      let reply
      try {
        reply = JSON.parse(line)
      } catch {
        return
      }
      const w = waiting.get(reply.id)
      if (!w) return
      waiting.delete(reply.id)
      if (reply.ok) w.resolve(reply)
      else w.reject(new Error(`本机 Ming 合成失败：${reply.error}`))
    })
    const fail = (why) => {
      const error = new Error(`本机 Ming 退出了（${why}）：${tail.trim().split('\n').slice(-2).join(' ')}`)
      for (const w of waiting.values()) w.reject(error)
      waiting.clear()
      if (proc === mine) {
        proc = null
        loaded = null
      }
    }
    mine.on('error', (e) => fail(e.message))
    mine.on('exit', (code) => fail(`退出码 ${code}`))
    loaded = send({ op: 'load', model: found.model })
    loaded.catch(() => {})
  }

  function send(message) {
    const id = nextId
    nextId += 1
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject })
      proc.stdin.write(`${JSON.stringify({ ...message, id })}\n`)
    })
  }

  /** 一次只合成一句，排队 */
  let chain = Promise.resolve()
  const speak = (found, text, voice) => {
    const run = chain.catch(() => {}).then(async () => {
      clearTimeout(timer)
      if (!proc) start(found)
      await loaded
      const reply = await send({ op: 'speak', text: spokenNumbers(text), voice, steps: 10 })
      return { pcm: Buffer.from(reply.pcm16, 'base64'), sampleRate: reply.sampleRate }
    }).finally(() => {
      clearTimeout(timer)
      timer = setTimeout(stop, idleMs)
      timer.unref?.()
    })
    chain = run
    return run
  }

  return { speak, stop, running: () => Boolean(proc) }
}

let shared = null
const worker = () => {
  shared ??= createMingWorker()
  return shared
}
export const stopMing = () => shared?.stop()

/** 合成一段，返回 16 位单声道 PCM 和采样率 */
export async function mingSpeak(text, voice, { env = process.env, workerImpl } = {}) {
  const why = mingUnsupported()
  if (why && !workerImpl) throw Object.assign(new Error(why), { kind: 'unsupported' })
  const found = findMing(env)
  if (!found && !workerImpl) throw Object.assign(new Error('这台电脑还没装本机 Ming'), { kind: 'missing' })
  if (!MING_VOICES.some((v) => v.id === voice)) throw Object.assign(new Error(`没有这个 Ming 声音：${voice}`), { kind: 'param' })
  return (workerImpl ?? worker()).speak(found, text, voice)
}
