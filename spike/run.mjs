#!/usr/bin/env node
// spike/run.mjs — M0 实测，结果写进 spike/out/
//
//   node spike/run.mjs check      各接口连通性（每个接口合成一两个字）
//   node spike/run.mjs phonemes   Q1 音素和读音：能不能靠返回内容查读音、时长对不对
//   node spike/run.mjs compare    Q2 整段合成和逐句合成的差异
//   node spike/run.mjs relisten   Q3 转写回听：能不能发现漏读，有没有词级时间
//   node spike/run.mjs all        依次运行以上全部

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createTranscribeTask, diffText, hyperSynth, loadCredentials, parseRhy, parseTranscript,
  silenceEdgesMs, splitSentences, uploadAudio, v2Synth, waitTranscribe, wavFromPcm,
} from './xf.mjs'

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out')
mkdirSync(OUT, { recursive: true })
const save = (name, data) => {
  const file = join(OUT, name)
  writeFileSync(file, typeof data === 'string' || Buffer.isBuffer(data) ? data : `${JSON.stringify(data, null, 2)}\n`)
  return file
}
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : fallback
}
const HYPER_VCN = arg('vcn', 'x5_lingxiaoxuan_flow')
const V2_VCN = arg('v2-vcn', 'xiaoyan')

// 读音检查：char 是第几次出现的那个字（nth 从 0 起），expected 是正确读音
const PRONUNCIATION_CASES = [
  { text: '我在重庆的银行工作，每天行走在长江边。', checks: [['重', 0, 'chong2'], ['行', 0, 'hang2'], ['行', 1, 'xing2'], ['长', 0, 'chang2']] },
  { text: '他还没还钱，这首音乐让人快乐。', checks: [['还', 0, 'hai2'], ['还', 1, 'huan2'], ['乐', 0, 'yue4'], ['乐', 1, 'le4']] },
  { text: '这个重要的包裹很重。', checks: [['重', 0, 'zhong4'], ['重', 1, 'zhong4']] },
  { text: '长大后他成了校长，头发却越来越长。', checks: [['长', 0, 'zhang3'], ['长', 1, 'zhang3'], ['长', 2, 'chang2']] },
  { text: '朝阳区的朝阳很美，他朝着单位走去。', checks: [['朝', 0, 'chao2'], ['朝', 1, 'zhao1'], ['朝', 2, 'chao2']] },
  { text: '2024年第3季度营收增长了12.5%，电话是13800138000。', checks: [], note: '看数字怎么读，人工核对' },
  { text: 'CEO说AI的API调用量翻了一倍。', checks: [], note: '看英文缩写怎么表示，人工核对' },
]

const PARAGRAPH = '欢迎收听今天的节目。人工智能正在改变我们的工作方式，也在改变我们讲故事的方式。过去，做一条配音要反复录制；现在，改一句文案，只需要重新生成这一句。这听起来很简单，真正难的是让每句话都自然衔接。接下来，我们用三个例子说明这件事。'

async function check(creds) {
  const results = []
  for (const [name, run] of [
    [`超拟人 ${HYPER_VCN}`, () => hyperSynth('你好', { creds, vcn: HYPER_VCN })],
    [`v2/tts ${V2_VCN}`, () => v2Synth('你好', { creds, vcn: V2_VCN })],
  ]) {
    try {
      const r = await run()
      results.push({ name, ok: true, durationMs: Math.round(r.durationMs), firstAudioMs: r.firstAudioMs, hasRhy: Boolean(r.rhyText) })
    } catch (error) {
      results.push({ name, ok: false, error: error.message })
    }
  }
  console.table(results)
  save('check.json', results)
  return results
}

function pickUnit(parsed, char, nth) {
  return parsed.units.filter((u) => u.text === char)[nth]
}

