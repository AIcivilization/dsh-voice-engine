// test/project.test.js — 配音工程：切句、对齐、字幕、拼接、增量

import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyGlossary, buildProject, compose, createProject, diffProject, editProject, listProjects, resamplePcm, showProject, splitSentences } from '../lib/project.js'
import { SpeakError } from '../lib/speak.js'
import { alignTokens, cuesFromTokens, estimateTokens, polishCues, toAss, toSrt, toVtt, tokenize } from '../lib/subtitle.js'
import { parseRhy } from '../lib/xf/rhy.js'
import { fakeSynth, makeEnv } from './helpers.js'

const HYPER = 'x5_lingxiaoxuan_flow'
const unit = (text, startMs, endMs) => ({ text, pinyin: null, startMs, endMs })

test('切句：句末标点和换行切开，小数和版本号不切，只有标点的不算一句', () => {
  assert.deepEqual(splitSentences('你好。今天3.5度！真的吗？\n第二段\n……'), ['你好。', '今天3.5度！', '真的吗？', '第二段'])
  assert.deepEqual(splitSentences('他说：“走吧。”然后走了。'), ['他说：“走吧。”', '然后走了。'])
  assert.deepEqual(splitSentences('Hello world. v1.2 is out.'), ['Hello world.', 'v1.2 is out.'])
  assert.deepEqual(splitSentences(''), [])
})

test('词表：应用到所有出现的地方，长词优先，已有标注不叠加', () => {
  const g = { 调用: '调[=diao4]用', 调用量: '调[=diao4]用量' }
  assert.equal(applyGlossary('调用和调用量', g), '调[=diao4]用和调[=diao4]用量')
  assert.equal(applyGlossary('调[=diao4]用', g), '调[=diao4]用')
  assert.equal(applyGlossary('你好', {}), '你好')
})

test('对齐：数字读成多个单元时整体分配，后面的字不错位', () => {
  const tokens = tokenize('今年2024年增长3.5%。')
  const units = [...'今年'].map((c, i) => unit(c, i * 100, (i + 1) * 100))
    .concat([...'二零二四'].map((c, i) => unit(c, 200 + i * 100, 300 + i * 100)))
    .concat([unit('年', 600, 700), unit('增', 700, 800), unit('长', 800, 900)])
    .concat([...'三点五'].map((c, i) => unit(c, 900 + i * 100, 1000 + i * 100)))
  const report = alignTokens(tokens, units)
  const number = tokens.find((t) => t.text === '2024')
  assert.deepEqual([number.startMs, number.endMs], [200, 600])
  assert.equal(tokens.find((t) => t.text === '增').startMs, 700)
  const tail = tokens.find((t) => t.text === '3.5%')
  assert.deepEqual([tail.startMs, tail.endMs], [900, 1200])
  assert.deepEqual(report, { missed: [], extra: [], lost: false })
})

test('对齐：英文缩写是一个单元；漏读和多读都会报告', () => {
  const tokens = tokenize('CEO说AI')
  alignTokens(tokens, [unit('CEO', 0, 300), unit('说', 300, 400), unit('AI', 400, 600)])
  assert.deepEqual(tokens.map((t) => t.startMs), [0, 300, 400])

  const skipped = tokenize('我们今天开会')
  const missed = alignTokens(skipped, [unit('我', 0, 100), unit('们', 100, 200), unit('开', 200, 300), unit('会', 300, 400)])
  assert.deepEqual(missed.missed, ['今', '天'])

  const extra = alignTokens(tokenize('今天开会'), [unit('今', 0, 100), unit('天', 100, 200), unit('呃', 200, 300), unit('开', 300, 400), unit('会', 400, 500)])
  assert.deepEqual(extra.extra, ['呃'])
})

test('对齐：读音里的字不会被错认成后面原文里的同一个字', () => {
  // 真实案例：10:30 读成「十点半」，后面紧跟「地点」
  const tokens = tokenize('上午10:30，地点在北京')
  const text = '上午十点半地点在北京'
  const units = [...text].map((c, i) => unit(c, i * 100, (i + 1) * 100))
  assert.deepEqual(alignTokens(tokens, units), { missed: [], extra: [], lost: false })
  const number = tokens.find((t) => t.text === '10:30')
  assert.deepEqual([number.startMs, number.endMs], [200, 500])
  assert.equal(tokens.find((t) => t.text === '地').startMs, 500)
})

