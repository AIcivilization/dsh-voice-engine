// test/listen.test.js — 转写：解析、字幕、落盘恢复、重复不扣费、回听。全部不联网

import assert from 'node:assert/strict'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { compareToScript, diffText, explainOst, parseFfmpegDuration, planTranscribe, segmentsToCues, toPlainText, transcribe } from '../lib/listen.js'
import { getState } from '../lib/config.js'
import { findFfmpeg } from '../lib/speak.js'
import { OstError, parseOstResult, signHeaders, uploadAudio } from '../lib/xf/ost.js'
import { fakeSynth, makeEnv } from './helpers.js'
import { buildToolDefinitions } from '../lib/tools.js'
import { registerCommands } from '../lib/commands.js'
import { truncate } from 'node:fs/promises'

const REAL = JSON.parse(await readFile(new URL('./fixtures/ost-result.json', import.meta.url), 'utf8'))

/** 假的讯飞转写接口：记录调用，可以指定查询要几次才完成 */
function fakeOst({ result = REAL, queriesUntilDone = 1, notFoundFirst = 0, createError = null } = {}) {
  const calls = { upload: 0, create: 0, query: 0, bodies: [], paths: [] }
  let queries = 0
  const json = (value, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(value) })
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname
    calls.paths.push(path)
    if (path === '/file/upload') {
      calls.upload += 1
      return json({ code: 0, data: { url: 'https://x/audio' } })
    }
    if (path === '/v2/ost/pro_create') {
      calls.create += 1
      calls.bodies.push(JSON.parse(init.body))
      if (createError) return json(createError)
      return json({ code: 0, data: { task_id: 'task-1' } })
    }
    if (path === '/v2/ost/query') {
      calls.query += 1
      queries += 1
      if (queries <= notFoundFirst) return json({ code: 10401, message: 'no data found' })
      if (queries - notFoundFirst < queriesUntilDone) return json({ code: 0, data: { task_status: '2' } })
      return json(result)
    }
    return json({ code: 404, message: `unexpected ${path}` })
  }
  return { fetchImpl, calls }
}

async function setup(fake = fakeOst()) {
  const made = await makeEnv()
  const file = join(made.cwd, '录音 1.wav')
  await writeFile(file, Buffer.alloc(3200))
  // 没有 ffmpeg 的路径：wav 直接上传，测试不依赖本机环境
  const env = made.env
  const deps = { env, fetchImpl: fake.fetchImpl, findFfmpeg: async () => null, sleep: async () => {}, waitMs: 60_000 }
  return { ...made, env, file, fake, deps }
}

test('解析真实返回：时间换算成整段音频的毫秒，分段标记不算文字', () => {
  const { segments, durationMs, speakers } = parseOstResult(REAL)
  assert.equal(segments.length, 2)
  assert.equal(durationMs, 22340, 'file_length 是字节数，不能当时长')
  assert.deepEqual(speakers, [])
  assert.equal(segments[0].speaker, null)
  assert.match(segments[0].text, /^欢迎收听今天的节目，/)
  const first = segments[0].words[0]
  assert.deepEqual([first.text, first.startMs, first.endMs], ['欢迎', 40, 410])
  assert.ok(segments[0].words.some((w) => w.punct))
  assert.ok(!segments.flatMap((s) => s.words).some((w) => w.text === ''))
})

test('解析：说话人按出现顺序命名，没开分离时不显示；json_1best 是字符串也能读', () => {
  const st = (rl, w, bg) => JSON.stringify({ st: { bg: String(bg), ed: String(bg + 500), rl, rt: [{ ws: [{ wb: 1, we: 40, cw: [{ w, wp: 'n' }] }] }] } })
  const raw = { data: { result: { lattice: [{ json_1best: st('2', '你好', 0) }, { json_1best: st('1', '再见', 500) }, { json_1best: st('2', '好的', 1000) }] } } }
  const on = parseOstResult(raw, { speakers: true })
  assert.deepEqual(on.segments.map((s) => s.speaker), ['说话人1', '说话人2', '说话人1'])
  assert.deepEqual(on.speakers, ['说话人1', '说话人2'])
  assert.equal(parseOstResult(raw).segments[0].speaker, null)
  assert.match(toPlainText(on.segments, { speakers: true }), /\[00:00\] 说话人1：\n你好\n\n\[00:00\] 说话人2：\n再见/)
})

