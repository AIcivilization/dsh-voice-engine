// lib/engine/edge.js — 微软 Edge「大声朗读」的在线语音，经开源命令行工具 edge-tts
//
// 做法来自 dsh-go（听懂）和 dsh-audiobook：不自己实现微软的私有协议，调用 edge-tts。
// 先找别的产品已经装好的那一份，找不到才装到本插件自己的目录（~/.dsh/dsh-voice-engine/edge-tts）。
// 要联网，文字会发到微软的服务器；不是微软公开的正式接口，可能失效。免费，不扣讯飞额度。

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { dshHome } from '../config.js'

/** id 是 edge-tts 的声音名；名字、方言照 dsh-go 和 dsh-audiobook 的表 */
export const EDGE_VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓', gender: 'female', lang: 'zh', style: '温暖' },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊', gender: 'female', lang: 'zh', style: '活泼' },
  { id: 'zh-CN-YunxiNeural', name: '云希', gender: 'male', lang: 'zh', style: '阳光，适合小说' },
  { id: 'zh-CN-YunyangNeural', name: '云扬', gender: 'male', lang: 'zh', style: '新闻播报' },
  { id: 'zh-CN-YunjianNeural', name: '云健', gender: 'male', lang: 'zh', style: '激情' },
  { id: 'zh-CN-YunxiaNeural', name: '云夏', gender: 'child', lang: 'zh', style: '男童' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', name: '晓北', gender: 'female', lang: 'zh', dialect: '辽宁', style: '辽宁话' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', name: '晓妮', gender: 'female', lang: 'zh', dialect: '陕西', style: '陕西话' },
  { id: 'zh-TW-HsiaoChenNeural', name: '曉臻', gender: 'female', lang: 'zh', dialect: '台湾', style: '台湾腔' },
  { id: 'zh-TW-HsiaoYuNeural', name: '曉雨', gender: 'female', lang: 'zh', dialect: '台湾', style: '台湾腔' },
  { id: 'zh-TW-YunJheNeural', name: '雲哲', gender: 'male', lang: 'zh', dialect: '台湾', style: '台湾腔' },
  { id: 'zh-HK-HiuMaanNeural', name: '曉曼', gender: 'female', lang: 'yue', style: '粤语' },
  { id: 'zh-HK-HiuGaaiNeural', name: '曉佳', gender: 'female', lang: 'yue', style: '粤语' },
  { id: 'zh-HK-WanLungNeural', name: '雲龍', gender: 'male', lang: 'yue', style: '粤语' },
  { id: 'en-US-AndrewNeural', name: 'Andrew', gender: 'male', lang: 'en', style: '美式 · 温和' },
  { id: 'en-US-BrianNeural', name: 'Brian', gender: 'male', lang: 'en', style: '美式 · 随和' },
  { id: 'en-US-ChristopherNeural', name: 'Christopher', gender: 'male', lang: 'en', style: '美式 · 沉稳' },
  { id: 'en-US-GuyNeural', name: 'Guy', gender: 'male', lang: 'en', style: '美式' },
  { id: 'en-US-EricNeural', name: 'Eric', gender: 'male', lang: 'en', style: '美式' },
  { id: 'en-GB-RyanNeural', name: 'Ryan', gender: 'male', lang: 'en', style: '英式' },
  { id: 'en-GB-ThomasNeural', name: 'Thomas', gender: 'male', lang: 'en', style: '英式' },
  { id: 'en-US-AvaNeural', name: 'Ava', gender: 'female', lang: 'en', style: '美式 · 亲切' },
  { id: 'en-US-EmmaNeural', name: 'Emma', gender: 'female', lang: 'en', style: '美式 · 清晰' },
  { id: 'en-US-JennyNeural', name: 'Jenny', gender: 'female', lang: 'en', style: '美式' },
  { id: 'en-US-AriaNeural', name: 'Aria', gender: 'female', lang: 'en', style: '美式 · 播音' },
  { id: 'en-US-MichelleNeural', name: 'Michelle', gender: 'female', lang: 'en', style: '美式' },
  { id: 'en-GB-SoniaNeural', name: 'Sonia', gender: 'female', lang: 'en', style: '英式' },
  { id: 'en-GB-LibbyNeural', name: 'Libby', gender: 'female', lang: 'en', style: '英式' },
]

