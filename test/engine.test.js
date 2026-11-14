// test/engine.test.js — 声音引擎：讯飞、Edge、Ming 统一调用，对外接口。全部不联网，Edge 和 Ming 用假的

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { updateSettings } from '../lib/config.js'
import { createMingWorker, findMing, mingUnsupported } from '../lib/engine/ming.js'
import { engineStatus, listAllVoices, parseVoice, searchOtherVoices, synthesizeAny, xfyunSpeed } from '../lib/engine/index.js'
import { engineFile, startEngineServer } from '../lib/engine/server.js'
import { voiceGuard } from '../lib/guard.js'
import { presentVoices } from '../lib/picker.js'
import { createActions, createHandlers } from '../lib/routes.js'
import { buildToolDefinitions } from '../lib/tools.js'
import { defaultVoice, defaultVoiceInfo, setDefaultVoice } from '../lib/voices.js'
import { fakeSynth, makeEnv } from './helpers.js'

/** 假的 edge-tts：按参数写一个 mp3 文件，记下调用 */
function fakeEdge() {
  const calls = []
  const run = async (_bin, args) => {
    calls.push(args)
    const out = args[args.indexOf('--write-media') + 1]
    await writeFile(out, Buffer.from(`ID3-fake-${args[args.indexOf('--voice') + 1]}`))
    return ''
  }
  return { run, calls }
}

const fakeMing = () => {
  const calls = []
  return { calls, speak: async (_found, text, voice) => { calls.push({ text, voice }); return { pcm: Buffer.alloc(44100 * 2), sampleRate: 44100 } } }
}

async function setup() {
  const made = await makeEnv()
  // 让 Edge 看起来装好了：随便指一个存在的可执行文件，真正执行的是假的 run
  const env = { ...made.env, EDGE_TTS_PATH: process.execPath }
  const edge = fakeEdge()
  const ming = fakeMing()
  const synth = fakeSynth()
  const deps = { env, synth, edgeRun: edge.run, mingWorker: ming, findFfmpeg: async () => null }
  return { ...made, env, edge, ming, synth, deps }
}

test('编号：带前缀、只写名字都认；讯飞照旧；带前缀但不存在的报错', () => {
  assert.deepEqual(parseVoice('edge:zh-CN-XiaoxiaoNeural').engine, 'edge')
  assert.equal(parseVoice('晓晓').id, 'zh-CN-XiaoxiaoNeural')
  assert.equal(parseVoice('ming:灵小雅').engine, 'ming')
  assert.equal(parseVoice('灵阅川').id, '灵阅川_中性')
  assert.deepEqual(parseVoice('聆飞瀚'), { engine: 'xfyun', id: 'x6_lingfeihan_pro', name: '聆飞瀚' })
  assert.equal(parseVoice('xfyun:x6_lingfeihan_pro').id, 'x6_lingfeihan_pro')
  assert.throws(() => parseVoice('edge:nope'), /没有这个音色/)
})

test('语速换算：讯飞 0–100，1 倍是 50', () => {
  assert.deepEqual([xfyunSpeed(1), xfyunSpeed(2), xfyunSpeed(0.5), xfyunSpeed(3)], [50, 100, 25, 100])
})

test('音色列表：Edge 28 个、Ming 13 个，字段和讯飞一致，能按语种和声线筛', async () => {
  const { env } = await setup()
  assert.equal(searchOtherVoices({ engine: 'edge' }, env).total, 28)
  assert.equal(searchOtherVoices({ engine: 'ming' }, env).total, 13)
  const yue = searchOtherVoices({ lang: 'yue' }, env).voices
  assert.ok(yue.length === 3 && yue.every((v) => v.code.startsWith('edge:')))
  const v = searchOtherVoices({ query: '晓晓' }, env).voices[0]
  assert.equal(v.free, true)
  assert.equal(v.trialText, '你好，这是我的声音。')
  assert.equal(searchOtherVoices({ query: 'Andrew' }, env).voices[0].trialText, 'Hello, this is my voice.')
  const all = listAllVoices({}, env)
  assert.ok(all.voices.some((x) => x.id.startsWith('xfyun:')) && all.voices.some((x) => x.id.startsWith('ming:')))
})