test('字幕：显示原文、去掉句尾标点，超长按等宽切，标注不进字幕', () => {
  const tokens = tokenize('调[=diao4]用量翻了一倍，真的吗？')
  estimateTokens(tokens, 0, 1000)
  const cues = cuesFromTokens(tokens)
  assert.deepEqual(cues.map((c) => c.text), ['调用量翻了一倍', '真的吗？'])
  assert.equal(cues[0].startMs, 0)
  assert.equal(cues[1].endMs, 1000)

  const long = tokenize('一二三四五六七八九十一二三四五六七八九十一二三四五')
  estimateTokens(long, 0, 2500)
  const pieces = cuesFromTokens(long, { maxWidth: 10 })
  assert.deepEqual(pieces.map((c) => [...c.text].length), [9, 9, 7])
  assert.equal(pieces.at(-1).endMs, 2500)
})

test('字幕收尾：小缝填上，太短延长，不和下一条重叠', () => {
  const cues = polishCues([
    { text: 'a', startMs: 0, endMs: 900, words: [] },
    { text: 'b', startMs: 1000, endMs: 1100, words: [] },
    { text: 'c', startMs: 1300, endMs: 2000, words: [] },
    { text: 'd', startMs: 5000, endMs: 5100, words: [] },
  ])
  assert.equal(cues[0].endMs, 1000)
  assert.equal(cues[1].endMs, 1300)
  assert.equal(cues[2].endMs, 2000)
  assert.equal(cues[3].endMs, 5400)
})

test('字幕格式：SRT 用逗号、VTT 用点并转义、ASS 能卡点且转义花括号', () => {
  const cues = [{ text: 'A<B', startMs: 1234, endMs: 3661000, words: [{ text: 'A', startMs: 1234, endMs: 2000 }, { text: 'B', startMs: 2500, endMs: 3000 }] }]
  assert.match(toSrt(cues), /^1\n00:00:01,234 --> 01:01:01,000\nA<B\n$/)
  assert.match(toVtt(cues), /^WEBVTT\n\n00:00:01\.234 --> 01:01:01\.000\nA&lt;B\n$/)
  const karaoke = toAss(cues, { karaoke: true })
  assert.match(karaoke, /Dialogue: 0,0:00:01\.23,1:01:01\.00,Default,,0,0,0,,\{\\kf127\}A<\{\\kf365850\}B/)
  assert.match(toAss(cues, { portrait: true }), /PlayResX: 1080\nPlayResY: 1920/)
  assert.match(toAss([{ text: '{\\pos}', startMs: 0, endMs: 1, words: [] }]), /,,｛＼pos｝/)
})

test('拼接：默认保留自带静音；设了间隔就裁静音并插入固定停顿；位置算准', () => {
  const rate = 1000
  const seg = (ms, speech) => ({ pcm: Buffer.alloc(ms * 2), sampleRate: rate, speech, gapAfterMs: null })
  const natural = compose([seg(1000, { startMs: 100, endMs: 800 }), seg(500, { startMs: 100, endMs: 400 })])
  assert.equal(natural.totalMs, 1500)
  assert.deepEqual(natural.placed.map((p) => [p.startMs, p.endMs]), [[0, 1000], [1000, 1500]])
  assert.equal(natural.placed[1].offsetMs, 1000)

  const tight = compose([seg(1000, { startMs: 100, endMs: 800 }), seg(500, { startMs: 100, endMs: 400 })], { gapMs: 200 })
  // 第一句 70–830，停顿 200，第二句 70–430
  assert.equal(tight.totalMs, 760 + 200 + 360)
  assert.equal(tight.placed[0].offsetMs, -70)
  assert.equal(tight.placed[1].startMs, 960)
  assert.equal(tight.placed[1].offsetMs, 960 - 70)
})

test('拼接：不同采样率统一成高的，时长不变；v2 没有音素不裁', () => {
  assert.equal(resamplePcm(Buffer.alloc(16000 * 2), 16000, 24000).length, 24000 * 2)
  const out = compose([
    { pcm: Buffer.alloc(24000 * 2), sampleRate: 24000, speech: null, gapAfterMs: null },
    { pcm: Buffer.alloc(16000 * 2), sampleRate: 16000, speech: null, gapAfterMs: null },
  ], { gapMs: 100 })
  assert.equal(out.sampleRate, 24000)
  assert.equal(out.totalMs, 2100)
})

