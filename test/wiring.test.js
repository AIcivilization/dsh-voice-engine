import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import vm from 'node:vm'
import { credentialProblem, getState, loadCredentials, looksSwapped, saveCredentials } from '../lib/config.js'
import { registerCommands } from '../lib/commands.js'
import { runDoctor } from '../lib/doctor.js'
import { _resetParts, partsSnapshot } from '../lib/health.js'
import { _resetInstanceGuard, apply, inject, name } from '../lib/index.js'
import { clearPicker, pendingVoices, presentVoices } from '../lib/picker.js'
import { createHandlers } from '../lib/routes.js'
import { buildToolDefinitions, toPlainJson } from '../lib/tools.js'
import { CREDS, fakeSynth, makeEnv } from './helpers.js'

/** 仿 cordis：没在 inject 里声明就读可选服务会抛异常 */
function fakeCtx({ approval } = {}) {
  const r = { tools: [], guards: [], commands: [], skills: [], sections: [], routes: [] }
  const services = {
    skills: { register: (def) => { r.skills.push(def); return () => {} } },
    commands: { register: (def) => { r.commands.push(def); return () => {} } },
    systemPrompt: { section: (def) => { r.sections.push(def); return () => {} } },
    connection: { fetch: { register: (def) => { r.routes.push(def); return () => {} } } },
  }
  const ctx = {
    tools: { register: (def) => { r.tools.push(def); return () => {} }, guard: (fn) => { r.guards.push(fn); return () => {} } },
    effect: () => {},
    get: (key) => (key === 'approval' ? approval : undefined),
    inject(names, fn) {
      if (names.every((n) => services[n])) fn({ ...Object.fromEntries(names.map((n) => [n, services[n]])), effect: () => {} })
    },
    logger: { warn() {}, info() {} },
  }
  return { ctx, r }
}