test('字幕：真实结果切成短条，时间递增，不丢字', () => {
  const { segments } = parseOstResult(REAL)
  const cues = segmentsToCues(segments)
  assert.ok(cues.length >= 5)
  cues.forEach((c, i) => {
    assert.ok(c.endMs > c.startMs, `第 ${i} 条时间不对`)
    if (i) assert.ok(c.startMs >= cues[i - 1].endMs, `第 ${i} 条重叠`)
    assert.ok([...c.text].length <= 22, `第 ${i} 条太长：${c.text}`)
  })
  const strip = (t) => t.replace(/[^\p{L}\p{N}]/gu, '')
  assert.equal(cues.map((c) => strip(c.text)).join(''), strip(segments.map((s) => s.text).join('')))
})

test('字幕：标了说话人时，换人才加前缀', () => {
  const word = (text, startMs) => ({ text, startMs, endMs: startMs + 400, punct: false })
  const seg = (speaker, text, startMs) => ({ speaker, startMs, endMs: startMs + 400, text, words: [word(text, startMs)] })
  const cues = segmentsToCues([seg('说话人1', '你好', 0), seg('说话人1', '在吗', 1000), seg('说话人2', '在的', 2000)], { speakers: true })
  assert.deepEqual(cues.map((c) => c.text), ['说话人1：你好', '在吗', '说话人2：在的'])
})

test('完整流程：上传、建任务、查结果，导出四种文件', async () => {
  const { file, cwd, deps, fake } = await setup(fakeOst({ queriesUntilDone: 3 }))
  const r = await transcribe({ file, cwd }, deps)
  assert.equal(r.status, 'done')
  assert.equal(fake.calls.upload, 1)
  assert.equal(fake.calls.create, 1)
  assert.equal(fake.calls.query, 3)
  assert.equal(r.cached, false)
  assert.equal(r.durationMs, 22340)
  assert.ok(r.files.txt.startsWith(join(cwd, 'voice-output', '录音-1-转写')))
  for (const f of Object.values(r.files)) assert.ok((await stat(f)).size > 10)
  assert.match(await readFile(r.files.srt, 'utf8'), /^1\n00:00:00,040 --> /)
  assert.match(await readFile(r.files.vtt, 'utf8'), /^WEBVTT/)
  assert.match(await readFile(r.files.txt, 'utf8'), /欢迎收听/)
  const body = fake.calls.bodies[0]
  assert.equal(body.business.domain, 'pro_ost_ed')
  assert.equal(body.data.encoding, 'raw')
  assert.equal(body.business.vspp_on, undefined)
})

test('同一个文件不重复扣费：有结果直接用，选项不同才算新任务', async () => {
  const { file, cwd, deps, fake } = await setup()
  await transcribe({ file, cwd }, deps)
  const again = await transcribe({ file, cwd }, deps)
  assert.equal(again.cached, true)
  assert.equal(fake.calls.create, 1)
  assert.equal(fake.calls.upload, 1)
  assert.equal((await planTranscribe({ file, cwd }, deps)).paid, true)
  assert.equal((await planTranscribe({ file, cwd, hotwords: ['讯飞'] }, deps)).paid, false)
  await transcribe({ file, cwd, hotwords: ['讯飞', 'API'] }, deps)
  assert.equal(fake.calls.create, 2)
  assert.equal(fake.calls.bodies[1].business.dhw, 'API,讯飞')
  await writeFile(file, Buffer.alloc(6400))
  assert.equal((await planTranscribe({ file, cwd }, deps)).paid, false, '文件内容变了算新任务')
})

test('等太久返回 running，再调一次接着等，不重新提交', async () => {
  const fake = fakeOst({ queriesUntilDone: 4 })
  const { file, cwd, deps } = await setup(fake)
  let clock = 0
  const limited = { ...deps, waitMs: 0, now: () => (clock += 1) }
  const first = await transcribe({ file, cwd }, limited)
  assert.equal(first.status, 'running')
  assert.equal(first.taskId, 'task-1')
  assert.equal(fake.calls.create, 1)
  const resumed = await transcribe({ file, cwd }, { ...deps, now: () => (clock += 1) })
  assert.equal(resumed.status, 'done')
  assert.equal(resumed.resumed, true)
  assert.equal(fake.calls.create, 1, '没有重新建任务')
  assert.equal(fake.calls.upload, 1, '没有重新上传')
})

