// test/helpers.js — 测试公用：临时 DSH_HOME、假的讯飞合成

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _resetMemory, loadState } from '../lib/config.js'
import { _resetFfmpeg } from '../lib/speak.js'
import { XfError } from '../lib/xf/tts.js'

export const CREDS = { appId: 'abc12345', apiKey: '0123456789abcdef0123456789abcdef', apiSecret: 'NWQ4ZmI1Zk1hYjQ4OTNlYzVjYmJhOTk5' }

/** 新的隔离环境。FFMPEG_PATH 指向不存在的文件也不要紧：测试里默认输出 wav */
export async function makeEnv({ credentials = true } = {}) {
  _resetMemory()
  _resetFfmpeg()
  const home = await mkdtemp(join(tmpdir(), 'xfyun-test-'))
  const env = { DSH_HOME: home, PATH: process.env.PATH }
  if (credentials) {
    await mkdir(join(home, 'dsh-voice-engine'), { recursive: true })
    await writeFile(join(home, 'dsh-voice-engine', 'credentials.json'), JSON.stringify(CREDS))
  }
  await loadState(env)
  return { env, home, cwd: home }
}

/**
 * 假的合成：按字数生成音频和拼音标注，可以指定哪些音色未授权。
 * readings 指定某个字的读音，默认 ping1。
 */
export function fakeSynth({ denied = () => false, readings = {}, calls = [] } = {}) {
  const make = (engine, sampleRate) => async (text, { vcn }) => {
    calls.push({ engine, text, vcn })
    if (denied(vcn, engine)) throw new XfError(11200, 'licc limit', 'sid')
    const plain = text.replace(/\[=[a-z]+[1-5]\]/g, '')
    const chars = [...plain].filter((c) => /[\p{L}\p{N}]/u.test(c))
    const pcm = Buffer.alloc((chars.length * sampleRate * 2) / 10 + sampleRate * 2) // 每字 100ms，首尾共 1 秒静音，和下面的 rhy 一致
    if (engine === 'v2') return { engine, pcm, sampleRate, rhy: null, sid: 's' }
    const marks = new Map([...text.matchAll(/(.)\[=([a-z]+[1-5])\]/g)].map((m) => [m[1], m[2]]))
    const rhy = `sil:100;${chars.map((c) => `${c}[=${marks.get(c) ?? readings[c] ?? 'ping1'}]-p1:10;@-ing1:10;`).join('')}sil:100;`
    return { engine, pcm, sampleRate, rhy, sid: 's' }
  }
  return { hyper: make('hyper', 24000), v2: make('v2', 16000), calls }
}