async function project(extra = {}, synthOptions = {}) {
  const made = await makeEnv()
  const synth = fakeSynth(synthOptions)
  const deps = { env: made.env, synth }
  await createProject({ name: '演示', sentences: ['第一句话。', '第二句话。', '第三句话。'], vcn: HYPER, cwd: made.cwd, ...extra }, deps)
  return { ...made, synth, deps, base: { name: '演示', cwd: made.cwd, audioFormat: 'wav' } }
}

test('工程：导出音频和字幕，时间轴连续，第二次什么都不重配', async () => {
  const { synth, deps, base, cwd } = await project()
  const first = await buildProject(base, deps)
  assert.equal(first.ok, true)
  assert.equal(first.sentences, 3)
  assert.equal(first.resynthesized.length, 3)
  assert.equal(first.chars, 15)
  assert.equal(synth.calls.length, 3)
  assert.equal(first.timing.phoneme, 3)
  assert.equal(first.checks.coverage.ok, true)
  // 每句 4 字 400ms + 首尾静音 1s
  assert.equal(first.totalMs, 4200)
  assert.ok(first.files.audio.startsWith(join(cwd, 'voice-output', '演示')))
  const srt = await readFile(first.files.srt, 'utf8')
  assert.match(srt, /00:00:00,500 --> 00:00:00,900\n第一句话/)
  assert.match(srt, /00:00:01,900 --> .*\n第二句话/)
  assert.match(srt, /00:00:03,300 --> .*\n第三句话/)
  const wav = await readFile(first.files.audio)
  assert.equal(wav.length, 44 + 4200 * 48)

  const again = await buildProject(base, deps)
  assert.equal(again.resynthesized.length, 0)
  assert.equal(again.reused, 3)
  assert.equal(again.chars, 0)
  assert.equal(synth.calls.length, 3)
})

test('工程：改一句只重配一句，时间轴整体重排', async () => {
  const { synth, deps, base } = await project()
  await buildProject(base, deps)
  const edited = await editProject({ ...base, edits: [{ id: 's2', text: '第二句话改长了很多。' }] }, deps)
  assert.deepEqual(edited.changed.map((c) => [c.id, c.change, c.before]), [['s2', 'text', '第二句话。']])
  assert.equal(edited.unchanged, 2)
  assert.equal(edited.charsToSynth, 10)
  const second = await buildProject(base, deps)
  assert.deepEqual(second.resynthesized, ['s2'])
  assert.equal(second.reused, 2)
  assert.equal(second.chars, 10)
  assert.equal(synth.calls.length, 4)
  assert.equal(second.totalMs, 4700)
  assert.match(await readFile(second.files.srt, 'utf8'), /00:00:03,800 --> .*\n第三句话/)
})

test('工程：删除、插入、改回原文走缓存不扣量', async () => {
  const { synth, deps, base } = await project()
  await buildProject(base, deps)
  await editProject({ ...base, edits: [{ id: 's1', op: 'delete' }, { id: 's3', op: 'insert', text: '新加一句。' }] }, deps)
  const shown = await showProject(base, deps)
  assert.deepEqual(shown.sentences.map((s) => s.id), ['s2', 's3', 's4'])
  const removed = await diffProject(base, deps)
  assert.deepEqual(removed.removed.map((r) => r.id), ['s1'])
  await buildProject(base, deps)
  assert.equal(synth.calls.length, 4)

  await editProject({ ...base, edits: [{ id: 's2', text: '临时改一下。' }] }, deps)
  await buildProject(base, deps)
  const back = await editProject({ ...base, edits: [{ id: 's2', text: '第二句话。' }] }, deps)
  assert.equal(back.charsToSynth, 0, '改回去有缓存，不扣量')
  const rebuilt = await buildProject(base, deps)
  assert.deepEqual(rebuilt.resynthesized, ['s2'])
  assert.equal(rebuilt.chars, 0)
  assert.equal(synth.calls.length, 5)
})