test('Edge：调用 edge-tts，语速换成百分比；第二次走缓存', async () => {
  const { deps, edge } = await setup()
  const r = await synthesizeAny({ voice: '晓晓', text: '你好', speed: 1.2 }, deps)
  assert.equal(r.engine, 'edge')
  assert.equal(r.format, 'mp3')
  assert.equal(r.charged, 0)
  assert.match(r.audio.toString(), /zh-CN-XiaoxiaoNeural/)
  assert.ok(edge.calls[0].includes('--rate=+20%'))
  assert.ok(r.warnings.some((w) => /没有读音反馈/.test(w)))
  const again = await synthesizeAny({ voice: '晓晓', text: '你好', speed: 1.2 }, deps)
  assert.equal(again.cached, true)
  assert.equal(edge.calls.length, 1)
})

test('Ming：PCM 变成 wav，数字交给它的读法；没装时说清楚怎么办', async () => {
  const { deps, ming, env } = await setup()
  const r = await synthesizeAny({ voice: 'ming:灵小雅', text: '你好', format: 'wav' }, deps)
  assert.equal(r.engine, 'ming')
  assert.equal(r.format, 'wav')
  assert.equal(r.durationMs, 1000)
  assert.equal(ming.calls[0].voice, '灵小雅')
  const slow = await synthesizeAny({ voice: 'ming:灵小雅', text: '慢一点', speed: 0.8, format: 'wav' }, deps)
  assert.ok(slow.warnings.some((w) => /没有调语速/.test(w)))
  // 找不到装好的 Ming：说明去哪里装，不自己下载 2 GB
  assert.equal(findMing(env, () => false), null)
  const found = findMing({ ...env, DSH_VOICE_MING_HOME: '/x/ming' }, (p) => p.startsWith('/x/ming'))
  assert.deepEqual(found, { root: '/x/ming', python: '/x/ming/env/bin/python3', model: '/x/ming/model' })
  assert.match(mingUnsupported('linux', 'x64', '23'), /Apple 芯片/)
  assert.match(mingUnsupported('darwin', 'arm64', '22'), /macOS 14/)
  await assert.rejects(synthesizeAny({ voice: 'ming:灵小雅x', text: '你好' }, deps), /没有这个音色/)
})

test('Ming 常驻进程：只加载一次模型、排队合成、闲置自动退出', async () => {
  const sent = []
  let killed = 0
  const spawnImpl = () => {
    const proc = new EventEmitter()
    proc.stdin = new PassThrough()
    proc.stdout = new PassThrough()
    proc.stderr = new PassThrough()
    proc.kill = () => { killed += 1 }
    proc.stdin.on('data', (chunk) => {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        const msg = JSON.parse(line)
        sent.push(msg.op)
        const reply = msg.op === 'load' ? { id: msg.id, ok: true } : { id: msg.id, ok: true, pcm16: Buffer.alloc(8).toString('base64'), sampleRate: 44100 }
        setImmediate(() => proc.stdout.write(`${JSON.stringify(reply)}\n`))
      }
    })
    return proc
  }
  const worker = createMingWorker({ spawnImpl, idleMs: 30 })
  const found = { python: 'py', model: 'm' }
  const [a, b] = await Promise.all([worker.speak(found, '一', '灵小雅'), worker.speak(found, '2个', '灵小雅')])
  assert.equal(a.pcm.length, 8)
  assert.equal(b.sampleRate, 44100)
  assert.deepEqual(sent, ['load', 'speak', 'speak'])
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(killed, 1)
  assert.equal(worker.running(), false)
})

test('讯飞仍走原来的合成：扣字、缓存都照旧', async () => {
  const { deps, synth } = await setup()
  const r = await synthesizeAny({ voice: '聆飞瀚', text: '你好', format: 'wav' }, deps)
  assert.equal(r.engine, 'xfyun')
  assert.equal(r.charged, 2)
  assert.equal(synth.calls[0].vcn, 'x6_lingfeihan_pro')
  assert.equal((await synthesizeAny({ voice: '聆飞瀚', text: '你好', format: 'wav' }, deps)).charged, 0)
})