beforeEach(() => {
  _resetInstanceGuard()
  _resetParts()
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

test('插件接线：工具、拦截、规则、skill、命令、接口都注册上', async () => {
  const { env } = await makeEnv()
  assert.equal(name, 'dsh-voice-engine')
  assert.deepEqual(inject, ['tools'])
  const { ctx, r } = fakeCtx()
  apply(ctx, { env })
  await settle()
  assert.deepEqual(r.tools.map((t) => t.name), ['voice_listen', 'voice_account', 'voice_voices', 'voice_speak', 'voice_project', 'voice_scene'])
  assert.equal(r.guards.length, 1)
  assert.equal(r.sections[0].name, 'dsh-voice-engine:routing')
  assert.equal(typeof r.sections[0].text, 'function')
  assert.equal(r.skills[0].name, 'voice-engine')
  assert.equal(r.skills[0].source, 'runtime', '漏了 source，模型一读就报错')
  assert.ok(r.skills[0].content.includes('[=拼音]'))
  assert.deepEqual(r.commands.map((c) => c.name).sort(), ['voice-allow', 'voice-batch', 'voice-default', 'voice-doctor', 'voice-help', 'voice-list', 'voice-listen', 'voice-say', 'voice-try'])
  assert.deepEqual(r.routes.map((x) => x.path), ['/api/dsh-voice-engine', '/api/dsh-voice-engine.audio'])
  const parts = partsSnapshot()
  for (const part of ['tools', 'guard', 'prompt', 'skill', 'commands', 'routes']) assert.ok(parts[part]?.ok, part)
})

test('界面换语言后，命令说明跟着换', async () => {
  const { env } = await makeEnv()
  const { ctx, r } = fakeCtx()
  apply(ctx, { env })
  await settle()
  const { withLang } = await import('../lib/i18n.js')
  await withLang('en', async () => {})
  assert.equal(r.commands.at(-1).name, 'voice-allow')
  assert.match(r.commands.filter((c) => c.name === 'voice-help').at(-1).description, /How to use/)
  await withLang('zh', async () => {})
  assert.match(r.commands.filter((c) => c.name === 'voice-help').at(-1).description, /怎么用/)
})

test('可选服务缺席：只有 tools 也能激活；第二份不重复注册', async () => {
  const { env } = await makeEnv()
  const tools = []
  const bare = { tools: { register: (d) => { tools.push(d); return () => {} } }, effect: () => {} }
  apply(bare, { env })
  await settle()
  assert.equal(tools.length, 6)

  const { ctx, r } = fakeCtx()
  apply(ctx, { env })
  await settle()
  assert.equal(r.tools.length, 0, '已经有一份在运行')
})

async function toolsWith(opts = {}) {
  const made = await makeEnv(opts.make)
  const synth = fakeSynth(opts.synth)
  const { ctx } = fakeCtx({ approval: opts.approval })
  const defs = await buildToolDefinitions(ctx, { env: made.env, synth })
  const byName = Object.fromEntries(defs.map((d) => [d.name, d]))
  const exec = { agent: { session: { id: 's1', header: { cwd: made.cwd } } }, callId: 'c1', signal: new AbortController().signal }
  const run = async (toolName, args) => {
    const value = await byName[toolName].execute(args, exec)
    const rendered = byName[toolName].output.render(args, value)
    return { value, text: rendered[0].text }
  }
  return { ...made, synth, run, defs }
}

test('工具的返回和文字都能转成 JSON，失败不抛异常', async () => {
  const { run } = await toolsWith({ make: { credentials: false } })
  const { value, text } = await run('voice_speak', { text: '你好' })
  assert.equal(value.ok, false)
  assert.equal(value.kind, 'credentials')
  assert.match(text, /设置/)
  assert.deepEqual(toPlainJson(value), value)
})

test('voice_speak：读音给模型看，模型加标注后读对', async () => {
  const { run, cwd, synth } = await toolsWith({ synth: { readings: { 调: 'tiao2' } } })
  const first = await run('voice_speak', { text: '调用量', vcn: 'x5_lingxiaoxuan_flow', format: 'wav' })
  assert.ok(first.value.file.startsWith(cwd), '默认输出到当前工作目录')
  assert.match(first.text, /调\[tiao2\]用量/)
  const fixed = await run('voice_speak', { text: '调[=diao4]用量', vcn: 'x5_lingxiaoxuan_flow', format: 'wav' })
  assert.match(fixed.text, /调\[diao4\]用量/)
  assert.equal(synth.calls.length, 2)
})

test('超过确认阈值要问用户：拒绝就不合成，同意才合成', async () => {
  const long = '字'.repeat(2001)
  const denied = await toolsWith({ approval: { request: async () => 'rejected' } })
  const r1 = await denied.run('voice_speak', { text: long, format: 'wav' })
  assert.equal(r1.value.ok, false)
  assert.equal(r1.value.kind, 'rejected')
  assert.equal(denied.synth.calls.length, 0)

  let asked = ''
  const allowed = await toolsWith({ approval: { request: async (req) => { asked = req.reason; return 'allowed-once' } } })
  const r2 = await allowed.run('voice_speak', { text: long, format: 'wav' })
  assert.equal(r2.value.ok, true)
  assert.match(asked, /2001 字/)

  const headless = await toolsWith()
  assert.equal((await headless.run('voice_speak', { text: long, format: 'wav' })).value.kind, 'rejected')
})

test('voice_voices：搜索，以及把候选发到界面', async () => {
  const { run } = await toolsWith()
  const found = await run('voice_voices', { query: '旁白', limit: 3 })
  assert.equal(found.value.voices.length, 3)
  assert.match(found.text, /旁白/)

  const shown = await run('voice_voices', { action: 'present', codes: ['x6_pangbainan1_pro', 'x6_pangbainv1_pro', '不存在'], question: '选旁白', sampleText: '试听' })
  assert.equal(shown.value.presented, 2)
  assert.match(shown.text, /等用户/)
  const pending = pendingVoices('s1')
  assert.equal(pending.question, '选旁白')
  assert.equal(pending.sampleText, '试听')
  clearPicker('s1')
  assert.equal(pendingVoices('s1'), null)

  const bad = await run('voice_voices', { action: 'present', codes: ['不存在'] })
  assert.equal(bad.value.ok, false)
})

test('候选过期后不再显示', () => {
  let now = 1000
  presentVoices('x', { codes: ['x6_lingfeiyi_pro'] }, () => now)
  assert.ok(pendingVoices('x', () => now))
  now += 31 * 60 * 1000
  assert.equal(pendingVoices('x', () => now), null)
})

test('voice_scene：清单、手册、运行、计划中的如实说', async () => {
  const { run } = await toolsWith()
  const list = await run('voice_scene', { action: 'list', status: 'available' })
  assert.equal(list.value.scenes.length, 15)
  assert.match(list.text, /S08/)
  const got = await run('voice_scene', { action: 'get', id: 'S23' })
  assert.match(got.text, /不要编造听感/)
  const planned = await run('voice_scene', { action: 'get', id: 'S24' })
  assert.match(planned.text, /还不能用/)
  const runPlanned = await run('voice_scene', { action: 'run', id: 'S24' })
  assert.equal(runPlanned.value.kind, 'planned')
  const said = await run('voice_scene', { action: 'run', id: 'S08', text: '你好', format: 'wav' })
  assert.equal(said.value.ok, true)
  assert.match(said.text, /已生成/)
  const compared = await run('voice_scene', { action: 'run', id: 'S22', voices: ['x5_lingxiaoxuan_flow', 'x6_lingfeiyi_pro'], text: '你好', format: 'wav' })
  assert.equal(compared.value.results.length, 2)
  assert.match(compared.text, /聆飞逸/)
  const voices = await run('voice_scene', { action: 'run', id: 'S21', query: '聆飞' })
  assert.ok(voices.value.total > 0)
})

test('voice_account：状态不带密钥；诊断能跑', async () => {
  const { run } = await toolsWith()
  const status = await run('voice_account', {})
  assert.equal(status.value.credentials.configured, true)
  const dumped = JSON.stringify(status.value) + status.text
  for (const secret of [CREDS.apiKey, CREDS.apiSecret, CREDS.appId]) assert.ok(!dumped.includes(secret))
  assert.match(status.text, /尾号 345/)
  const doctor = await run('voice_account', { action: 'doctor' })
  assert.match(doctor.text, /超拟人合成：音色/)
})

test('诊断：分清服务没开、凭据不对', async () => {
  const { env } = await makeEnv({ credentials: false })
  const none = await runDoctor({ env, synth: fakeSynth() })
  assert.equal(none.ok, false)
  assert.match(none.steps[0].fix, /设置/)

  const made = await makeEnv()
  const noHyper = await runDoctor({ env: made.env, synth: fakeSynth({ denied: (_v, engine) => engine === 'hyper' }) })
  const hyper = noHyper.steps.find((s) => s.id === 'hyper')
  const v2 = noHyper.steps.find((s) => s.id === 'v2')
  assert.equal(hyper.ok, false)
  assert.match(hyper.fix, /字符量/)
  assert.equal(v2.ok, true, '超拟人不行时 v2 还要接着查')
  assert.equal(noHyper.ok, false)
})

test('凭据：认得出填错和填反，保存时自动调回，文件权限 600', async () => {
  const { env, home } = await makeEnv({ credentials: false })
  assert.match(credentialProblem({ appId: 'a@b.c', apiKey: 'k', apiSecret: 's' }).text, /AppID/)
  assert.match(credentialProblem({ appId: 'abc', apiKey: 'ak-x', apiSecret: 's' }).text, /星火/)
  assert.match(credentialProblem({ appId: 'abc', apiKey: 'k', apiSecret: 'https://x' }).text, /不是网址/)
  assert.match(credentialProblem({ appId: 'abc', apiKey: 'k' }).text, /APISecret/)
  assert.equal(credentialProblem(CREDS), null)
  assert.ok(looksSwapped({ apiKey: CREDS.apiSecret, apiSecret: CREDS.apiKey }))
  assert.ok(!looksSwapped(CREDS))

  await assert.rejects(saveCredentials({ appId: 'a@b.c', apiKey: 'k', apiSecret: 's' }, env), /AppID/)
  const { swapped } = await saveCredentials({ appId: CREDS.appId, apiKey: CREDS.apiSecret, apiSecret: CREDS.apiKey }, env)
  assert.equal(swapped, true)
  const loaded = await loadCredentials(env)
  assert.equal(loaded.apiKey, CREDS.apiKey)
  const mode = (await stat(join(home, 'dsh-voice-engine/credentials.json'))).mode & 0o777
  assert.equal(mode, 0o600)
})

const post = (body, path = 'http://dsh.test/api/dsh-voice-engine') => new Request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('接口：任何返回都不带密钥；保存后立刻检测', async () => {
  const { env } = await makeEnv({ credentials: false })
  const { api } = createHandlers({ env, synth: fakeSynth() })
  const before = await (await api(post({ action: 'status' }))).json()
  assert.equal(before.credentials.configured, false)

  const saved = await (await api(post({ action: 'saveCredentials', ...CREDS }))).json()
  assert.equal(saved.ok, true)
  assert.equal(saved.doctor.ok, true)
  const after = await (await api(post({ action: 'status' }))).json()
  assert.equal(after.credentials.configured, true)
  const dumped = JSON.stringify(saved) + JSON.stringify(after)
  assert.ok(!dumped.includes(CREDS.apiKey) && !dumped.includes(CREDS.apiSecret))

  const wrong = await (await api(post({ action: 'saveCredentials', appId: 'a@b.c', apiKey: 'k', apiSecret: 's' }))).json()
  assert.equal(wrong.ok, false)
  assert.match(wrong.error, /AppID/)

  assert.equal((await api(post({ action: 'nope' }))).status, 404)
  assert.equal((await api(new Request('http://dsh.test/api/dsh-voice-engine', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }))).status, 400)

  const cleared = await (await api(post({ action: 'clearCredentials' }))).json()
  assert.equal(cleared.status.credentials.configured, false)
})

test('接口：设置、音色、候选', async () => {
  const { env } = await makeEnv()
  const { api } = createHandlers({ env, synth: fakeSynth() })
  const set = await (await api(post({ action: 'settings', guard: false, confirmChars: 500 }))).json()
  assert.equal(set.settings.guard, false)
  assert.equal(set.settings.confirmChars, 500)
  assert.equal(getState().settings.confirmChars, 500)
  const ignored = await (await api(post({ action: 'settings', confirmChars: 5 }))).json()
  assert.equal(ignored.settings.confirmChars, 500, '不合理的值不接受')

  const voices = await (await api(post({ action: 'voices', query: '聆飞', limit: 2 }))).json()
  assert.equal(voices.voices.length, 2)

  presentVoices('s9', { codes: ['x6_lingfeiyi_pro'] })
  assert.equal((await (await api(post({ action: 'picker', sessionId: 's9' }))).json()).pending.voices[0].code, 'x6_lingfeiyi_pro')
  await api(post({ action: 'pickerClear', sessionId: 's9' }))
  assert.equal((await (await api(post({ action: 'picker', sessionId: 's9' }))).json()).pending, null)
})

test('试听：用文字合成，样音只接受目录里的音色，下载后落盘', async () => {
  const { env } = await makeEnv()
  let downloads = 0
  const fetchImpl = async (url) => {
    downloads += 1
    assert.ok(String(url).startsWith('https://aixfyun-cn-bj.xfyun.cn/'))
    return new Response(Buffer.from('RIFFsample'))
  }
  const { audio } = createHandlers({ env, synth: fakeSynth(), fetchImpl })
  const tried = await audio(post({ code: 'x5_lingxiaoxuan_flow', text: '你好' }, 'http://dsh.test/api/dsh-voice-engine.audio'))
  assert.equal(tried.headers.get('content-type'), 'audio/wav')

  const code = 'x2_mariane'
  const first = await audio(post({ code }, 'http://dsh.test/api/dsh-voice-engine.audio'))
  assert.equal(Buffer.from(await first.arrayBuffer()).toString(), 'RIFFsample')
  await audio(post({ code }, 'http://dsh.test/api/dsh-voice-engine.audio'))
  assert.equal(downloads, 1, '第二次读本地缓存')

  const unknown = await audio(post({ code: 'https://evil.example/a.wav' }, 'http://dsh.test/api/dsh-voice-engine.audio'))
  assert.equal(unknown.status, 404, '不接受任意网址')
  const long = await audio(post({ code, text: '字'.repeat(2001) }, 'http://dsh.test/api/dsh-voice-engine.audio'))
  assert.equal(long.status, 400)
})

test('命令：带参数的都声明了 input；批量先出计划，加 --yes 才执行；放行只对当前对话', async () => {
  const { env, cwd } = await makeEnv()
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(cwd, 'p.txt'), 'a,你好\n')
  const synth = fakeSynth()
  const commands = {}
  const dispose = registerCommands({ commands: { register: (d) => { commands[d.name] = d; return () => {} } } }, { env, synth })
  assert.equal(dispose.count, 9)
  for (const name of ['voice-list', 'voice-say', 'voice-try', 'voice-batch', 'voice-listen', 'voice-allow']) assert.ok(commands[name].input, `${name} 不声明 input，带参数时整句会交给模型`)
  const invocation = (rawInput) => ({ rawInput, agent: { session: { id: 's1', header: { cwd } } } })

  assert.match((await commands['voice-help'].handler()).text, /voice-say/)
  assert.match((await commands['voice-list'].handler(invocation('旁白'))).text, /旁白/)
  assert.match((await commands['voice-say'].handler(invocation('你好'))).text, /已生成|Saved/)
  assert.equal((await commands['voice-say'].handler(invocation(''))).kind, 'error')

  const plan = await commands['voice-batch'].handler(invocation('p.txt'))
  assert.equal(plan.kind, 'success')
  const before = synth.calls.length
  assert.match(plan.text, /--yes/)
  assert.equal(synth.calls.length, before, '没确认不能合成')
  const done = await commands['voice-batch'].handler(invocation('p.txt --yes'))
  assert.equal(done.kind, 'success')

  await commands['voice-allow'].handler(invocation('edge-tts'))
  assert.deepEqual(getState().allow.s1, ['edge-tts'])
  await commands['voice-allow'].handler(invocation('--off'))
  assert.equal(getState().allow.s1, undefined)
})

test('界面代码能加载，注册三处插槽，崩了不影响插件', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let module
  const window = { __ModuleLoader__: { load: (def) => { module = def } } }
  vm.runInNewContext(source, { window, console, URL, Audio: class {}, document: { documentElement: { lang: 'zh' } }, setTimeout, clearTimeout, setInterval, clearInterval, fetch, AbortSignal, navigator: {} })
  assert.equal(module.id, 'dsh-voice-engine')
  const React = { useCallback: () => {}, useEffect: () => {}, useRef: () => ({}), useState: () => [] , createElement: () => ({}) }
  const client = module.factory(() => React)
  assert.deepEqual([...client.inject], ['slots'])
  const slots = []
  client.apply({ slots: { inject: (name, fn) => { fn(); slots.push(name) }, register: () => () => {} } })
  assert.deepEqual(slots.sort(), ['conversation.composer.dock', 'settings.section'])
  assert.doesNotThrow(() => client.apply({ slots: { inject: () => { throw new Error('boom') } } }))
})
