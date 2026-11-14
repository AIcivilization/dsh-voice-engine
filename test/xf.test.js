import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { signWsUrl } from '../lib/xf/auth.js'
import { explainCode, explainHandshake } from '../lib/xf/errors.js'
import { inlineReadings, parseRhy, speechSpan } from '../lib/xf/rhy.js'
import { handshakeMessage, hyperSynth, v2Synth, XfError, ConnectError } from '../lib/xf/tts.js'

const creds = { appId: 'app', apiKey: 'test-key', apiSecret: 'test-secret' }
const DATE = 'Tue, 03 Nov 2026 10:00:00 GMT'

test('签名和官方公式一致（用 Python 独立算一遍）', () => {
  const url = new URL(signWsUrl('wss://cbm01.cn-huabei-1.xf-yun.com/v1/private/mcd9m97e6', creds, DATE))
  const code = `
import base64,hashlib,hmac
s=hmac.new(b"test-secret",b"host: cbm01.cn-huabei-1.xf-yun.com\\ndate: ${DATE}\\nGET /v1/private/mcd9m97e6 HTTP/1.1",hashlib.sha256).digest()
o='api_key="test-key", algorithm="hmac-sha256", headers="host date request-line", signature="'+base64.b64encode(s).decode()+'"'
print(base64.b64encode(o.encode()).decode())`
  const r = spawnSync('python3', ['-I', '-c', code], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(url.searchParams.get('authorization'), r.stdout.trim())
})

test('解析真实返回：* 贴在拼音后，{0:6} 不计时长，和音频时长一致', () => {
  const p = parseRhy('sil:24;你[=ni2]-n2:8;@-i2:16;好[=hao3]*-h3:24;@-ao3:36;sil:116;')
  assert.deepEqual(p.units.map((u) => [u.text, u.pinyin]), [['你', 'ni2'], ['好', 'hao3']])
  assert.equal(p.totalMs, 1120)
  assert.deepEqual(p.unparsed, [])
  assert.equal(parseRhy('sil:12;你[=ni2]-n2:12;@-i2:12;好[=hao3]*-h3:24;@-ao3:40;{0:6}sil:132;{0:6}').totalMs, 1160)
})

test('解析真实返回：英文连写，句中停顿不算发音', () => {
  const en = parseRhy('sil:16;CEO*-s:32;@-iy:44;@*-iy:16;{0:38}@*-ow:36;说[=shuo1]-sh1:28;@-uo1:48;')
  assert.deepEqual(en.units.map((u) => u.text), ['CEO', '说'])
  assert.equal(en.units[0].endMs, (16 + 32 + 44 + 16 + 36) * 5)

  const sp = parseRhy('五[=wu3]*-u3:52;{0:63}@-sp3:68;电[=dian4]-d4:12;')
  assert.equal(sp.units[0].endMs, 260)
  assert.deepEqual(sp.pauses, [{ kind: 'sp', startMs: 260, endMs: 600 }])
  assert.equal(sp.units[1].startMs, 600)
})

test('不认识的片段不丢，时长仍计入', () => {
  const p = parseRhy('sil:2;怪东西:10;好[=hao3]-h3:10;看不懂')
  assert.deepEqual(p.unparsed, ['怪东西:10', '看不懂'])
  assert.equal(p.units[0].startMs, 60)
})

test('说话时段去掉首尾静音；读音只标多音字', () => {
  const p = parseRhy('sil:20;调[=tiao2]-t2:10;@-iao2:10;用[=yong4]-iong4:10;sil:100;')
  assert.deepEqual(speechSpan(p), { startMs: 100, endMs: 250 })
  assert.equal(inlineReadings(p.units, new Set(['调'])), '调[tiao2]用')
  assert.equal(speechSpan(parseRhy('')), null)
})

function fakeSocket(frames, { failOnOpen = false } = {}) {
  const Socket = class {
    constructor(url) {
      Socket.url = url
      queueMicrotask(() => (failOnOpen ? this.onerror?.({}) : this.onopen?.()))
    }
    send(body) {
      Socket.request = JSON.parse(body)
      for (const frame of frames) this.onmessage?.({ data: JSON.stringify(frame) })
    }
    close() {}
  }
  return Socket
}
const b64 = (data) => Buffer.from(data).toString('base64')

test('超拟人：汉字跨帧切开能解码，音频结束后到的读音不丢', async () => {
  const rhy = Buffer.from('sil:2;欢[=huan1]-h1:16;')
  const cut = rhy.indexOf(Buffer.from('欢')) + 1
  const WS = fakeSocket([
    { header: { code: 0, sid: 's1', status: 1 }, payload: { audio: { audio: b64(Buffer.alloc(4800)), status: 2 }, pybuf: { text: b64(rhy.subarray(0, cut)) } } },
    { header: { code: 0, status: 2 }, payload: { pybuf: { text: b64(rhy.subarray(cut)) } } },
  ])
  const r = await hyperSynth('欢', { creds, vcn: 'v', WebSocketImpl: WS })
  assert.equal(r.rhy, rhy.toString())
  assert.equal(r.pcm.length, 4800)
  assert.equal(WS.request.parameter.tts.rhy, 1)
  assert.equal(WS.request.parameter.tts.vcn, 'v')
  assert.equal(Buffer.from(WS.request.payload.text.text, 'base64').toString(), '欢')
})

test('错误码抛 XfError，报错不带密钥；连接失败抛 ConnectError；取消立即结束', async () => {
  await assert.rejects(hyperSynth('你好', { creds, vcn: 'v', WebSocketImpl: fakeSocket([{ header: { code: 11200, message: 'licc limit' } }]) }), (e) => {
    assert.ok(e instanceof XfError)
    assert.equal(e.code, 11200)
    assert.ok(!e.message.includes('test-key') && !e.message.includes('test-secret'))
    return true
  })
  await assert.rejects(v2Synth('你好', { creds, vcn: 'v', WebSocketImpl: fakeSocket([], { failOnOpen: true }) }), ConnectError)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(hyperSynth('你好', { creds, vcn: 'v', signal: controller.signal, WebSocketImpl: fakeSocket([]) }), /已取消/)
})

test('v2：按 data.status 结束，用 UTF8 和 16k PCM', async () => {
  const WS = fakeSocket([{ code: 0, sid: 'v', data: { audio: b64(Buffer.alloc(32000)), status: 2 } }])
  const r = await v2Synth('你好', { creds, vcn: 'xiaoyan', WebSocketImpl: WS })
  assert.equal(r.pcm.length, 32000)
  assert.equal(WS.request.business.tte, 'UTF8')
  assert.equal(r.rhy, null)
})

test('握手报错翻译成人话：这几条服务器原文都是实测到的', async () => {
  assert.match(explainHandshake({ status: 401, message: 'HMAC signature does not match' }, creds).summary, /APISecret/)
  assert.match(explainHandshake({ status: 401, message: 'HMAC signature cannot be verified: apikey not found' }, creds).summary, /APIKey/)
  const swapped = { apiKey: 'NWQ4ZmI1Zk1hYjQ4OTNlYzVjYmJhOTk5', apiSecret: '0123456789abcdef0123456789abcdef' }
  assert.match(explainHandshake({ status: 401, message: 'apikey not found' }, swapped).hint, /填反/)
  assert.equal(explainHandshake({ status: 0, message: 'ENOTFOUND' }, creds).kind, 'network')

  const res = await handshakeMessage('wss://x.example/y', creds, { fetchImpl: async () => new Response('{"message":"apikey not found"}', { status: 401 }) })
  assert.deepEqual(res, { status: 401, message: 'apikey not found' })
  const down = await handshakeMessage('wss://x.example/y', creds, { fetchImpl: async () => { throw new Error('boom') } })
  assert.equal(down.status, 0)
})

test('11200 要分清服务没开和音色没授权', () => {
  assert.equal(explainCode(11200, { engine: 'hyper', vcn: 'x', allFailed: true }).kind, 'service')
  assert.match(explainCode(11200, { engine: 'hyper', allFailed: true }).hint, /字符量/)
  assert.equal(explainCode(11200, { engine: 'hyper', vcn: 'x' }).kind, 'voice')
  assert.equal(explainCode(11203).kind, 'rate')
  assert.equal(explainCode(99999).kind, 'unknown')
})
