import assert from 'node:assert/strict'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { getState, markVoice, updateSettings } from '../lib/config.js'
import { compareVoices, getScene, listScenes, parseBatch, runBatch, runScene } from '../lib/scenes.js'
import { SpeakError, countChars, resolveOutput, speak, stripAnnotations } from '../lib/speak.js'
import { CATALOG, POLYPHONES, defaultVoice, engineOf, resolveVoice, searchVoices } from '../lib/voices.js'
import { ConnectError } from '../lib/xf/tts.js'
import { fakeSynth, makeEnv } from './helpers.js'

test('合成：写出文件，返回时长、说话时段和读音，多音字标了拼音', async () => {
  const { env, cwd } = await makeEnv()
  const synth = fakeSynth({ readings: { 调: 'tiao2' } })
  const r = await speak({ text: '调用人', vcn: 'x5_lingxiaoxuan_flow', format: 'wav', cwd }, { env, synth })
  assert.equal(r.ok, true)
  assert.equal(r.voiceName, '聆小璇')
  assert.equal(r.engine, 'hyper')
  assert.equal(r.chars, 3)
  assert.equal(r.readings, '调[tiao2]用人')
  assert.deepEqual(r.speech, { startMs: 500, endMs: 800 })
  assert.equal(r.format, 'wav')
  assert.ok(r.file.startsWith(join(cwd, 'voice-output')))
  assert.equal((await readFile(r.file)).toString('ascii', 0, 4), 'RIFF')
  assert.equal(getState().voices.x5_lingxiaoxuan_flow.status, 'ok')
})

test('读音标注发给超拟人，但 v2 必须去掉，否则会被念成「调94用」', async () => {
  const { env, cwd } = await makeEnv()
  const synth = fakeSynth()
  await speak({ text: '调[=diao4]用', vcn: 'x5_lingxiaoxuan_flow', format: 'wav', cwd }, { env, synth })
  assert.equal(synth.calls[0].text, '调[=diao4]用')

  const r = await speak({ text: '调[=diao4]用', vcn: 'xiaoyan', format: 'wav', cwd }, { env, synth })
  assert.equal(synth.calls[1].text, '调用')
  assert.equal(synth.calls[1].engine, 'v2')
  assert.ok(r.warnings.some((w) => w.includes('不支持读音标注')))
  assert.equal(r.readings, undefined)
  assert.ok(r.warnings.some((w) => w.includes('没有读音信息')))
})

test('标注生效：返回的读音是标注后的结果，字数不把标注算进去', async () => {
  const { env, cwd } = await makeEnv()
  const r = await speak({ text: '调[=diao4]用', vcn: 'x5_lingxiaoxuan_flow', format: 'wav', cwd }, { env, synth: fakeSynth({ readings: { 调: 'tiao2' } }) })
  assert.equal(r.readings, '调[diao4]用')
  assert.equal(countChars('调[=diao4]用 量'), 3)
  assert.equal(stripAnnotations('调[=diao4]用[说明]'), '调用[说明]')
})

test('缓存：同样内容不重复请求、不重复计量，换音色或改标注才重新合成', async () => {
  const { env, cwd } = await makeEnv()
  const synth = fakeSynth()
  const first = await speak({ text: '你好', vcn: 'x5_lingxiaoxuan_flow', format: 'wav', cwd }, { env, synth })
  const second = await speak({ text: '你好', vcn: 'x5_lingxiaoxuan_flow', format: 'wav', cwd }, { env, synth })
  assert.equal(first.cached, false)
  assert.equal(second.cached, true)
  assert.equal(synth.calls.length, 1)
  assert.equal(Object.values(getState().usage)[0].chars, 2)

  await speak({ text: '你好', vcn: 'x6_lingfeiyi_pro', format: 'wav', cwd }, { env, synth })
  await speak({ text: '你[=ni3]好', vcn: 'x5_lingxiaoxuan_flow', format: 'wav', cwd }, { env, synth })
  assert.equal(synth.calls.length, 3)
})

test('音色未授权：给出当前账号可用的音色', async () => {
  const { env, cwd } = await makeEnv()
  const synth = fakeSynth({ denied: (vcn) => vcn === 'x6_ruyadashu_pro' })
  await assert.rejects(speak({ text: '你好', vcn: 'x6_ruyadashu_pro', format: 'wav', cwd }, { env, synth }), (e) => {
    assert.ok(e instanceof SpeakError)
    assert.equal(e.kind, 'voice')
    assert.equal(e.code, 11200)
    assert.ok(e.alternatives.includes('x5_lingxiaoxuan_flow'), '没有已知可用音色时要探测官方免费音色')
    return true
  })
  assert.equal(getState().voices.x6_ruyadashu_pro.status, 'denied')
})