test('任务超过讯飞 7 天的保留期就重新提交', async () => {
  const fake = fakeOst({ queriesUntilDone: 99 })
  const { file, cwd, deps } = await setup(fake)
  let clock = 1000
  await transcribe({ file, cwd }, { ...deps, waitMs: 0, now: () => clock })
  clock += 8 * 24 * 3600 * 1000
  await transcribe({ file, cwd }, { ...deps, waitMs: 0, now: () => clock })
  assert.equal(fake.calls.create, 2)
})

test('进程中断后能恢复：任务号在等结果之前就落盘了', async () => {
  const { file, cwd, deps, fake, env } = await setup()
  const crash = { ...deps, fetchImpl: async (url, init) => {
    if (new URL(url).pathname === '/v2/ost/query') throw new TypeError('fetch failed')
    return fake.fetchImpl(url, init)
  } }
  await assert.rejects(transcribe({ file, cwd }, crash), (e) => e.kind === 'network')
  const plan = await planTranscribe({ file, cwd }, { env })
  assert.equal(plan.paid, true)
  const r = await transcribe({ file, cwd }, deps)
  assert.equal(r.status, 'done')
  assert.equal(fake.calls.create, 1)
})

test('刚建好就查到 10401 不算失败；一直查不到才报告，并说明重来要花钱', async () => {
  const ok = await setup(fakeOst({ notFoundFirst: 3 }))
  assert.equal((await transcribe({ file: ok.file, cwd: ok.cwd }, ok.deps)).status, 'done')

  const lost = await setup(fakeOst({ notFoundFirst: 99 }))
  await assert.rejects(transcribe({ file: lost.file, cwd: lost.cwd }, lost.deps), (e) => e.kind === 'lost' && /问用户/.test(e.hint))
  assert.equal(lost.fake.calls.query, 9)
  await transcribe({ file: lost.file, cwd: lost.cwd }, { ...lost.deps, fetchImpl: fakeOst().fetchImpl })
})

test('并行调用同一个文件只提交一次', async () => {
  const { file, cwd, deps, fake } = await setup()
  const [a, b] = await Promise.all([transcribe({ file, cwd }, deps), transcribe({ file, cwd }, deps)])
  assert.equal(a.status, 'done')
  assert.equal(b.status, 'done')
  assert.equal(fake.calls.create, 1)
})

test('记录用量：转写次数和合成字数分开，重复调用不再计', async () => {
  const { file, cwd, deps } = await setup()
  await transcribe({ file, cwd }, deps)
  await transcribe({ file, cwd }, deps)
  const today = Object.values(getState().usage)[0]
  assert.equal(today.listens, 1)
  assert.equal(today.chars, 0)
})

test('没有 ffmpeg：视频、其他格式、mp3 分离说话人都说清楚要装什么，不花钱', async () => {
  const { cwd, deps, fake } = await setup()
  for (const [name, options, pattern] of [
    ['a.mp4', {}, /ffmpeg/],
    ['a.m4a', {}, /ffmpeg/],
    ['a.mp3', { speakers: true }, /不支持 mp3/],
  ]) {
    const file = join(cwd, name)
    await writeFile(file, Buffer.alloc(100))
    await assert.rejects(transcribe({ file, cwd, ...options }, deps), pattern)
  }
  assert.equal(fake.calls.upload, 0)
})