test('默认音色可以是 Edge、Ming；讯飞自己的功能仍用声音引擎', async () => {
  const { deps, env, edge } = await setup()
  const info = await setDefaultVoice('晓晓', env)
  assert.deepEqual([info.code, info.engine, info.name], ['edge:zh-CN-XiaoxiaoNeural', 'edge', '晓晓'])
  assert.equal(defaultVoiceInfo().engine, 'edge')
  assert.match(defaultVoice(), /^x\d_/, '讯飞的默认音色不受影响')
  const r = await synthesizeAny({ text: '没指定音色' }, deps)
  assert.equal(r.engine, 'edge')
  assert.equal(edge.calls.length, 1)
})

test('voice_speak：传 Edge 音色就用 Edge，不弹扣费确认，存成文件', async () => {
  const { deps, cwd, edge } = await setup()
  const defs = await buildToolDefinitions({ get: () => ({ request: async () => 'rejected' }) }, deps)
  const def = defs.find((d) => d.name === 'voice_speak')
  const exec = { agent: { session: { id: 's', header: { cwd } } } }
  const value = await def.execute({ text: '字'.repeat(2500), vcn: 'edge:zh-CN-YunxiNeural' }, exec)
  assert.equal(value.ok, true)
  assert.equal(value.engine, 'edge')
  assert.ok((await stat(value.file)).size > 0)
  assert.ok(value.file.startsWith(cwd))
  assert.match(def.output.render({}, value)[0].text, /云希/)
  assert.equal(edge.calls.length, 1)
})

test('音色库接口：Edge、Ming 能列、能试听、试听不扣字；模型能把 Edge 音色发给用户选', async () => {
  const { deps } = await setup()
  const actions = createActions(deps)
  const list = await actions.voices({ engine: 'ming' })
  assert.equal(list.total, 13)
  const plan = await actions.trialPlan({ codes: ['edge:zh-CN-XiaoxiaoNeural', 'ming:灵小雅'], text: '你好' })
  assert.equal(plan.charge, 0)
  const meta = await actions.voiceMeta()
  assert.equal(meta.engines.edge.ready, true)
  const { audio } = createHandlers(deps)
  const res = await audio(new Request('http://x/a', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'edge:en-US-AndrewNeural' }) }))
  assert.equal(res.headers.get('content-type'), 'audio/mpeg')
  assert.equal(res.headers.get('x-xfyun-charged'), '0')
  const entry = presentVoices('s1', { codes: ['edge:zh-CN-XiaoxiaoNeural', 'ming:灵小雅', 'x6_lingfeihan_pro'] })
  assert.deepEqual(entry.voices.map((v) => v.engine), ['edge', 'ming', 'hyper'])
})

test('优先路由：拦下 edge-tts 时告诉模型用 voice_speak 的 Edge 音色', async () => {
  await makeEnv()
  const text = voiceGuard({ name: 'bash', arguments: { command: 'edge-tts --text hi --write-media a.mp3' }, agent: { session: { id: 's' } } })
  assert.match(text, /edge:/)
})

// —— 对外接口 ——