test('所有音色都 11200：判断为服务没开或没有字符量，不说是音色的问题', async () => {
  const { env, cwd } = await makeEnv()
  const synth = fakeSynth({ denied: () => true })
  await assert.rejects(speak({ text: '你好', vcn: 'x6_ruyadashu_pro', format: 'wav', cwd }, { env, synth }), (e) => {
    assert.equal(e.kind, 'service')
    assert.match(e.hint, /字符量/)
    assert.deepEqual(e.alternatives, [])
    return true
  })
})

test('连接失败：读服务器的文字，告诉用户具体哪里错了', async () => {
  const { env, cwd } = await makeEnv()
  const synth = { hyper: async () => { throw new ConnectError('wss://cbm01.cn-huabei-1.xf-yun.com/v1/private/mcd9m97e6') } }
  const fetchImpl = async () => new Response('{"message":"HMAC signature does not match"}', { status: 401 })
  await assert.rejects(speak({ text: '你好', vcn: 'x5_lingxiaoxuan_flow', format: 'wav', cwd }, { env, synth, fetchImpl }), (e) => {
    assert.equal(e.kind, 'credentials')
    assert.match(e.message, /APISecret/)
    return true
  })
})

test('没配凭据时不发请求', async () => {
  const { env, cwd } = await makeEnv({ credentials: false })
  const synth = fakeSynth()
  await assert.rejects(speak({ text: '你好', format: 'wav', cwd }, { env, synth }), (e) => e.kind === 'credentials')
  assert.equal(synth.calls.length, 0)
})

test('文本为空或太长都不发请求', async () => {
  const { env, cwd } = await makeEnv()
  const synth = fakeSynth()
  await assert.rejects(speak({ text: '  ', format: 'wav', cwd }, { env, synth }), /空的/)
  await assert.rejects(speak({ text: '字'.repeat(3000), vcn: 'xiaoyan', format: 'wav', cwd }, { env, synth }), /太长/)
  assert.equal(synth.calls.length, 0)
})

test('输出路径：相对工作目录，按扩展名定格式，没扩展名当目录', () => {
  const base = { cwd: '/w', env: { DSH_HOME: '/h' }, text: '你好', key: 'abcdef1234567890', format: 'mp3' }
  assert.deepEqual(resolveOutput({ ...base }), { file: '/w/voice-output/你好-abcdef12.mp3', format: 'mp3' })
  assert.deepEqual(resolveOutput({ ...base, output: 'a/b.wav' }), { file: '/w/a/b.wav', format: 'wav' })
  assert.deepEqual(resolveOutput({ ...base, output: '/abs/c.mp3' }), { file: '/abs/c.mp3', format: 'mp3' })
  assert.deepEqual(resolveOutput({ ...base, output: 'dir/' }), { file: '/w/dir/你好-abcdef12.mp3', format: 'mp3' })
  assert.equal(resolveOutput({ ...base, cwd: undefined }).file, '/h/dsh-voice-engine/output/你好-abcdef12.mp3')
})

test('目录：名字能解析到编码，优先已授权；目录外的编码也能判断引擎', async () => {
  const { env } = await makeEnv()
  assert.equal(engineOf('x5_lingxiaoxuan_flow'), 'hyper')
  assert.equal(engineOf('xiaoyan'), 'v2')
  assert.equal(engineOf('x6_notinlist_pro'), 'hyper')
  assert.equal(resolveVoice('x6_lingfeiyi_pro'), 'x6_lingfeiyi_pro')
  await markVoice('x6_lingfeiyi_pro', 'ok', env)
  assert.equal(resolveVoice('聆飞逸'), 'x6_lingfeiyi_pro')
  assert.equal(resolveVoice('完全没有这个名字'), '完全没有这个名字')
  assert.ok(POLYPHONES.has('调') && POLYPHONES.has('朝') && !POLYPHONES.has('一') && !POLYPHONES.has('人'))
  assert.ok(CATALOG.length > 300)
})

test('默认音色：设置优先，其次已知可用的，最后才是官方免费音色', async () => {
  const { env } = await makeEnv()
  assert.equal(defaultVoice(), 'x5_lingxiaoxuan_flow')
  await markVoice('x5_lingxiaotang_flow', 'ok', env)
  assert.equal(defaultVoice(), 'x5_lingxiaotang_flow')
  await updateSettings({ defaultVcn: 'x6_lingfeiyi_pro' }, env)
  assert.equal(defaultVoice(), 'x6_lingfeiyi_pro')
})

test('搜索：可用的排前面，方言和场景能查，没有编码的音色不提供给模型', async () => {
  const { env } = await makeEnv()
  await markVoice('x6_daqixuanchuanpiannansheng_mini', 'ok', env)
  const hits = searchVoices({ query: '宣传', limit: 5 })
  assert.equal(hits.voices[0].code, 'x6_daqixuanchuanpiannansheng_mini')
  assert.equal(hits.voices[0].status, 'ok')
  assert.ok(searchVoices({ dialect: '四川' }).voices.some((v) => v.code === 'x3_yezi_sc'))
  assert.ok(searchVoices({ query: 'lingfeiyi', engine: 'hyper' }).total >= 1)
  assert.ok(searchVoices({ limit: 500 }).voices.every((v) => v.code && !v.code.startsWith('name:')))
  assert.equal(searchVoices({ status: 'denied' }).total, 0)
})