test('有 ffmpeg：抽音轨转成 16k 单声道，说话人分离用 wav，时长读得出，超长先问的依据可靠', async (t) => {
  const bin = await findFfmpeg()
  if (!bin) return t.skip('本机没有 ffmpeg')
  const made = await makeEnv()
  const file = join(made.cwd, 'clip.mp4')
  const made4 = spawnSync(bin, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=2', '-shortest', '-c:a', 'aac', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file])
  if (made4.status !== 0) return t.skip('本机的 ffmpeg 生成不了测试视频')
  const fake = fakeOst()
  const uploaded = []
  const deps = { env: made.env, sleep: async () => {}, fetchImpl: async (url, init) => {
    if (new URL(url).pathname === '/file/upload') uploaded.push(Buffer.from(init.body))
    return fake.fetchImpl(url, init)
  } }
  const plan = await planTranscribe({ file, cwd: made.cwd }, deps)
  assert.ok(Math.abs(plan.durationMs - 2000) < 200, `时长 ${plan.durationMs}`)
  const done = await transcribe({ file, cwd: made.cwd }, deps)
  assert.ok(Math.abs(done.durationMs - 2000) < 200, `应该用 ffmpeg 读到的时长，实际 ${done.durationMs}`)
  assert.equal(fake.calls.bodies[0].data.encoding, 'lame')
  assert.ok(fake.calls.bodies[0].business.duration >= 2)
  assert.match(uploaded[0].toString('latin1'), /filename="audio\.mp3"/)
  await transcribe({ file, cwd: made.cwd, speakers: true, speakerCount: 2 }, deps)
  const body = fake.calls.bodies[1]
  assert.equal(body.data.encoding, 'raw')
  assert.equal(body.business.vspp_on, 1)
  assert.equal(body.business.speaker_num, 2)
  assert.match(uploaded[1].toString('latin1'), /filename="audio\.wav"/)
  // 16k 单声道 16 位：约 2 秒 ≈ 64000 字节
  assert.ok(uploaded[1].length > 60000 && uploaded[1].length < 80000, `wav ${uploaded[1].length}`)
})

test('文件提取不出音频时说清楚，不花钱', async (t) => {
  const bin = await findFfmpeg()
  if (!bin) return t.skip('本机没有 ffmpeg')
  const made = await makeEnv()
  const file = join(made.cwd, 'broken.mp4')
  await writeFile(file, 'not a video')
  const fake = fakeOst()
  await assert.rejects(transcribe({ file, cwd: made.cwd }, { env: made.env, fetchImpl: fake.fetchImpl }), (e) => e.kind === 'audio')
  assert.equal(fake.calls.upload, 0)
})

test('参数错误不发请求：没有文件、读不到、网址、不认识的领域', async () => {
  const { cwd, file, deps, fake } = await setup()
  await assert.rejects(transcribe({ cwd }, deps), /缺少文件/)
  await assert.rejects(transcribe({ file: join(cwd, 'none.wav'), cwd }, deps), /读不到文件/)
  await assert.rejects(transcribe({ file: 'https://a/b.mp3', cwd }, deps), /网址/)
  await assert.rejects(transcribe({ file, cwd, domain: 'space' }, deps), /领域/)
  assert.equal(fake.calls.upload, 0)
})

test('没有凭据不发请求', async () => {
  const made = await makeEnv({ credentials: false })
  const file = join(made.cwd, 'a.wav')
  await writeFile(file, Buffer.alloc(100))
  const fake = fakeOst()
  await assert.rejects(transcribe({ file, cwd: made.cwd }, { env: made.env, findFfmpeg: async () => null, fetchImpl: fake.fetchImpl }), (e) => e.kind === 'credentials')
  assert.equal(fake.calls.upload, 0)
})

test('错误翻译：服务没开、签名、时钟、静音都给出下一步', async () => {
  assert.equal(explainOst(new OstError(11200, 'licc failed')).kind, 'service')
  assert.match(explainOst(new OstError(11200, 'licc failed')).hint, /services\/ost/)
  assert.equal(explainOst(new OstError('http-401', 'HMAC signature does not match', { status: 401 })).kind, 'credentials')
  assert.equal(explainOst(new OstError('http-403', 'clock skew', { status: 403 })).kind, 'clock')
  assert.equal(explainOst(new OstError(20304, 'silence')).kind, 'audio')
  const { file, cwd, deps } = await setup(fakeOst({ createError: { code: 11200, message: 'licc failed' } }))
  await assert.rejects(transcribe({ file, cwd }, deps), (e) => e.kind === 'service')
})

test('签名：digest 和 authorization 都按文档的格式', () => {
  const h = signHeaders({ host: 'a.example', path: '/x', body: 'hello', contentType: 'application/json' }, { apiKey: 'k', apiSecret: 's' }, 'Thu, 01 Jan 2026 00:00:00 GMT')
  assert.equal(h.digest, 'SHA-256=LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=')
  assert.match(h.authorization, /^api_key="k", algorithm="hmac-sha256", headers="host date request-line digest", signature="[^"]+="$/)
})

test('大文件走分块上传：顺序、分块号、完成后拿到地址', async () => {
  const paths = []
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname
    const slice = path.endsWith('/upload') ? Buffer.from(init.body).toString('latin1').match(/name="slice_id"\r\n\r\n(\d+)/)?.[1] : null
    paths.push(slice ? `${path}#${slice}` : path)
    const data = path.endsWith('/init') ? { upload_id: 'u1' } : path.endsWith('/complete') ? { url: 'https://x/big' } : {}
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data }) }
  }
  const size = 45 * 1024 * 1024
  const read = async (start, end) => Buffer.alloc(end - start)
  const url = await uploadAudio({ size, name: 'a.mp3', read }, { creds: { appId: 'a', apiKey: 'k', apiSecret: 's' }, fetchImpl })
  assert.equal(url, 'https://x/big')
  assert.deepEqual(paths, ['/file/mpupload/init', '/file/mpupload/upload#1', '/file/mpupload/upload#2', '/file/mpupload/upload#3', '/file/mpupload/complete'])
})