async function phonemes(creds) {
  const report = []
  for (const [index, item] of PRONUNCIATION_CASES.entries()) {
    const r = await hyperSynth(item.text, { creds, vcn: HYPER_VCN })
    save(`q1-${index}.wav`, wavFromPcm(r.pcm, r.sampleRate))
    if (!r.rhyText) {
      report.push({ text: item.text, rhy: false, pybufFrameKeys: r.pybufFrameKeys })
      continue
    }
    save(`q1-${index}.rhy.txt`, r.rhyText)
    const parsed = parseRhy(r.rhyText)
    const checks = item.checks.map(([char, nth, expected]) => {
      const unit = pickUnit(parsed, char, nth)
      return { char, nth, expected, got: unit?.pinyin ?? null, match: unit?.pinyin === expected }
    })
    report.push({
      text: item.text,
      note: item.note,
      audioMs: Math.round(r.durationMs),
      rhyMs: parsed.totalMs,
      driftMs: Math.round(r.durationMs - parsed.totalMs),
      unitCount: parsed.units.length,
      unparsed: parsed.unparsed,
      checks,
      sample: parsed.units.slice(0, 6).map((u) => `${u.text}[${u.pinyin}] ${u.startMs}-${u.endMs}`),
    })
  }

  // 语速改变后，音素时长是否还和音频对得上
  const fast = await hyperSynth(PRONUNCIATION_CASES[0].text, { creds, vcn: HYPER_VCN, speed: 70 })
  const fastRhy = fast.rhyText ? parseRhy(fast.rhyText) : null
  const speedCheck = { speed: 70, audioMs: Math.round(fast.durationMs), rhyMs: fastRhy?.totalMs ?? null, driftMs: fastRhy ? Math.round(fast.durationMs - fastRhy.totalMs) : null }

  save('q1-report.json', { vcn: HYPER_VCN, report, speedCheck })
  for (const row of report) {
    console.log(`\n${row.text}`)
    console.log(`  音频 ${row.audioMs}ms，音素合计 ${row.rhyMs}ms，偏差 ${row.driftMs}ms，未解析 ${row.unparsed?.length ?? '-'} 段`)
    row.checks?.forEach((c) => console.log(`  ${c.match ? '✓' : '✗'} ${c.char}#${c.nth} 期望 ${c.expected}，实际 ${c.got}`))
    if (row.note) console.log(`  人工核对：${row.sample?.join(' | ')}`)
  }
  console.log('\n语速 70：', speedCheck)
}

async function synthAll(sentences, synth, sampleRate) {
  const started = Date.now()
  const parts = []
  for (const sentence of sentences) {
    const r = await synth(sentence)
    parts.push({ sentence, ...r, ...silenceEdgesMs(r.pcm, sampleRate) })
  }
  const pcm = Buffer.concat(parts.map((p) => p.pcm))
  return { pcm, parts, wallMs: Date.now() - started }
}

async function compare(creds) {
  const sentences = splitSentences(PARAGRAPH)
  const report = { sentences: sentences.length, chars: PARAGRAPH.length }

  const summarize = (result) => ({
    audioMs: Math.round(result.parts.reduce((n, p) => n + p.durationMs, 0)),
    requests: result.parts.length,
    wallMs: result.wallMs,
    perSentence: result.parts.map((p) => ({ text: p.sentence.slice(0, 12), ms: Math.round(p.durationMs), headMs: Math.round(p.headMs), tailMs: Math.round(p.tailMs), firstAudioMs: p.firstAudioMs })),
  })

  // 超拟人没开通时只记下原因，不影响后面 v2 的结果
  try {
    const whole = await hyperSynth(PARAGRAPH, { creds, vcn: HYPER_VCN })
    save('q2-hyper-whole.wav', wavFromPcm(whole.pcm, whole.sampleRate))
    if (whole.rhyText) save('q2-hyper-whole.rhy.txt', whole.rhyText)
    const rhy = whole.rhyText ? parseRhy(whole.rhyText) : null
    report.hyperWhole = {
      audioMs: Math.round(whole.durationMs), rhyMs: rhy?.totalMs ?? null,
      driftMs: rhy ? Math.round(whole.durationMs - rhy.totalMs) : null,
      pauses: rhy?.pauses.length ?? null, requests: 1, wallMs: whole.totalMs,
    }
    const hyperEach = await synthAll(sentences, (s) => hyperSynth(s, { creds, vcn: HYPER_VCN }), whole.sampleRate)
    save('q2-hyper-sentences.wav', wavFromPcm(hyperEach.pcm, whole.sampleRate))
    report.hyperSentences = summarize(hyperEach)
  } catch (error) {
    report.hyperWhole = { error: error.message }
  }

  try {
    const v2Each = await synthAll(sentences, (s) => v2Synth(s, { creds, vcn: V2_VCN }), 16000)
    save('q2-v2-sentences.wav', wavFromPcm(v2Each.pcm, 16000))
    report.v2Sentences = summarize(v2Each)
  } catch (error) {
    report.v2Sentences = { error: error.message }
  }

  save('q2-report.json', report)
  console.log(JSON.stringify(report, null, 2))
  const files = [
    ...(report.hyperWhole?.error ? [] : ['q2-hyper-whole.wav', 'q2-hyper-sentences.wav']),
    ...(report.v2Sentences?.error ? [] : ['q2-v2-sentences.wav']),
  ]
  console.log(`\n请对比试听：\n${files.map((f) => `  ${join(OUT, f)}`).join('\n')}`)
}