test('30 个场景：编号连续、分类数量和方案一致，M3 累计 15 个可用', async () => {
  const scenes = listScenes()
  assert.equal(scenes.length, 30)
  assert.deepEqual(scenes.map((s) => s.id), Array.from({ length: 30 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`))
  const count = (mode) => scenes.filter((s) => s.mode === mode).length
  assert.deepEqual([count('代码'), count('混合'), count('AI')], [12, 9, 9])
  assert.deepEqual(listScenes({ status: 'available' }).map((s) => s.id), ['S01', 'S02', 'S03', 'S08', 'S13', 'S14', 'S15', 'S16', 'S17', 'S18', 'S19', 'S20', 'S21', 'S22', 'S23'])
  for (const scene of listScenes({ status: 'available' })) {
    assert.ok((await getScene(scene.id)).playbookText.length > 50, `${scene.id} 要有手册`)
  }
  assert.equal(await getScene('S99'), null)
  assert.equal((await getScene('s13')).id, 'S13')
})

test('未做好的场景如实拒绝；AI 场景不能直接运行', async () => {
  await assert.rejects(runScene('S24'), (e) => e.kind === 'planned' && /M4/.test(e.message))
  await assert.rejects(runScene('S23'), /不能直接运行/)
  await assert.rejects(runScene('S99'), /没有这个场景/)
})

test('清单解析：文件名和文本，跳过注释，重名加序号，文件名不能带路径', () => {
  const items = parseBatch('# 注释\nwelcome,您好\n\nwelcome,再次您好\n只有文本的一行\n../../evil,不能穿越\n')
  assert.deepEqual(items.map((i) => i.name), ['welcome', 'welcome-2', '003', '004'])
  assert.equal(items[0].text, '您好')
  assert.equal(items[2].text, '只有文本的一行')
  assert.equal(items[3].text, '../../evil,不能穿越')
  assert.equal(items[0].line, 2)
})

test('批量：逐条生成，重跑走缓存，多音字才给模型看', async () => {
  const { env, cwd } = await makeEnv()
  await writeFile(join(cwd, 'prompts.txt'), 'a,人人\nb,调用\n')
  const synth = fakeSynth({ readings: { 调: 'tiao2' } })
  const r = await runBatch({ file: 'prompts.txt', vcn: 'x5_lingxiaoxuan_flow', format: 'wav', cwd }, { env, synth })
  assert.equal(r.ok, true)
  assert.equal(r.done.length, 2)
  assert.equal(r.outputDir, join(cwd, 'voice-output', 'prompts'))
  assert.ok((await stat(join(r.outputDir, 'a.wav'))).size > 44)
  assert.equal(r.done[0].readings, undefined)
  assert.equal(r.done[1].readings, '调[tiao2]用')

  const again = await runBatch({ file: 'prompts.txt', vcn: 'x5_lingxiaoxuan_flow', format: 'wav', cwd }, { env, synth })
  assert.ok(again.done.every((d) => d.cached))
  assert.equal(synth.calls.length, 2)
})

test('批量：服务级问题提前停止，不把每一条都试一遍', async () => {
  const { env, cwd } = await makeEnv()
  await writeFile(join(cwd, 'list.txt'), Array.from({ length: 20 }, (_, i) => `n${i},第${i}条`).join('\n'))
  const synth = fakeSynth({ denied: () => true })
  const r = await runBatch({ file: 'list.txt', format: 'wav', cwd, concurrency: 1 }, { env, synth })
  assert.equal(r.ok, false)
  assert.equal(r.stopped, 'service')
  assert.equal(r.failed.length, 1)
  assert.equal(r.skipped, 19)
})

test('试音对比：一个未授权不影响其他；超过上限直接拒绝', async () => {
  const { env, cwd } = await makeEnv()
  await markVoice('x5_lingxiaoxuan_flow', 'ok', env)
  const synth = fakeSynth({ denied: (vcn) => vcn === 'x6_ruyadashu_pro' })
  const r = await compareVoices({ voices: ['x5_lingxiaoxuan_flow', 'x6_ruyadashu_pro'], text: '你好', format: 'wav', cwd }, { env, synth })
  assert.equal(r.results[0].ok, true)
  assert.equal(r.results[1].ok, false)
  assert.equal(r.results[1].kind, 'voice')
  await assert.rejects(compareVoices({ voices: ['a', 'b', 'c', 'd', 'e', 'f'], text: '你好', cwd }, { env, synth }), /最多/)
  await assert.rejects(compareVoices({ voices: ['a'], text: '字'.repeat(201), cwd }, { env, synth }), /200/)
})
