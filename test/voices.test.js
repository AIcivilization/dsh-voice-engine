// test/voices.test.js — 音色：可见、可听、可选、可对比，以及花钱前说清楚。全部不联网

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { registerCommands } from '../lib/commands.js'
import { getState, settingsCached } from '../lib/config.js'
import { scanVoices } from '../lib/doctor.js'
import { pendingVoices, presentVoices, requestLibrary, takeLibraryRequest } from '../lib/picker.js'
import { createActions, createHandlers } from '../lib/routes.js'
import { speak } from '../lib/speak.js'
import { buildToolDefinitions } from '../lib/tools.js'
import { defaultVoice, defaultVoiceInfo, searchVoices, setDefaultVoice, voiceFacets } from '../lib/voices.js'
import { fakeSynth, makeEnv } from './helpers.js'

const HYPER = 'x5_lingxiaoxuan_flow'
const NO_SAMPLE = 'x6_lingfeihan_pro'
const WITH_SAMPLE = 'x2_xiaodong'
const audioRequest = (body) => new Request('http://x/api/dsh-voice-engine.audio', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('可见：能按语种、方言、免费样音筛选；筛选项来自目录，带数量', async () => {
  await makeEnv()
  const facets = voiceFacets()
  assert.ok(facets.langs[0].count > 100)
  assert.equal(facets.langs[0].value, 'zh')
  assert.ok(facets.dialects.some((d) => d.value === '山东'))
  const free = searchVoices({ sample: true, limit: 400 })
  assert.ok(free.total >= 100)
  assert.ok(free.voices.every((v) => v.hasSample))
  assert.equal(searchVoices({ dialect: '山东' }).voices[0].code, WITH_SAMPLE)
  assert.ok(searchVoices({ lang: 'yue', limit: 50 }).voices.every((v) => v.lang === 'yue'))
})

test('可见：常用途按钮都能找到音色', async () => {
  await makeEnv()
  for (const chip of ['旁白', '新闻', '广告', '客服', '角色', '童声']) {
    assert.ok(searchVoices({ query: chip }).total > 0, chip)
  }
})

test('可听：有样音的不花钱；没有样音的先标出要扣多少字，听过就标成不扣', async () => {
  const { env } = await makeEnv()
  const synth = fakeSynth()
  const actions = createActions({ env, synth })
  const found = await actions.voices({ query: NO_SAMPLE, trialText: '你好，这是我的声音。' })
  assert.deepEqual(found.voices[0].trial, { chars: 10, cached: false })
  assert.equal(synth.calls.length, 0, '算费用不能发请求')
  const sampled = await actions.voices({ query: WITH_SAMPLE, trialText: '你好' })
  assert.equal(sampled.voices[0].trial, undefined)

  const { audio } = createHandlers({ env, synth })
  const res = await audio(audioRequest({ code: NO_SAMPLE, text: '你好，这是我的声音。' }))
  assert.equal(res.headers.get('x-xfyun-charged'), '10')
  assert.ok(Number(res.headers.get('x-xfyun-duration-ms')) > 0)
  const again = await audio(audioRequest({ code: NO_SAMPLE, text: '你好，这是我的声音。' }))
  assert.equal(again.headers.get('x-xfyun-charged'), '0', '第二次走缓存')
  assert.equal(synth.calls.length, 1)
  const after = await actions.voices({ query: NO_SAMPLE, trialText: '你好，这是我的声音。' })
  assert.equal(after.voices[0].trial.cached, true)
})

test('可听：免费样音不用凭据，也不调合成', async () => {
  const { env } = await makeEnv({ credentials: false })
  const synth = fakeSynth()
  const fetchImpl = async () => new Response(Buffer.from('RIFFdata'), { status: 200 })
  const { audio } = createHandlers({ env, synth, fetchImpl })
  const res = await audio(audioRequest({ code: WITH_SAMPLE }))
  assert.equal(res.headers.get('content-type'), 'audio/wav')
  assert.equal(res.headers.get('x-xfyun-charged'), '0')
  assert.equal(synth.calls.length, 0)
})

test('对比：先算总价，听过的不算；超长文字和超过 5 个都挡住', async () => {
  const { env, cwd } = await makeEnv()
  const synth = fakeSynth()
  const actions = createActions({ env, synth })
  const codes = [HYPER, NO_SAMPLE, WITH_SAMPLE]
  const before = await actions.trialPlan({ codes, text: '今天天气真好' })
  assert.equal(before.charge, 18)
  assert.equal(synth.calls.length, 0)
  await speak({ text: '今天天气真好', vcn: HYPER, format: 'wav', cwd }, { env, synth })
  const after = await actions.trialPlan({ codes, text: '今天天气真好' })
  assert.equal(after.charge, 12)
  assert.deepEqual(after.voices.map((v) => v.cached), [true, false, false])
  assert.equal((await actions.trialPlan({ codes, text: '' })).charge, 0)
  assert.equal((await actions.trialPlan({ codes: ['a', 'b', 'c', 'd', 'e', 'f'], text: '' })).voices.length, 5)
  await assert.rejects(actions.trialPlan({ codes, text: '字'.repeat(201) }), /200/)
})

test('可选：默认音色能设、能恢复，合成时用它；名字也行，目录外的不收', async () => {
  const { env, cwd } = await makeEnv()
  assert.equal(defaultVoiceInfo().chosen, false)
  const set = await setDefaultVoice('聆飞瀚', env)
  assert.equal(set.code, NO_SAMPLE)
  assert.equal(set.chosen, true)
  assert.equal(defaultVoice(), NO_SAMPLE)
  const synth = fakeSynth()
  await speak({ text: '你好', format: 'wav', cwd }, { env, synth })
  assert.equal(synth.calls[0].vcn, NO_SAMPLE)
  await assert.rejects(setDefaultVoice('不存在的音色', env), /目录里没有/)
  assert.equal(settingsCached().defaultVcn, NO_SAMPLE, '失败不改原来的设置')
  assert.equal((await setDefaultVoice('', env)).chosen, false)

  const { api } = createHandlers({ env, synth })
  const res = await (await api(new Request('http://x/api/dsh-voice-engine', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'setDefault', code: 'nope' }) }))).json()
  assert.equal(res.ok, false)
  assert.match(res.error, /目录里没有/)
})

