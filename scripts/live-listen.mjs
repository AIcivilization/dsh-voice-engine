#!/usr/bin/env node
// scripts/live-listen.mjs — 用真实接口检查转写。不合成，不扣字符量；只扣约 46 秒转写时长
//
//   node scripts/live-listen.mjs
//
// 用 M0 留下的 23 秒音频（spike/out/q3.mp3）转写两次：普通一次、说话人分离一次。
// 要确认的是文档写了但没实测过的部分：format 参数、wav 上传、说话人分离。

import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadState } from '../lib/config.js'
import { transcribe } from '../lib/listen.js'

const source = new URL('../spike/out/q3.mp3', import.meta.url).pathname
const checks = []
const check = (name, ok, detail = '') => {
  checks.push(Boolean(ok))
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `\n    ${String(detail).replace(/\n/g, '\n    ').slice(0, 400)}` : ''}`)
}

const home = await mkdtemp(join(tmpdir(), 'xfyun-listen-'))
const env = { ...process.env, DSH_HOME: home }
await mkdir(join(home, 'dsh-voice-engine'), { recursive: true })
await copyFile(join(homedir(), '.dsh/dsh-voice-engine/credentials.json'), join(home, 'dsh-voice-engine/credentials.json'))
await loadState(env)

try {
  const started = Date.now()
  const plain = await transcribe({ file: source, cwd: home }, { env })
  check('普通转写（16k mp3）', plain.status === 'done' && plain.chars > 20, `${Date.now() - started}ms，${plain.chars} 字\n${plain.text}`)
  const srt = await readFile(plain.files.srt, 'utf8')
  console.log(srt.split('\n').slice(0, 12).join('\n'))
  check('字幕有内容', (await stat(plain.files.srt)).size > 20)
  const json = JSON.parse(await readFile(plain.files.json, 'utf8'))
  check('时长是真实时长，不是文件字节数', Math.abs(json.durationMs - 22960) < 1500, `${json.durationMs}ms，实际约 22960ms`)
  check('词时间在音频范围内', json.segments.every((s) => s.words.every((w) => w.endMs <= json.durationMs + 1000)))

  const again = await transcribe({ file: source, cwd: home }, { env })
  check('第二次走记录，不再提交', again.cached === true)

  const split = await transcribe({ file: source, cwd: home, speakers: true }, { env })
  check('说话人分离（wav 上传）', split.status === 'done' && split.chars > 20, `说话人：${split.speakers?.join('、')}`)
} catch (error) {
  check('转写', false, `${error.kind ?? ''} ${error.code ?? ''} ${error.message}\n${error.hint ?? ''}`)
} finally {
  await rm(home, { recursive: true, force: true })
}

const failed = checks.filter((ok) => !ok).length
console.log(`\n${checks.length - failed}/${checks.length} 通过`)
process.exit(failed ? 1 : 0)
