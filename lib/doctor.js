// lib/doctor.js — /voice-doctor：一步步查清楚为什么用不了
//
// 新用户最容易卡在这里：字段填错、填反、服务没开、没有字符量、音色没授权。
// 后三种讯飞返回的都是 11200，所以不能只翻译错误码，要真的探测几个音色才分得清。

import { CATALOG, PREFERRED_HYPER, V2_PROBE, engineOf, voiceStatus } from './voices.js'
import { credentialProblem, loadCredentials, looksSwapped } from './config.js'
import { HYPER_QUOTA_PAGE, SERVICE_PAGE, explainCode, explainHandshake } from './xf/errors.js'
import { ConnectError, HYPER_URL, V2_URL, handshakeMessage, hyperSynth, v2Synth } from './xf/tts.js'
import { findFfmpeg, probeVoice } from './speak.js'
import { partsSnapshot } from './health.js'

const SYNTH = { hyper: hyperSynth, v2: v2Synth }
const step = (id, title, ok, detail, fix) => ({ id, title, ok, detail, ...(fix ? { fix } : {}) })

async function probeEngine(engine, codes, { creds, env, synth, fetchImpl }) {
  const label = engine === 'hyper' ? '超拟人合成' : '在线语音合成（v2/tts）'
  let denied = 0
  for (const code of codes) {
    const r = await probeVoice(code, { creds, env, synth })
    if (r.ok) return step(engine, label, true, `音色 ${code} 合成成功`)
    if (r.error instanceof ConnectError) {
      const e = explainHandshake(await handshakeMessage(engine === 'hyper' ? HYPER_URL : V2_URL, creds, { fetchImpl }), creds)
      return step(engine, label, false, e.summary, e.hint)
    }
    if (r.error?.code === 11200) {
      denied += 1
      continue
    }
    const e = explainCode(r.error?.code, { engine, vcn: code })
    return step(engine, label, false, e.summary, e.hint)
  }
  const e = explainCode(11200, { engine, allFailed: denied === codes.length })
  return step(engine, label, false, e.summary, e.hint)
}

export async function runDoctor({ env = process.env, synth = SYNTH, fetchImpl } = {}) {
  const steps = []
  const creds = await loadCredentials(env)
  if (!creds) {
    steps.push(step('credentials', '讯飞凭据', false, '还没有配置', '到「设置 → 声音引擎」填写 AppID、APISecret、APIKey，它们在控制台语音服务页的右上角'))
    return finish(steps, env)
  }
  const problem = credentialProblem(creds)
  if (problem) {
    steps.push(step('credentials', '讯飞凭据', false, problem.text, '到「设置 → 声音引擎」重新填写'))
    return finish(steps, env)
  }
  steps.push(step('credentials', '讯飞凭据', true,
    looksSwapped(creds) ? '已配置，但 APIKey 和 APISecret 看起来填反了' : `已配置（AppID 尾号 ${creds.appId.slice(-3)}）`))

  const context = { creds, env, synth, fetchImpl }
  const hyper = await probeEngine('hyper', PREFERRED_HYPER.slice(0, 3), context)
  steps.push(hyper)
  if (!hyper.ok && !/^(超拟人|音色)/.test(hyper.detail)) return finish(steps, env) // 鉴权类问题，v2 也一样
  steps.push(await probeEngine('v2', [V2_PROBE], context))
  return finish(steps, env)
}

async function finish(steps, env) {
  const bin = await findFfmpeg(env)
  steps.push(step('ffmpeg', 'ffmpeg（输出 mp3 要用）', Boolean(bin), bin ? bin : '没有找到，只能输出 wav', bin ? undefined : '安装 ffmpeg，例如 brew install ffmpeg'))
  const parts = partsSnapshot()
  const broken = Object.entries(parts).filter(([, p]) => !p.ok)
  steps.push(step('plugin', '插件各部分', broken.length === 0,
    broken.length ? broken.map(([name, p]) => `${name}：${p.detail}`).join('；') : `${Object.keys(parts).length} 项正常`))
  // ffmpeg 不影响语音本身，不算整体失败
  return { ok: steps.filter((s) => s.id !== 'ffmpeg').every((s) => s.ok), steps, pages: { hyper: SERVICE_PAGE.hyper, hyperQuota: HYPER_QUOTA_PAGE } }
}

export function formatDoctor({ ok, steps }) {
  const lines = [ok ? '声音引擎可以正常使用。' : '声音引擎现在用不了，按下面的提示处理：', '']
  for (const s of steps) {
    lines.push(`${s.ok ? '✓' : '✗'} ${s.title}：${s.detail}`)
    if (s.fix) lines.push(`  → ${s.fix}`)
  }
  return lines.join('\n')
}

/** 把目录里的超拟人音色都试一遍。失败不扣字符量，成功的每个合成两个字 */
export async function scanVoices({ env = process.env, synth = SYNTH, engine = 'hyper', concurrency = 2, signal } = {}) {
  const creds = await loadCredentials(env)
  const problem = creds ? credentialProblem(creds) : { text: '还没有配置讯飞凭据' }
  if (problem) throw new Error(problem.text)
  const all = CATALOG.filter((v) => v.engine && engineOf(v.code) === engine).map((v) => v.code)
  // 已经确认可用的不重试：可用的音色每试一次都要扣字
  const ok = all.filter((code) => voiceStatus(code) === 'ok')
  const queue = all.filter((code) => voiceStatus(code) !== 'ok')
  const total = all.length
  let denied = 0
  let failed = 0
  const worker = async () => {
    while (queue.length && !signal?.aborted) {
      const r = await probeVoice(queue.shift(), { creds, env, synth, signal })
      if (r.ok) ok.push(r.code)
      else if (r.error?.code === 11200) denied += 1
      else failed += 1
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  return { total, ok, denied, failed }
}