test('接口外层的 ok 不会被业务数据盖掉：一个音色都没确认时也算成功', async () => {
  const { env } = await makeEnv()
  const { api } = createHandlers({ env })
  for (const action of ['voiceMeta', 'status', 'voices', 'trialPlan']) {
    const res = await (await api(new Request('http://x/api/dsh-voice-engine', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, codes: [] }) }))).json()
    assert.equal(res.ok, true, action)
  }
})

test('voiceMeta：默认音色、已确认数量、筛选项一次给界面', async () => {
  const { env, cwd } = await makeEnv()
  await speak({ text: '你好', vcn: HYPER, format: 'wav', cwd }, { env, synth: fakeSynth() })
  const meta = await createActions({ env }).voiceMeta()
  assert.equal(meta.configured, true)
  assert.equal(meta.readyCount, 1)
  assert.equal(meta.default.code, HYPER)
  assert.equal(meta.total, 298)
  assert.equal(meta.hyperTotal, 140)
  assert.ok(meta.facets.langs.length > 5)
})

test('扫描：已确认能用的不再试，不重复扣字', async () => {
  const { env } = await makeEnv()
  const allowed = new Set([HYPER, NO_SAMPLE])
  const synth = fakeSynth({ denied: (vcn) => !allowed.has(vcn) })
  const first = await scanVoices({ env, synth })
  assert.equal(first.total, 140)
  assert.deepEqual(first.ok.sort(), [...allowed].sort())
  const calls = synth.calls.length
  assert.equal(calls, 140)
  const second = await scanVoices({ env, synth })
  assert.deepEqual(second.ok.sort(), [...allowed].sort())
  assert.equal(synth.calls.length - calls, 138, '能用的两个没有再试')
  assert.equal(getState().voices[NO_SAMPLE].status, 'ok')
})