async function relisten(creds) {
  const wav = join(OUT, 'q3.wav')
  const mp3 = join(OUT, 'q3.mp3')
  const r = arg('engine', 'hyper') === 'v2'
    ? await v2Synth(PARAGRAPH, { creds, vcn: V2_VCN })
    : await hyperSynth(PARAGRAPH, { creds, vcn: HYPER_VCN, rhy: 0 })
  writeFileSync(wav, wavFromPcm(r.pcm, r.sampleRate))
  const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav, '-ar', '16000', '-ac', '1', mp3], { encoding: 'utf8' })
  if (ff.status !== 0) throw new Error(`ffmpeg 转 mp3 失败：${ff.stderr}`)

  const started = Date.now()
  const url = await uploadAudio(readFileSync(mp3), 'q3.mp3', { creds })
  const taskId = await createTranscribeTask(url, { creds })
  const result = await waitTranscribe(taskId, { creds })
  const transcript = parseTranscript(result)
  save('q3-raw.json', result)

  const lastSentence = splitSentences(PARAGRAPH).at(-1)
  const report = {
    wallMs: Date.now() - started,
    audioMs: Math.round(r.durationMs),
    wordFields: transcript.wordFields,
    hasWordTime: transcript.words.some((w) => w.wb !== undefined && w.we !== undefined),
    sampleWords: transcript.words.slice(0, 8),
    segments: transcript.segments,
    heard: transcript.text,
    // 原稿就是合成用的文本，相似度应接近 1
    sameScript: diffText(PARAGRAPH, transcript.text),
    // 人为在原稿末尾加一句没读的话，看比较能否发现
    injectedMissing: diffText(`${PARAGRAPH}最后这句其实没有被读出来。`, transcript.text),
    // 拿掉原稿最后一句，相当于音频多读了内容
    injectedExtra: diffText(PARAGRAPH.replace(lastSentence, ''), transcript.text),
  }
  save('q3-report.json', report)
  console.log(JSON.stringify({ ...report, sampleWords: report.sampleWords }, null, 2))
}

const COMMANDS = { check, phonemes, compare, relisten }

async function main() {
  const name = process.argv[2]
  if (name !== 'all' && !COMMANDS[name]) {
    console.error('用法：node spike/run.mjs check|phonemes|compare|relisten|all [--vcn x5_...] [--v2-vcn xiaoyan]')
    process.exit(2)
  }
  const creds = loadCredentials()
  for (const step of name === 'all' ? Object.keys(COMMANDS) : [name]) {
    console.log(`\n===== ${step} =====`)
    try {
      await COMMANDS[step](creds)
    } catch (error) {
      console.error(`${step} 失败：${error.message}`)
      process.exitCode = 1
    }
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