async function server() {
  const ctx = await setup()
  const port = 40000 + Math.floor(Math.random() * 20000)
  const s = await startEngineServer({ port, deps: ctx.deps })
  const saved = JSON.parse(await readFile(engineFile(ctx.env), 'utf8'))
  const call = (path, { method = 'GET', body, token = s.token, host } = {}) => fetch(`${s.url}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(host ? { host } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { ...ctx, s, saved, call }
}

test('接口：地址和令牌写进 engine.json（权限 600），重启后令牌不变', async () => {
  const { s, saved, env, deps } = await server()
  assert.equal(saved.url, s.url)
  assert.equal(saved.token, s.token)
  assert.equal((await stat(engineFile(env))).mode & 0o777, 0o600)
  await s.close()
  const again = await startEngineServer({ port: s.port, deps })
  assert.equal(again.token, s.token)
  await again.close()
})

test('接口：health 不用令牌；其他要令牌；只认本机地址', async () => {
  const { s, call } = await server()
  try {
    assert.equal((await (await call('/v1/health', { token: '' })).json()).name, 'dsh-voice-engine')
    assert.equal((await call('/v1/voices', { token: '' })).status, 401)
    assert.equal((await call('/v1/voices', { token: 'x'.repeat(32) })).status, 401)
    const engines = await (await call('/v1/engines')).json()
    assert.equal(engines.engines.xfyun.open, false)
    assert.equal((await call('/v1/nope')).status, 404)
  } finally {
    await s.close()
  }
})

test('接口：用 Edge 合成，响应头说明引擎、扣费和缓存', async () => {
  const { s, call } = await server()
  try {
    const res = await call('/v1/speak', { method: 'POST', body: { text: '你好', voice: 'edge:zh-CN-XiaoxiaoNeural' } })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'audio/mpeg')
    assert.equal(res.headers.get('x-voice-engine'), 'edge')
    assert.equal(decodeURIComponent(res.headers.get('x-voice-id')), 'edge:zh-CN-XiaoxiaoNeural')
    assert.equal(res.headers.get('x-voice-charged-chars'), '0')
    assert.ok((await res.arrayBuffer()).byteLength > 0)
    const again = await call('/v1/speak', { method: 'POST', body: { text: '你好', voice: 'edge:zh-CN-XiaoxiaoNeural' } })
    assert.equal(again.headers.get('x-voice-cached'), 'true')
    const voices = await (await call('/v1/voices?engine=edge&lang=yue')).json()
    assert.equal(voices.total, 3)
  } finally {
    await s.close()
  }
})

test('接口：讯飞默认不对外开放；打开后才能用，而且有字数上限', async () => {
  const { s, call, env, synth } = await server()
  try {
    const closed = await call('/v1/speak', { method: 'POST', body: { text: '你好', voice: '聆飞瀚' } })
    assert.equal(closed.status, 403)
    assert.equal((await closed.json()).kind, 'xfyun-closed')
    assert.equal(synth.calls.length, 0)
    await updateSettings({ engineAllowXfyun: true }, env)
    const open = await call('/v1/speak', { method: 'POST', body: { text: '你好', voice: '聆飞瀚', format: 'wav' } })
    assert.equal(open.status, 200)
    assert.equal(open.headers.get('x-voice-charged-chars'), '2')
    const long = await call('/v1/speak', { method: 'POST', body: { text: '字'.repeat(2001), voice: '聆飞瀚' } })
    assert.equal((await long.json()).kind, 'too-long')
  } finally {
    await updateSettings({ engineAllowXfyun: false }, env)
    await s.close()
  }
})

test('接口：参数错误给出提示，不是 JSON、音色不存在、语速超范围', async () => {
  const { s, call } = await server()
  try {
    const bad = await fetch(`${s.url}/v1/speak`, { method: 'POST', headers: { authorization: `Bearer ${s.token}` }, body: 'not json' })
    assert.equal(bad.status, 400)
    const noVoice = await (await call('/v1/speak', { method: 'POST', body: { text: '你好', voice: 'edge:nope' } })).json()
    assert.equal(noVoice.kind, 'param')
    assert.match(noVoice.hint, /voices/)
    const fast = await call('/v1/speak', { method: 'POST', body: { text: '你好', voice: '晓晓', speed: 5 } })
    assert.equal(fast.status, 400)
    const empty = await call('/v1/speak', { method: 'POST', body: { text: '', voice: '晓晓' } })
    assert.equal(empty.status, 400)
  } finally {
    await s.close()
  }
})

test('引擎状态：三家都有说明；Edge 找不到时告诉怎么装', async () => {
  const { env } = await setup()
  const status = engineStatus({ ...env, EDGE_TTS_PATH: '/nonexistent/edge-tts' })
  assert.equal(status.xfyun.cost, 'paid')
  assert.equal(status.edge.cost, 'free')
  assert.equal(status.ming.network, false)
})

test('接口：Host 不是本机地址就拒绝（防网页 DNS 重绑定）', async () => {
  const { createEngineHandler } = await import('../lib/engine/server.js')
  const handler = createEngineHandler({ token: 't'.repeat(32), port: 18321 })
  const run = async (host) => {
    let status = 0
    let body = ''
    await handler({ url: '/v1/health', method: 'GET', headers: { host } }, { writeHead: (s) => { status = s }, end: (b) => { body = String(b) } })
    return { status, body }
  }
  assert.equal((await run('evil.example:18321')).status, 403)
  assert.equal((await run('127.0.0.1:18321')).status, 200)
  assert.equal((await run('localhost:18321')).status, 200)
})

// —— 改名、SDK、给别的插件的服务 ——

test('改名：第一次启动把 dsh-xfyun 的凭据、设置、缓存、令牌复制过来，旧的不动；新目录有东西就不再复制', async () => {
  const { mkdtemp, mkdir: mk, writeFile: wf, readFile: rf, stat: st } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { loadState, migrationResult, settingsCached, _resetMemory } = await import('../lib/config.js')
  const home = await mkdtemp(join(tmpdir(), 'migrate-'))
  const old = join(home, 'dsh-xfyun')
  await mk(join(old, 'cache', 'ab'), { recursive: true })
  await wf(join(old, 'credentials.json'), JSON.stringify({ appId: 'a1b2c3d4', apiKey: '0123456789abcdef0123456789abcdef', apiSecret: 'c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0' }))
  await wf(join(old, 'state.json'), JSON.stringify({ schema: 1, settings: { defaultVcn: 'ming:灵小萌' }, voices: {}, allow: {}, usage: {} }))
  await wf(join(old, 'engine.json'), JSON.stringify({ url: 'http://127.0.0.1:18321', token: 't'.repeat(32) }))
  await wf(join(old, 'cache', 'ab', 'x.pcm'), 'pcm')
  _resetMemory()
  await loadState({ DSH_HOME: home })
  assert.equal(migrationResult().migrated, true)
  assert.equal(settingsCached().defaultVcn, 'ming:灵小萌')
  const root = join(home, 'dsh-voice-engine')
  assert.equal((await st(join(root, 'credentials.json'))).mode & 0o777, 0o600)
  assert.equal(JSON.parse(await rf(join(root, 'engine.json'), 'utf8')).token, 't'.repeat(32), '令牌不变，别的产品不用重新配')
  assert.equal(await rf(join(root, 'cache', 'ab', 'x.pcm'), 'utf8'), 'pcm')
  assert.ok(await st(join(old, 'credentials.json')), '旧的还在')
  await wf(join(old, 'state.json'), JSON.stringify({ schema: 1, settings: { defaultVcn: 'edge:zh-CN-YunxiNeural' } }))
  _resetMemory()
  await loadState({ DSH_HOME: home })
  assert.equal(migrationResult().migrated, false)
  assert.equal(settingsCached().defaultVcn, 'ming:灵小萌', '新目录有了就不再覆盖')
})

test('SDK：自己读地址和令牌，一行合成并存文件；接口不在时说清楚', async () => {
  const { s, env } = await server()
  const sdk = await import('../sdk/index.js')
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  try {
    const file = sdk.engineFilePath(env)
    assert.equal(file, engineFile(env))
    const connection = await sdk.connect({ file })
    assert.equal(await sdk.available(connection), true)
    const out = join(await mkdtemp(join(tmpdir(), 'sdk-')), 'hello.mp3')
    const r = await sdk.speak('你好', { voice: 'edge:zh-CN-XiaoxiaoNeural', out, connection })
    assert.equal(r.engine, 'edge')
    assert.equal(r.chargedChars, 0)
    assert.ok((await stat(out)).size > 0)
    assert.equal((await sdk.voices({ engine: 'ming' }, connection)).total, 13)
    assert.equal((await sdk.engines(connection)).xfyun.open, false)
    await assert.rejects(sdk.speak('你好', { voice: '聆飞瀚', connection }), (e) => e instanceof sdk.VoiceEngineError && e.kind === 'xfyun-closed' && e.status === 403)
    await assert.rejects(sdk.connect({ file: '/nonexistent/engine.json' }), (e) => e.kind === 'not-running' && /DSH/.test(e.hint))
    assert.equal(await sdk.available({ url: 'http://127.0.0.1:1', token: 'x' }), false)
  } finally {
    await s.close()
  }
})

test('给别的 DSH 插件的服务：能合成、能查音色；讯飞默认不对外', async () => {
  const { deps, env } = await setup()
  const { createVoiceService } = await import('../lib/engine/service.js')
  const svc = createVoiceService(deps)
  const r = await svc.speak('你好', { voice: '晓晓' })
  assert.equal(r.engine, 'edge')
  assert.equal(svc.voices({ engine: 'edge' }).total, 28)
  assert.equal(svc.engines().xfyun.open, false)
  await assert.rejects(svc.speak('你好', { voice: '聆飞瀚' }), (e) => e.kind === 'xfyun-closed')
  await updateSettings({ engineAllowXfyun: true }, env)
  assert.equal((await svc.speak('你好', { voice: '聆飞瀚', format: 'wav' })).engine, 'xfyun')
  await updateSettings({ engineAllowXfyun: false }, env)
})
