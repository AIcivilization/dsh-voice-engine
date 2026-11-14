#!/usr/bin/env node
// spike/analyze.mjs — 用转写和音频能量，独立检验音素时间准不准；并测回听能发现什么
//
//   node spike/analyze.mjs         结果写进 spike/out/q4-report.json

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTranscribeTask, diffText, loadCredentials, parseRhy, parseTranscript, uploadAudio, waitTranscribe } from './xf.mjs'

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out')
const creds = loadCredentials()
const read = (name) => readFileSync(join(OUT, name))
const isSpeechChar = (c) => /[\p{L}\p{N}]/u.test(c)
const round = (n) => Math.round(n)

async function transcribe(wavName) {
  const mp3 = join(OUT, wavName.replace(/\.wav$/, '.mp3'))
  const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(OUT, wavName), '-ar', '16000', '-ac', '1', mp3], { encoding: 'utf8' })
  if (ff.status !== 0) throw new Error(`ffmpeg 失败：${ff.stderr}`)
  const url = await uploadAudio(readFileSync(mp3), wavName.replace(/\.wav$/, '.mp3'), { creds })
  const taskId = await createTranscribeTask(url, { creds })
  return parseTranscript(await waitTranscribe(taskId, { creds }))
}

/** 音频 16bit 单声道：统计一段时间内的平均振幅 */
function meanAmp(pcm, sampleRate, startMs, endMs) {
  const from = Math.floor((startMs / 1000) * sampleRate)
  const to = Math.min(Math.floor((endMs / 1000) * sampleRate), Math.floor(pcm.length / 2))
  if (to <= from) return 0
  let sum = 0
  for (let i = from; i < to; i += 1) sum += Math.abs(pcm.readInt16LE(i * 2))
  return sum / (to - from)
}

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

async function timingCheck() {
  const parsed = parseRhy(read('q2-hyper-whole.rhy.txt').toString())
  const wav = read('q2-hyper-whole.wav')
  const pcm = wav.subarray(44)
  const sampleRate = wav.readUInt32LE(24)

  // 1. 能量：标成停顿的地方应该安静，标成发音的地方应该有声音
  const pauseAmp = parsed.pauses.map((p) => meanAmp(pcm, sampleRate, p.startMs, p.endMs))
  const speechAmp = parsed.units.map((u) => meanAmp(pcm, sampleRate, u.startMs, u.endMs))
  const energy = {
    pauses: parsed.pauses.length,
    pauseKinds: parsed.pauses.reduce((m, p) => ({ ...m, [p.kind]: (m[p.kind] ?? 0) + 1 }), {}),
    pauseAmpMedian: round(percentile(pauseAmp, 0.5)),
    pauseAmpMax: round(Math.max(...pauseAmp)),
    speechAmpMedian: round(percentile(speechAmp, 0.5)),
    speechAmpP10: round(percentile(speechAmp, 0.1)),
  }

  // 2. 和转写的词级时间比较：转写是另一套系统，可以当独立参照
  const t = await transcribe('q2-hyper-whole.wav')
  const chars = parsed.units.flatMap((u) => [...u.text].map((c) => ({ c, startMs: u.startMs })))
  let cursor = 0
  const diffs = []
  const unit = []
  for (const word of t.words) {
    if (word.wb === undefined || !word.w || !isSpeechChar([...word.w][0])) continue
    const first = [...word.w][0]
    let found = -1
    for (let i = cursor; i < Math.min(cursor + 6, chars.length); i += 1) {
      if (chars[i].c === first) { found = i; break }
    }
    if (found < 0) continue
    const asrMs = word.offset + word.wb * 10
    diffs.push(asrMs - chars[found].startMs)
    unit.push({ w: word.w, asrMs, rhyMs: chars[found].startMs })
    cursor = found + [...word.w].filter(isSpeechChar).length
  }
  const abs = diffs.map(Math.abs)
  return {
    audioMs: round((pcm.length / (sampleRate * 2)) * 1000),
    rhyMs: parsed.totalMs,
    energy,
    againstAsr: {
      words: diffs.length,
      totalWords: t.words.filter((w) => w.w && isSpeechChar([...w.w][0])).length,
      meanSignedMs: round(diffs.reduce((a, b) => a + b, 0) / (diffs.length || 1)),
      absMedianMs: round(percentile(abs, 0.5)),
      absP90Ms: round(percentile(abs, 0.9)),
      absMaxMs: round(Math.max(...abs)),
      sample: unit.slice(0, 12),
    },
  }
}

async function relistenLimits() {
  const cases = [
    { name: '多音字（合成时把朝阳读错了）', wav: 'q1-4.wav', text: '朝阳区的朝阳很美，他朝着单位走去。' },
    { name: '数字和符号', wav: 'q1-5.wav', text: '2024年第3季度营收增长了12.5%，电话是13800138000。' },
    { name: '英文缩写', wav: 'q1-6.wav', text: 'CEO说AI的API调用量翻了一倍。' },
  ]
  const out = []
  for (const item of cases) {
    const t = await transcribe(item.wav)
    const d = diffText(item.text, t.text)
    out.push({ name: item.name, heard: t.text, similarity: Number(d.similarity.toFixed(3)), missing: d.missing, extra: d.extra })
  }
  return out
}

const report = { timing: await timingCheck(), relistenLimits: await relistenLimits() }
writeFileSync(join(OUT, 'q4-report.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