test('从 ffmpeg 的输出读时长', () => {
  assert.equal(parseFfmpegDuration('  Duration: 01:02:03.50, start: 0'), 3723500)
  assert.equal(parseFfmpegDuration('Duration: N/A'), null)
})

test('回听：逐字找出漏读和多读，忽略标点、大小写和标注', () => {
  assert.deepEqual(diffText('调[=diao4]用量，翻了 API！', '调用量翻了api'), { missing: [], extra: [] })
  assert.deepEqual(diffText('今天天气真好', '今天真好'), { missing: ['天气'], extra: [] })
  assert.deepEqual(diffText('今天真好', '今天天气真好'), { missing: [], extra: ['天气'] })
})

test('回听：按时间把听到的词分给每一句，只报告不一致的句子', () => {
  const sentences = [
    { id: 's1', text: '第一句话。', startMs: 0, endMs: 1000 },
    { id: 's2', text: '今年是2024年。', startMs: 1000, endMs: 2000 },
  ]
  const word = (text, startMs) => ({ text, startMs, endMs: startMs + 100, punct: false })
  const same = [{ words: [word('第一', 100), word('句话', 300), word('今年是2024年', 1200)] }]
  assert.deepEqual(compareToScript(sentences, same), [])
  const wrong = [{ words: [word('第一', 100), word('今年是二零二四年', 1200)] }]
  const diffs = compareToScript(sentences, wrong)
  assert.deepEqual(diffs.map((d) => d.id), ['s1', 's2'])
  assert.deepEqual(diffs[0].missing, ['句话'])
  assert.equal(diffs[1].hasNumbers, true)
})

async function toolkit({ fake = fakeOst(), approval } = {}) {
  const made = await setup(fake)
  const defs = await buildToolDefinitions({ get: () => approval }, { env: made.env, synth: fakeSynth(), fetchImpl: fake.fetchImpl, findFfmpeg: async () => null, sleep: async () => {} })
  const byName = Object.fromEntries(defs.map((d) => [d.name, d]))
  const exec = { agent: { session: { id: 's1', header: { cwd: made.cwd } } }, callId: 'c1', signal: new AbortController().signal }
  const run = async (name, args) => {
    const value = await byName[name].execute(args, exec)
    return { value, text: byName[name].output.render(args, value)[0].text }
  }
  return { ...made, run }
}

test('voice_listen：给模型摘要和路径，文件不存在时失败不抛异常', async () => {
  const { run, file, fake } = await toolkit()
  const r = await run('voice_listen', { file: '录音 1.wav' })
  assert.equal(r.value.status, 'done')
  assert.match(r.text, /转写完成/)
  assert.match(r.text, /txt：.*录音-1\.txt/)
  assert.match(r.text, /欢迎收听/)
  const again = await run('voice_listen', { file })
  assert.match(again.text, /已有结果，未扣费/)
  assert.equal(fake.calls.create, 1)
  const missing = await run('voice_listen', { file: '没有.wav' })
  assert.equal(missing.value.ok, false)
  assert.match(missing.text, /读不到文件/)
})

test('voice_listen：长文稿不全塞给模型', async () => {
  const words = Array.from({ length: 4000 }, (_, i) => ({ wb: i, we: i + 1, cw: [{ w: '字', wp: 'n' }] }))
  const result = { code: 0, data: { task_status: '3', result: { file_length: 40000, lattice: [{ json_1best: { st: { bg: '0', ed: '40000', rl: '0', rt: [{ ws: words }] } } }] } } }
  const { run } = await toolkit({ fake: fakeOst({ result }) })
  const r = await run('voice_listen', { file: '录音 1.wav' })
  assert.equal(r.value.chars, 4000)
  assert.equal(r.value.truncated, true)
  assert.ok(r.text.length < 2500, `给模型 ${r.text.length} 字`)
  assert.match(r.text, /完整文稿读/)
})

