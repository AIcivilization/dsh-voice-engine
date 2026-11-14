#!/usr/bin/env node
// bin/dsh-voice-engine.mjs — 不开 DSH 也能用声音引擎
//
//   node bin/dsh-voice-engine.mjs voices [--engine edge|ming|xfyun] [--q 关键词]
//   node bin/dsh-voice-engine.mjs say "你好" --voice edge:zh-CN-XiaoxiaoNeural --out hello.mp3 [--speed 1.2]
//   node bin/dsh-voice-engine.mjs serve [--port 18321]      起本机接口，用法同 DSH 里的（说明见 docs/声音引擎接口.md）
//   node bin/dsh-voice-engine.mjs check [--voice 晓晓]      检查本机接口能不能用：像别的产品那样调一次，存成 voice-check.mp3
//
// 讯飞的凭据、额度和 DSH 里的插件共用。命令行是你自己在用，所以讯飞不受「对外开放」开关限制，但会扣额度。

import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { loadState, paths, settingsCached } from '../lib/config.js'
import { listAllVoices, synthesizeAny } from '../lib/engine/index.js'
import { stopMing } from '../lib/engine/ming.js'
import { DEFAULT_PORT, startEngineServer } from '../lib/engine/server.js'

const [command, ...rest] = process.argv.slice(2)
const flag = (name) => {
  const at = rest.indexOf(`--${name}`)
  return at >= 0 ? rest[at + 1] : undefined
}
const positional = rest.filter((arg, i) => !arg.startsWith('--') && !rest[i - 1]?.startsWith('--'))

const USAGE = `用法：
  dsh-voice-engine voices [--engine edge|ming|xfyun] [--q 关键词]
  dsh-voice-engine say <文字> --voice <音色> --out <文件.mp3|.wav> [--speed 1]
  dsh-voice-engine serve [--port ${DEFAULT_PORT}]
  dsh-voice-engine check [--voice 晓晓]   检查本机接口`

await loadState()

try {
  if (command === 'voices') {
    const { total, voices } = listAllVoices({ engine: flag('engine'), query: flag('q') })
    for (const v of voices) console.log(`${v.id.padEnd(40)}${v.name.padEnd(12)}${[v.gender, v.lang, v.dialect, v.style ?? v.scene, v.status].filter(Boolean).join(' · ')}`)
    console.log(`共 ${total} 个`)
  } else if (command === 'say') {
    const text = positional.join(' ')
    const out = flag('out')
    if (!text || !out) throw new Error(USAGE)
    const format = out.toLowerCase().endsWith('.wav') ? 'wav' : 'mp3'
    const r = await synthesizeAny({ voice: flag('voice'), text, speed: Number(flag('speed') ?? 1), format })
    const file = resolve(out.replace(/\.(mp3|wav)$/i, '') + `.${r.format}`)
    await writeFile(file, r.audio)
    console.log(`${file}\n${r.name}（${r.engine}）${r.durationMs ? ` · ${(r.durationMs / 1000).toFixed(1)} 秒` : ''}${r.charged ? ` · 扣讯飞 ${r.charged} 字` : ''}${r.cached ? ' · 缓存' : ''}`)
    for (const w of r.warnings) console.log(`注意：${w}`)
  } else if (command === 'check') {
    // 和别的产品一样：读 engine.json，带令牌调接口。不扣讯飞额度（默认用 Edge 晓晓）
    let cfg
    try {
      cfg = JSON.parse(await readFile(join(paths().root, 'engine.json'), 'utf8'))
    } catch {
      throw new Error(`没找到 ${join(paths().root, 'engine.json')}：DSH 没开，或接口在设置里关掉了。不开 DSH 可以先运行 dsh-voice-engine serve`)
    }
    const step = (ok, text) => console.log(`${ok ? '✓' : '✗'} ${text}`)
    const health = await fetch(`${cfg.url}/v1/health`).then((r) => r.json()).catch((e) => ({ error: e.message }))
    step(health.ok, `接口在 ${cfg.url}${health.ok ? '' : `：连不上（${health.error}）。DSH 开着吗？`}`)
    if (!health.ok) throw new Error('接口没运行')
    const auth = { authorization: `Bearer ${cfg.token}` }
    const engines = await fetch(`${cfg.url}/v1/engines`, { headers: auth }).then((r) => r.json())
    step(engines.ok, engines.ok ? '令牌对' : `令牌不对：${engines.error}`)
    for (const [id, e] of Object.entries(engines.engines ?? {})) step(e.ready, `${e.name}：${e.ready ? (id === 'xfyun' ? (e.open ? '可用，已对外开放' : '可用，没有对外开放（别的产品用不了）') : '可用') : `${e.reason}。${e.fix ?? ''}`}`)
    const voice = flag('voice') ?? 'edge:zh-CN-XiaoxiaoNeural'
    const res = await fetch(`${cfg.url}/v1/speak`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ text: '你好，声音引擎可以用了。', voice }) })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      step(false, `合成失败：${body.error ?? res.status}。${body.hint ?? ''}`)
      throw new Error('合成失败')
    }
    const file = resolve(`voice-check.${res.headers.get('x-voice-format') ?? 'mp3'}`)
    await writeFile(file, Buffer.from(await res.arrayBuffer()))
    step(true, `合成成功：${file}（${res.headers.get('x-voice-engine')}，${res.headers.get('x-voice-duration-ms')} 毫秒，扣讯飞 ${res.headers.get('x-voice-charged-chars')} 字）`)
  } else if (command === 'serve') {
    const server = await startEngineServer({ port: Number(flag('port') ?? settingsCached().enginePort ?? DEFAULT_PORT) })
    console.log(`声音引擎接口：${server.url}\n令牌在 ~/.dsh/dsh-voice-engine/engine.json。Ctrl+C 结束。`)
    setInterval(() => {}, 1 << 30) // 服务器不挡退出，这里自己挂着
  } else {
    console.log(USAGE)
  }
} catch (error) {
  console.error(`${error.message}${error.hint ? `\n${error.hint}` : ''}`)
  process.exitCode = 1
} finally {
  if (command !== 'serve') stopMing()
}