const win = process.platform === 'win32'
const venvBin = (root, name) => join(root, win ? 'Scripts' : 'bin', win ? `${name}.exe` : name)

export const ownEdgeDir = (env = process.env) => join(dshHome(env), 'dsh-voice-engine', 'edge-tts')

/** 候选位置：自己装的 > 有声书装的 > 听懂装的 > 系统里的 */
export function edgeCandidates(env = process.env) {
  const home = dshHome(env)
  return [
    venvBin(ownEdgeDir(env), 'edge-tts'),
    venvBin(join(home, 'dsh-audiobook', 'edge-tts'), 'edge-tts'),
    venvBin(join(home, 'dsh-tingdong', 'edge-tts'), 'edge-tts'),
    venvBin(join(homedir(), '.dsh', 'dsh-audiobook', 'edge-tts'), 'edge-tts'),
    venvBin(join(homedir(), '.dsh', 'dsh-tingdong', 'edge-tts'), 'edge-tts'),
    '/opt/homebrew/bin/edge-tts',
    '/usr/local/bin/edge-tts',
    '/usr/bin/edge-tts',
  ]
}

export function findEdge(env = process.env, exists = existsSync) {
  const bin = env.EDGE_TTS_PATH || edgeCandidates(env).find((p) => exists(p))
  return bin && exists(bin) ? bin : null
}

export function runCommand(cmd, args, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 << 20 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(String(stderr || error.message).trim().split('\n').slice(-2).join(' ')))
      return resolve(String(stdout))
    })
  })
}

export function edgeStatus(env = process.env) {
  const bin = findEdge(env)
  return bin
    ? { ready: true, where: bin.startsWith(ownEdgeDir(env)) ? 'own' : 'shared' }
    : { ready: false, reason: '还没有 Edge 语音组件（edge-tts）', fix: '在 DSH 对话页右侧栏「声音引擎」的 Edge 一栏点「安装」，约几十秒，要 Python 3' }
}

/** 装到自己的虚拟环境，不动系统 Python。删掉这个目录就是卸载 */
export async function installEdge(env = process.env, run = runCommand) {
  const candidates = win ? ['py', 'python', 'python3'] : ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3', 'python3']
  const py = candidates.find((p) => !p.includes('/') || existsSync(p))
  if (!py) throw new Error('没找到 Python 3。Mac 上运行 xcode-select --install 装好命令行工具后再试')
  const dir = ownEdgeDir(env)
  const venvPy = venvBin(dir, win ? 'python' : 'python3')
  if (!existsSync(venvPy)) {
    await rm(dir, { recursive: true, force: true })
    await run(py, ['-m', 'venv', dir], { timeout: 300000 })
  }
  await run(venvPy, ['-m', 'pip', 'install', '-q', '--upgrade', 'edge-tts'], { timeout: 600000 })
  return edgeStatus(env)
}

/** 读一段，返回 mp3（24 kHz 单声道）。speed 1 = 正常 */
export async function edgeSpeak(text, voice, { speed = 1, env = process.env, run = runCommand, tmp = tmpdir() } = {}) {
  const bin = findEdge(env)
  if (!bin) throw Object.assign(new Error('还没有 Edge 语音组件'), { kind: 'missing' })
  const out = join(tmp, `dsh-voice-edge-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`)
  const pct = Math.round((speed - 1) * 100)
  const args = ['--voice', voice, `--rate=${pct >= 0 ? '+' : ''}${pct}%`, '--text', text, '--write-media', out]
  try {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await run(bin, args, { timeout: 120000 })
        return await readFile(out)
      } catch (error) {
        // 网络偶尔抖一下：重试两次
        if (attempt >= 3) throw Object.assign(new Error(`Edge 语音失败（要联网）：${error.message}`), { kind: 'network' })
        await new Promise((r) => setTimeout(r, 800 * attempt))
      }
    }
  } finally {
    await rm(out, { force: true })
  }
}