test('工程：词表只重配含这个词的句子，读错的能修正，字幕不带标注', async () => {
  const { synth, deps, base } = await project({ sentences: ['调用量翻倍。', '今天天气好。'] }, { readings: { 调: 'tiao2' } })
  const first = await buildProject(base, deps)
  assert.match(first.pronunciation.find((p) => p.id === 's1').readings, /调\[tiao2\]/)
  await editProject({ ...base, glossary: { 调用: '调[=diao4]用' } }, deps)
  const fixed = await buildProject(base, deps)
  assert.deepEqual(fixed.resynthesized, ['s1'])
  assert.match(fixed.pronunciation[0].readings, /调\[diao4\]/)
  assert.equal(synth.calls.at(-1).text, '调[=diao4]用量翻倍。')
  assert.match(await readFile(fixed.files.srt, 'utf8'), /\n调用量翻倍\n/)
  const shown = await showProject(base, deps)
  assert.equal(shown.sentences[0].text, '调用量翻倍。', '词表不改文稿')

  await assert.rejects(editProject({ ...base, glossary: { 调用: '别的词' } }, deps), SpeakError)
  await editProject({ ...base, glossary: { 调用: null } }, deps)
  assert.deepEqual((await showProject(base, deps)).glossary, {})
})

test('工程：单句换音色只重配这句；工程语速对所有句子生效；混用 v2 能导出并标明精度', async () => {
  const { synth, deps, base } = await project()
  await buildProject(base, deps)
  await editProject({ ...base, edits: [{ id: 's2', vcn: 'xiaoyan' }] }, deps)
  const mixed = await buildProject({ ...base, formats: ['srt', 'vtt', 'ass'] }, deps)
  assert.deepEqual(mixed.resynthesized, ['s2'])
  assert.equal(synth.calls.at(-1).engine, 'v2')
  assert.deepEqual(mixed.timing, { phoneme: 2, bytes: 1, estimate: 0 })
  assert.ok(mixed.files.vtt && mixed.files.ass)
  assert.match(await readFile(mixed.files.srt, 'utf8'), /第二句话/)

  await editProject({ ...base, speed: 60 }, deps)
  const faster = await buildProject(base, deps)
  assert.deepEqual(faster.resynthesized, ['s1', 's2', 's3'], '语速对整个工程生效')
})

test('工程：不能单独调一句的语速、音调、音量，否则听起来像换了个人', async () => {
  const { deps, base, synth } = await project()
  await buildProject(base, deps)
  for (const field of [{ speed: 42 }, { pitch: 46 }, { volume: 55 }]) {
    await assert.rejects(editProject({ ...base, edits: [{ id: 's3', ...field }] }, deps), (e) => e.kind === 'param' && /改这句的文字/.test(e.hint))
  }
  const calls = synth.calls.length
  const again = await buildProject(base, deps)
  assert.equal(again.resynthesized.length, 0, '被拒绝的修改不留痕迹')
  assert.equal(synth.calls.length, calls)
})

test('工程：旧工程里单句的语速音调不再生效，导出时恢复一致，有缓存不扣量', async () => {
  const { deps, base, synth, cwd } = await project()
  await buildProject(base, deps)
  const file = join(cwd, 'voice-output', '演示', 'manifest.json')
  const old = JSON.parse(await readFile(file, 'utf8'))
  Object.assign(old.sentences[2], { speed: 42, pitch: 46, volume: 55 })
  await writeFile(file, JSON.stringify(old))
  const calls = synth.calls.length
  const fixed = await buildProject(base, deps)
  assert.equal(fixed.resynthesized.length, 0)
  assert.equal(synth.calls.length, calls)
})

test('工程：时长检查和卡点字幕', async () => {
  const { deps, base } = await project({ targetSeconds: 10 })
  const r = await buildProject(base, deps)
  assert.equal(r.checks.duration.ok, false)
  assert.equal(r.checks.duration.deltaMs, -5800)
  await editProject({ ...base, targetSeconds: 4 }, deps)
  const ok = await buildProject({ ...base, formats: ['ass'], karaoke: true, portrait: true }, deps)
  assert.equal(ok.checks.duration.ok, true)
  const ass = await readFile(ok.files.ass, 'utf8')
  assert.match(ass, /\{\\kf\d+\}第\{\\kf\d+\}一/)
  assert.match(ass, /PlayResY: 1920/)
})

