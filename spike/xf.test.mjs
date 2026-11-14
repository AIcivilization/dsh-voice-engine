// spike/xf.test.mjs — 不联网的测试：node --test spike/xf.test.mjs

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import {
  connection, credentialProblem, diffText, hyperSynth, parseRhy, waitTranscribe, parseTranscript, pcmDurationMs, signHttpHeaders, signWsUrl,
  silenceEdgesMs, splitSentences, v2Synth, wavFromPcm,
} from './xf.mjs'

const creds = { appId: 'app', apiKey: 'test-key', apiSecret: 'test-secret' }
const DATE = 'Tue, 03 Nov 2026 10:00:00 GMT'

/** 用 Python 按官方脚本的公式独立算一遍，防止 JS 实现和测试犯同一个错 */
function python(code) {
  const r = spawnSync('python3', ['-I', '-c', code], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}

test('WebSocket 签名和官方公式一致', () => {
  const url = new URL(signWsUrl('wss://cbm01.cn-huabei-1.xf-yun.com/v1/private/mcd9m97e6', creds, DATE))
  const expected = python(`
import base64,hashlib,hmac
s=hmac.new(b"test-secret",b"host: cbm01.cn-huabei-1.xf-yun.com\\ndate: ${DATE}\\nGET /v1/private/mcd9m97e6 HTTP/1.1",hashlib.sha256).digest()
o='api_key="test-key", algorithm="hmac-sha256", headers="host date request-line", signature="'+base64.b64encode(s).decode()+'"'
print(base64.b64encode(o.encode()).decode())`)
  assert.equal(url.searchParams.get('authorization'), expected)
  assert.equal(url.searchParams.get('date'), DATE)
  assert.equal(url.searchParams.get('host'), 'cbm01.cn-huabei-1.xf-yun.com')
})

test('HTTP 签名和官方公式一致', () => {
  const body = '{"a":"中文"}'
  const h = signHttpHeaders({ host: 'ost-api.xfyun.cn', path: '/v2/ost/query', body, contentType: 'application/json' }, creds, DATE)
  const expected = python(`
import base64,hashlib,hmac
body='{"a":"\\u4e2d\\u6587"}'.encode()
d="SHA-256="+base64.b64encode(hashlib.sha256(body).digest()).decode()
s=hmac.new(b"test-secret",("host: ost-api.xfyun.cn\\ndate: ${DATE}\\nPOST /v2/ost/query HTTP/1.1\\ndigest: "+d).encode(),hashlib.sha256).digest()
print(d)
print('api_key="test-key", algorithm="hmac-sha256", headers="host date request-line digest", signature="'+base64.b64encode(s).decode()+'"')`).split('\n')
  assert.equal(h.digest, expected[0])
  assert.equal(h.authorization, expected[1])
})

test('凭据校验能认出填错位置，且提示里不带凭据内容', () => {
  const email = credentialProblem({ appId: 'someone@example.com', apiKey: 'ak-abc' })
  assert.match(email, /AppID 填错/)
  assert.ok(!email.includes('someone'))
  assert.match(credentialProblem({ appId: 'abc123', apiKey: 'k', apiSecret: 'https://x.example' }), /APISecret 填错/)
  assert.match(credentialProblem({ appId: 'abc123', apiKey: 'k' }), /缺少 APISecret/)
  assert.equal(credentialProblem({ appId: 'abc123', apiKey: 'ak-abc' }), null)
  assert.equal(credentialProblem({ appId: 'abc123', apiKey: 'k', apiSecret: 's' }), null)
})

test('ak- 密钥走请求头，地址不带签名；其余走签名', () => {
  const byKey = connection('wss://tts-api.xfyun.cn/v2/tts', { appId: 'a', apiKey: 'ak-abc' })
  assert.equal(byKey.url, 'wss://tts-api.xfyun.cn/v2/tts')
  assert.deepEqual(byKey.headers, { 'x-api-key': 'ak-abc' })
  const signed = connection('wss://tts-api.xfyun.cn/v2/tts', creds)
  assert.equal(signed.headers, undefined)
  assert.ok(new URL(signed.url).searchParams.has('authorization'))
})

test('解析文档里的拼音标注示例', () => {
  const p = parseRhy('sil:6;欢[=huan1]-h1:16;@-uan1:24;')
  assert.equal(p.units.length, 1)
  assert.equal(p.units[0].text, '欢')
  assert.equal(p.units[0].pinyin, 'huan1')
  assert.equal(p.units[0].startMs, 30)
  assert.equal(p.units[0].endMs, 230)
  assert.deepEqual(p.pauses[0], { kind: 'sil', startMs: 0, endMs: 30 })
  assert.deepEqual(p.unparsed, [])
  assert.equal(p.totalMs, 230)
})

test('解析真实返回：* 贴在拼音后面，{0:6} 不计入时长', () => {
  // x6_lingfeichen_pro 合成「你好」的真实返回，音频 1120ms
  const pro = parseRhy('sil:24;你[=ni2]-n2:8;@-i2:16;好[=hao3]*-h3:24;@-ao3:36;sil:116;')
  assert.deepEqual(pro.units.map((u) => [u.text, u.pinyin]), [['你', 'ni2'], ['好', 'hao3']])
  assert.equal(pro.boundaries, 1)
  assert.deepEqual(pro.unparsed, [])
  assert.equal(pro.totalMs, 1120)
  // x5_lingxiaoxuan_flow 的真实返回，音频 1160ms
  const flow = parseRhy('sil:12;你[=ni2]-n2:12;@-i2:12;好[=hao3]*-h3:24;@-ao3:40;{0:6}sil:132;{0:6}')
  assert.deepEqual(flow.unparsed, [])
  assert.equal(flow.totalMs, 1160)
})

test('真实返回：英文连写和句中停顿', () => {
  const en = parseRhy('sil:16;CEO*-s:32;@-iy:44;@*-iy:16;{0:38}@*-ow:36;说[=shuo1]-sh1:28;@-uo1:48;')
  assert.deepEqual(en.units.map((u) => u.text), ['CEO', '说'])
  assert.equal(en.units[0].phonemes.length, 4)
  assert.equal(en.units[0].endMs, (16 + 32 + 44 + 16 + 36) * 5)
  assert.deepEqual(en.unparsed, [])

  const sp = parseRhy('五[=wu3]*-u3:52;{0:63}@-sp3:68;电[=dian4]-d4:12;')
  assert.equal(sp.units[0].endMs, 260, '停顿不算进「五」的发音')
  assert.deepEqual(sp.pauses, [{ kind: 'sp', startMs: 260, endMs: 600 }])
  assert.equal(sp.units[1].startMs, 600)
})

test('韵律符号、停顿、保留字段不影响时间累加', () => {
  const p = parseRhy('sil:2;你[=ni3]-n3:10;@-i3:10;*;sp:4;{x}好[=hao3]-h3:10;@-ao3:10;sil:2')
  assert.deepEqual(p.units.map((u) => u.text), ['你', '好'])
  assert.equal(p.boundaries, 1)
  assert.equal(p.units[1].startMs, (2 + 20 + 4) * 5)
  assert.equal(p.frames, 48)
})

test('不认识的片段不会被丢掉，时长仍然计入', () => {
  const p = parseRhy('sil:2;怪东西:10;好[=hao3]-h3:10;完全看不懂')
  assert.deepEqual(p.unparsed, ['怪东西:10', '完全看不懂'])
  assert.equal(p.units[0].startMs, 60)
})

/** 假 WebSocket：连上后按顺序推送准备好的帧 */
function fakeSocket(frames, { failOnOpen = false } = {}) {
  return class {
    constructor(url) {
      this.url = url
      fakeSocket.lastUrl = url
      queueMicrotask(() => {
        if (failOnOpen) return this.onerror?.({})
        this.onopen?.()
      })
    }
    send(body) {
      fakeSocket.lastRequest = JSON.parse(body)
      for (const frame of frames) this.onmessage?.({ data: JSON.stringify(frame) })
    }
    close() {}
  }
}

const b64 = (data) => Buffer.from(data).toString('base64')

test('超拟人：汉字跨帧切开也能解码，音频结束后到的 pybuf 不会丢', async () => {
  const rhy = Buffer.from('sil:2;欢[=huan1]-h1:16;@-uan1:24;')
  const pcm = Buffer.alloc(4800)
  const cut = rhy.indexOf(Buffer.from('欢')) + 1 // 切在「欢」字的字节中间
  const frames = [
    { header: { code: 0, sid: 's1', status: 1 }, payload: { audio: { audio: b64(pcm), status: 2 }, pybuf: { text: b64(rhy.subarray(0, cut)), status: 1 } } },
    { header: { code: 0, status: 2 }, payload: { pybuf: { text: b64(rhy.subarray(cut)), status: 2 } } },
  ]
  const r = await hyperSynth('欢', { creds, WebSocketImpl: fakeSocket(frames) })
  assert.equal(r.rhyText, rhy.toString())
  assert.equal(r.durationMs, 100)
  assert.equal(r.sid, 's1')
  assert.equal(fakeSocket.lastRequest.parameter.tts.rhy, 1)
  assert.equal(fakeSocket.lastRequest.parameter.tts.audio.encoding, 'raw')
  assert.equal(Buffer.from(fakeSocket.lastRequest.payload.text.text, 'base64').toString(), '欢')
})

test('超拟人：错误码原样抛出，报错里不带密钥和签名', async () => {
  const frames = [{ header: { code: 11200, message: 'licc limit', sid: 's2' } }]
  await assert.rejects(hyperSynth('你好', { creds, WebSocketImpl: fakeSocket(frames) }), (error) => {
    assert.equal(error.code, 11200)
    assert.ok(!error.message.includes('test-key') && !error.message.includes('authorization'))
    return true
  })
})

test('连接失败给出可读的错误', async () => {
  await assert.rejects(hyperSynth('你好', { creds, WebSocketImpl: fakeSocket([], { failOnOpen: true }) }), /连接失败/)
})

test('v2：按 data.status 结束，请求用 UTF8 和 16k PCM', async () => {
  const pcm = Buffer.alloc(32000)
  const frames = [{ code: 0, sid: 'v', data: { audio: b64(pcm), status: 2 } }]
  const r = await v2Synth('你好', { creds, WebSocketImpl: fakeSocket(frames) })
  assert.equal(r.durationMs, 1000)
  assert.equal(fakeSocket.lastRequest.business.tte, 'UTF8')
  assert.equal(fakeSocket.lastRequest.business.auf, 'audio/L16;rate=16000')
})

test('PCM 时长、WAV 文件头', () => {
  assert.equal(pcmDurationMs(Buffer.alloc(48000), 24000), 1000)
  const wav = wavFromPcm(Buffer.alloc(100), 24000)
  assert.equal(wav.length, 144)
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(wav.readUInt32LE(24), 24000)
  assert.equal(wav.readUInt32LE(40), 100)
})

test('首尾静音测量', () => {
  const sampleRate = 1000
  const pcm = Buffer.alloc(2000) // 1 秒
  for (let i = 100; i < 800; i += 1) pcm.writeInt16LE(5000, i * 2)
  const { headMs, tailMs } = silenceEdgesMs(pcm, sampleRate)
  assert.equal(headMs, 100)
  assert.equal(tailMs, 200)
  assert.equal(silenceEdgesMs(Buffer.alloc(2000), sampleRate).headMs, 1000)
})

test('切句保留标点，分号也切', () => {
  assert.deepEqual(splitSentences('你好。今天天气好！过去如此；现在呢？'), ['你好。', '今天天气好！', '过去如此；', '现在呢？'])
  assert.deepEqual(splitSentences(''), [])
})

test('回听比较能发现漏读和多读，忽略标点差异', () => {
  assert.equal(diffText('你好，世界。', '你好世界').similarity, 1)
  const missed = diffText('今天天气很好我们出去玩', '今天天气很好')
  assert.deepEqual(missed.missing, ['我们出去玩'])
  assert.deepEqual(missed.extra, [])
  const extra = diffText('今天天气', '今天天气真不错')
  assert.deepEqual(extra.extra, ['真不错'])
  const replaced = diffText('重庆很美', '重轻很美')
  assert.deepEqual(replaced.missing, ['庆'])
  assert.deepEqual(replaced.extra, ['轻'])
})

test('转写查询：刚创建时的 10401 会重试，一直 10401 才报错', async () => {
  const reply = (body) => new Response(JSON.stringify(body))
  const sequence = [{ code: 10401, message: 'no data found' }, { code: 0, data: { task_status: '2' } }, { code: 0, data: { task_status: '4' } }]
  let calls = 0
  const result = await waitTranscribe('t', { creds, intervalMs: 0, fetchImpl: async () => reply(sequence[calls++]) })
  assert.equal(result.data.task_status, '4')
  assert.equal(calls, 3)

  let forever = 0
  await assert.rejects(
    waitTranscribe('t', { creds, intervalMs: 0, fetchImpl: async () => { forever += 1; return reply({ code: 10401, message: 'no data found' }) } }),
    (error) => error.code === 10401,
  )
  assert.equal(forever, 6)
})

test('转写解析：取文字，跳过分段标记，报告词级字段', () => {
  const result = { data: { result: { lattice: [{ begin: '0', end: '900', json_1best: { st: { rt: [{ ws: [
    { wb: 1, we: 40, cw: [{ w: '你好', wp: 'n' }] },
    { wb: 41, we: 41, cw: [{ w: '', wp: 'g' }] },
  ] }] } } }] } } }
  const t = parseTranscript(result)
  assert.equal(t.text, '你好')
  assert.equal(t.words.length, 1)
  assert.ok(t.wordFields.includes('wb'))
  assert.equal(t.segments[0].end, '900')
})