test('打开音色库：请求只生效一次，没有对话时不记录', () => {
  assert.equal(requestLibrary('s9', ' 旁白 '), true)
  assert.deepEqual(takeLibraryRequest('s9'), { query: '旁白' })
  assert.equal(takeLibraryRequest('s9'), null)
  assert.equal(requestLibrary('', 'x'), false)
})

test('界面轮询时一起取走打开请求和候选', async () => {
  const { env } = await makeEnv()
  const actions = createActions({ env })
  requestLibrary('s1', '粤语')
  presentVoices('s1', { codes: [HYPER] })
  const first = await actions.picker({ sessionId: 's1' })
  assert.deepEqual(first.openLibrary, { query: '粤语' })
  assert.equal(first.pending.voices[0].code, HYPER)
  assert.equal((await actions.picker({ sessionId: 's1' })).openLibrary, null)
  await actions.pickerClear({ sessionId: 's1' })
  assert.equal(pendingVoices('s1'), null)
})

async function tools() {
  const made = await makeEnv()
  const defs = await buildToolDefinitions({ get: () => undefined }, { env: made.env, synth: fakeSynth() })
  const def = defs.find((d) => d.name === 'voice_voices')
  const exec = { agent: { session: { id: 's7', header: { cwd: made.cwd } } } }
  return async (args) => {
    const value = await def.execute(args, exec)
    return { value, text: def.output.render(args, value)[0].text }
  }
}

test('模型：能打开音色库、设默认音色；目录外的给出提示', async () => {
  const run = await tools()
  const opened = await run({ action: 'open', query: '旁白' })
  assert.equal(opened.value.opened, true)
  assert.match(opened.text, /音色库/)
  assert.deepEqual(takeLibraryRequest('s7'), { query: '旁白' })
  const set = await run({ action: 'default', code: '聆飞瀚' })
  assert.match(set.text, /聆飞瀚/)
  assert.equal(defaultVoice(), NO_SAMPLE)
  assert.match((await run({ action: 'default' })).text, /聆飞瀚/)
  const bad = await run({ action: 'default', code: '不存在' })
  assert.equal(bad.value.ok, false)
  assert.match(bad.text, /目录里没有/)
})

test('命令：/voice-list 打开音色库；/voice-default 设和查，不花字', async () => {
  const { env } = await makeEnv()
  const synth = fakeSynth()
  const commands = {}
  registerCommands({ commands: { register: (d) => { commands[d.name] = d; return () => {} } } }, { env, synth })
  const invocation = (rawInput) => ({ rawInput, agent: { session: { id: 's8' } } })
  await commands['voice-list'].handler(invocation('旁白'))
  assert.deepEqual(takeLibraryRequest('s8'), { query: '旁白' })
  assert.ok(commands['voice-default'].input)
  assert.match((await commands['voice-default'].handler(invocation('聆飞瀚'))).text, /x6_lingfeihan_pro/)
  assert.equal(settingsCached().defaultVcn, NO_SAMPLE)
  assert.match((await commands['voice-default'].handler(invocation(''))).text, /聆飞瀚/)
  assert.equal((await commands['voice-default'].handler(invocation('不存在'))).kind, 'error')
  await commands['voice-default'].handler(invocation('--off'))
  assert.equal(settingsCached().defaultVcn, '')
  assert.equal(synth.calls.length, 0)
})

test('界面代码：对比、选用、费用提示都在，打开侧栏接上了', async () => {
  const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  for (const marker of ['trialPlan', 'setDefault', 'voiceMeta', 'CompareList', 'data-voice-compare', 'x-xfyun-charged', 'right.openTab(SIDEBAR_KIND)']) {
    assert.ok(code.includes(marker), marker)
  }
})