test('转写太大先问：拒绝就不上传，同意才转', async () => {
  const rejected = await toolkit({ approval: { request: async () => 'rejected' } })
  await truncate(rejected.file, 201 * 1024 * 1024)
  const no = await rejected.run('voice_listen', { file: rejected.file })
  assert.equal(no.value.kind, 'rejected')
  assert.equal(rejected.fake.calls.upload, 0)
})

test('voice_scene 能直接跑 S14；手册都在', async () => {
  const { run } = await toolkit()
  const r = await run('voice_scene', { action: 'run', id: 'S14', file: '录音 1.wav' })
  assert.match(r.text, /转写完成/)
  for (const id of ['S14', 'S15', 'S16', 'S17', 'S18', 'S19', 'S20']) {
    const got = await run('voice_scene', { action: 'get', id })
    assert.equal(got.value.scene.status, 'available')
    assert.ok(got.value.scene.playbookText.length > 50, id)
  }
})

test('voice_project relisten：一致就通过；读错了指出哪一句；没导出过先导出', async () => {
  const sentence = (id, text, bg) => ({ begin: String(bg), end: String(bg + 1000), json_1best: { st: { bg: String(bg), ed: String(bg + 1000), rl: '0', rt: [{ ws: [{ wb: 1, we: 40, cw: [{ w: text, wp: 'n' }] }] }] } } })
  const heard = (texts) => ({ code: 0, data: { task_status: '3', result: { file_length: 3000, lattice: texts.map((t, i) => sentence(i, t, i * 1400 + 500)) } } })

  const good = await toolkit({ fake: fakeOst({ result: heard(['第一句话', '第二句话']) }) })
  await good.run('voice_project', { action: 'create', name: 'p', sentences: ['第一句话。', '第二句话。'], vcn: 'x5_lingxiaoxuan_flow' })
  const before = await good.run('voice_project', { action: 'relisten', name: 'p' })
  assert.equal(before.value.ok, false)
  assert.match(before.text, /还没有导出/)
  await good.run('voice_project', { action: 'build', name: 'p', audioFormat: 'wav' })
  const pass = await good.run('voice_project', { action: 'relisten', name: 'p' })
  assert.match(pass.text, /回听通过：2 句/)
  assert.match(pass.text, /同字异音/)

  const bad = await toolkit({ fake: fakeOst({ result: heard(['第一句话', '第句']) }) })
  await bad.run('voice_project', { action: 'create', name: 'p', sentences: ['第一句话。', '第二句话。'], vcn: 'x5_lingxiaoxuan_flow' })
  await bad.run('voice_project', { action: 'build', name: 'p', audioFormat: 'wav' })
  const fail = await bad.run('voice_project', { action: 'relisten', name: 'p' })
  assert.deepEqual(fail.value.differences.map((d) => d.id), ['s2'])
  assert.match(fail.text, /原稿有而没听到：二、话/)
})

test('/voice-listen：短文件直接转；路径带空格；不知道时长先出提示，加 --yes 才转', async () => {
  const { file, cwd, env, fake } = await setup()
  const commands = {}
  registerCommands({ commands: { register: (d) => { commands[d.name] = d; return () => {} } } }, { env, fetchImpl: fake.fetchImpl, findFfmpeg: async () => null, sleep: async () => {} })
  assert.ok(commands['voice-listen'].input)
  const invocation = (rawInput) => ({ rawInput, agent: { session: { id: 's1', header: { cwd } } } })
  const plan = await commands['voice-listen'].handler(invocation('录音 1.wav'))
  assert.match(plan.text, /--yes/)
  assert.equal(fake.calls.upload, 0)
  const done = await commands['voice-listen'].handler(invocation('录音 1.wav --yes'))
  assert.equal(done.kind, 'success')
  assert.match(done.text, /转写完成|Done/)
  assert.ok(done.text.includes(join(cwd, 'voice-output')))
  const again = await commands['voice-listen'].handler(invocation(`"${file}"`))
  assert.match(again.text, /未扣费|not charged/)
  assert.equal(fake.calls.create, 1)
  assert.equal((await commands['voice-listen'].handler(invocation(''))).kind, 'error')
})