test('工程：一句失败不导出，也不覆盖旧记录，已合成的下次不重复扣量', async () => {
  const made = await makeEnv()
  const denied = { value: true }
  const synth = fakeSynth({ denied: (vcn) => denied.value && vcn === 'x6_lingfeiyi_pro' })
  const deps = { env: made.env, synth }
  const base = { name: 'p', cwd: made.cwd, audioFormat: 'wav' }
  await createProject({ ...base, sentences: ['一句话。', '两句话。'], vcn: HYPER }, deps)
  await editProject({ ...base, edits: [{ id: 's2', vcn: 'x6_lingfeiyi_pro' }] }, deps)
  const failed = await buildProject(base, deps)
  assert.equal(failed.ok, false)
  assert.equal(failed.failed[0].id, 's2')
  assert.equal(failed.kind, 'voice')
  assert.equal((await showProject(base, deps)).lastBuild, null)

  denied.value = false
  const before = synth.calls.length
  const ok = await buildProject(base, deps)
  assert.equal(ok.ok, true)
  assert.equal(synth.calls.length - before, 1, '第一句已有缓存')
  assert.equal(ok.spentChars, 8)
})

test('工程：名字不能跳出目录，重名和空内容报错，并行修改不丢', async () => {
  const made = await makeEnv()
  const deps = { env: made.env, synth: fakeSynth() }
  const created = await createProject({ name: '../../etc', sentences: ['你好。'], cwd: made.cwd }, deps)
  assert.ok(created.dir.startsWith(join(made.cwd, 'voice-output')))
  assert.ok(!created.dir.includes('..'))
  await assert.rejects(createProject({ name: '../../etc', sentences: ['你好。'], cwd: made.cwd }, deps), /已经存在/)
  await assert.rejects(createProject({ name: '空', sentences: [], text: '', cwd: made.cwd }, deps), /没有内容/)
  await assert.rejects(createProject({ name: '///', sentences: ['你好。'], cwd: made.cwd }, deps), /工程名/)
  await assert.rejects(showProject({ name: '不存在', cwd: made.cwd }, deps), /没有这个工程/)
  await assert.rejects(editProject({ name: created.name, edits: [{ id: 's9', text: '啊' }], cwd: made.cwd }, deps), /没有这一句/)

  const base = { name: created.name, cwd: made.cwd }
  await Promise.all([1, 2, 3, 4].map((n) => editProject({ ...base, edits: [{ op: 'insert', text: `第${n}句。` }] }, deps)))
  assert.equal((await showProject(base, deps)).sentences.length, 5)
  assert.equal((await listProjects({ cwd: made.cwd }, deps)).projects.length, 1)
})

test('工程：音素时长和音频对不上时不信音素时间，并如实报告', async () => {
  const made = await makeEnv()
  const real = fakeSynth()
  const synth = { ...real, hyper: async (...a) => ({ ...(await real.hyper(...a)), pcm: Buffer.alloc(24000 * 2 * 5) }) }
  const deps = { env: made.env, synth }
  const base = { name: 'p', cwd: made.cwd, audioFormat: 'wav' }
  await createProject({ ...base, sentences: ['一句话。'], vcn: HYPER }, deps)
  const r = await buildProject(base, deps)
  assert.equal(r.timing.estimate, 1)
  assert.equal(r.checks.coverage.ok, false)
  assert.match(r.checks.coverage.problems[0], /字幕时间不准/)
})

test('真实 rhy 格式能进工程的对齐：英文、停顿、标注', () => {
  const parsed = parseRhy('sil:24;CEO*-s:32;@-iy:44;说[=shuo1]-sh1:8;@-uo1:16;@-sp3:40;调[=diao4]*-d4:24;@-iao4:36;用[=yong4]-y4:8;@-ong4:16;sil:116;')
  const tokens = tokenize('CEO说，调[=diao4]用。')
  const report = alignTokens(tokens, parsed.units)
  assert.deepEqual(report, { missed: [], extra: [], lost: false })
  const cues = cuesFromTokens(tokens)
  assert.deepEqual(cues.map((c) => c.text), ['CEO说', '调用'])
  assert.equal(cues[0].startMs, 120)
  assert.equal(cues[1].startMs, parsed.units[2].startMs)
  assert.ok(cues[1].startMs >= cues[0].endMs + 200, '句中停顿在字幕之间')
})
