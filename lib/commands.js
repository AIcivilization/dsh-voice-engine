// lib/commands.js — /voice-* 宿主命令：不走模型、不花 token
//
// 代码类场景可以直接用命令运行。两条来自 dsh-vps 的规矩：
//   - 宿主命令执行时没有轮次包裹，弹不出审批框，所以花钱的操作用「先出计划，加 --yes 再执行」
//   - 没声明 input 的命令只认光秃秃的 /名字；要带参数必须声明 input，否则整句会交给模型

import { allowedCached, setAllowed } from './config.js'
import { formatDoctor, runDoctor } from './doctor.js'
import { L } from './i18n.js'
import { planTranscribe, transcribe } from './listen.js'
import { isOtherEngineVoice, speakAnyToFile } from './engine/index.js'
import { requestLibrary } from './picker.js'
import { compareVoices, listScenes, planBatch, runBatch } from './scenes.js'
import { SpeakError, speak } from './speak.js'
import { STATUS_LABEL, searchVoices, defaultVoiceInfo, setDefaultVoice, defaultVoiceAny } from './voices.js'

const cwdOf = (invocation) => invocation?.agent?.session?.header?.cwd ?? invocation?.agent?.session?.meta?.cwd
const sessionOf = (invocation) => String(invocation?.agent?.session?.id ?? invocation?.sessionId ?? '')

const failed = (error) => ({
  kind: 'error',
  text: error instanceof SpeakError ? [error.message, error.hint].filter(Boolean).join('\n') : (error?.message ?? String(error)),
})

function formatSpoken(r) {
  const lines = [L(`已生成：${r.file}`, `Saved: ${r.file}`), L(`${r.voiceName} · ${(r.durationMs / 1000).toFixed(1)} 秒${r.cached ? ' · 缓存' : ''}`, `${r.voiceName} · ${(r.durationMs / 1000).toFixed(1)}s${r.cached ? ' · cached' : ''}`)]
  if (r.readings) lines.push(L(`实际读音：${r.readings}`, `Readings: ${r.readings}`))
  for (const w of r.warnings ?? []) lines.push(w)
  return lines.join('\n')
}

export function registerCommands(ctx, deps = {}) {
  const env = deps.env ?? process.env
  const synthDeps = { env, ...(deps.synth ? { synth: deps.synth } : {}), ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), ...(deps.findFfmpeg ? { findFfmpeg: deps.findFfmpeg } : {}), ...(deps.sleep ? { sleep: deps.sleep } : {}) }
  const disposers = []
  const catalog = []
  const reg = (def, usage, short) => {
    catalog.push({ usage, short })
    disposers.push(ctx.commands.register(def))
  }

  reg({
    name: 'voice-help',
    description: L('声音引擎怎么用：命令清单和场景', 'How to use Voice Engine: commands and scenes'),
    async handler() {
      const scenes = listScenes()
      const ready = scenes.filter((s) => s.status === 'available')
      return {
        kind: 'success',
        text: [
          L('[声音引擎] 直接说需求就行，比如「把这段读出来」。这些命令不走模型、不花 token：', '[Voice Engine] Just say what you need, like "read this aloud". These commands skip the model and cost no tokens:'),
          ...catalog.map((c) => `  ${c.usage.padEnd(30)}${c.short}`),
          '',
          L(`场景：${ready.length} 个可用，共 ${scenes.length} 个`, `Scenes: ${ready.length} ready of ${scenes.length}`),
          ...ready.map((s) => `  ${s.id} ${s.name}：${s.say}`),
        ].join('\n'),
      }
    },
  }, '/voice-help', L('这份说明', 'This help'))

  reg({
    name: 'voice-doctor',
    description: L('一步步检查声音引擎为什么用不了', 'Check step by step why Voice Engine is not working'),
    async handler() {
      try {
        const report = await runDoctor(synthDeps)
        return { kind: report.ok ? 'success' : 'error', text: formatDoctor(report) }
      } catch (error) {
        return failed(error)
      }
    },
  }, '/voice-doctor', L('检查凭据、服务开通和额度', 'Check credentials, services, and quota'))

  reg({
    name: 'voice-list',
    description: L('打开音色库，也列出结果。用法：/voice-list <关键词>', 'Open the voice library and list matches. Usage: /voice-list <keyword>'),
    input: { hint: L('<关键词，可留空>', '<keyword, optional>') },
    async handler(invocation) {
      const opened = requestLibrary(sessionOf(invocation), invocation?.rawInput)
      const { total, voices } = searchVoices({ query: invocation?.rawInput, limit: 20 })
      if (!voices.length) return { kind: 'success', text: L('没有匹配的音色', 'No matching voices') }
      return {
        kind: 'success',
        text: [
          ...(opened ? [L('已打开右侧栏的音色库，可以试听、对比、选用。', 'The voice library is open in the right sidebar: listen, compare, and choose there.')] : []),
          L(`共 ${total} 个，显示 ${voices.length} 个：`, `${total} found, showing ${voices.length}:`),
          ...voices.map((v) => `  ${v.code.padEnd(36)}${v.name.padEnd(10)}${[v.engine, v.scene, STATUS_LABEL[v.status]].filter(Boolean).join(' · ')}`),
        ].join('\n'),
      }
    },
  }, '/voice-list <关键词>', L('打开音色库，试听、对比、选用', 'Open the voice library'))

  reg({
    name: 'voice-default',
    description: L('设默认音色。用法：/voice-default <音色>，/voice-default --off 恢复自动选择', 'Set the default voice. Usage: /voice-default <voice>, /voice-default --off for automatic'),
    input: { hint: L('<音色> 或 --off，留空查看', '<voice> or --off, empty to show') },
    async handler(invocation) {
      const input = String(invocation?.rawInput ?? '').trim()
      try {
        if (!input) {
          const now = defaultVoiceInfo()
          return { kind: 'success', text: L(`默认音色：${now.name}（${now.code}）${now.chosen ? '' : '，自动选择'}`, `Default voice: ${now.name} (${now.code})${now.chosen ? '' : ', automatic'}`) }
        }
        const now = await setDefaultVoice(input === '--off' ? '' : input, env)
        return { kind: 'success', text: L(`默认音色：${now.name}（${now.code}）${now.chosen ? '，之后不指定音色时都用它' : '，已恢复自动选择'}`, `Default voice: ${now.name} (${now.code})${now.chosen ? '. Used whenever no voice is specified' : '. Back to automatic'}`) }
      } catch (error) {
        return { kind: 'error', text: L(`${error.message}。发 /voice-list 查音色`, `${error.message}. Send /voice-list to look up voices`) }
      }
    },
  }, '/voice-default <音色>', L('设默认音色', 'Set the default voice'))

  reg({
    name: 'voice-say',
    description: L('用讯飞朗读一段文字。用法：/voice-say <文字>', 'Read text aloud. Usage: /voice-say <text>'),
    input: { hint: L('<文字>', '<text>') },
    async handler(invocation) {
      const text = String(invocation?.rawInput ?? '').trim()
      if (!text) return { kind: 'error', text: L('用法：/voice-say <文字>', 'Usage: /voice-say <text>') }
      try {
        // 默认音色选了 Edge、Ming 时用它们，免费
        if (isOtherEngineVoice(defaultVoiceAny())) return { kind: 'success', text: formatSpoken(await speakAnyToFile({ voice: defaultVoiceAny(), text, cwd: cwdOf(invocation) }, synthDeps)) }
        return { kind: 'success', text: formatSpoken(await speak({ text, cwd: cwdOf(invocation) }, synthDeps)) }
      } catch (error) {
        return failed(error)
      }
    },
  }, '/voice-say <文字>', L('朗读一段文字（S08）', 'Read text aloud (S08)'))

  reg({
    name: 'voice-try',
    description: L('几个音色读同一句对比。用法：/voice-try <音色,音色> <文字>', 'Compare voices on one line. Usage: /voice-try <voice,voice> <text>'),
    input: { hint: L('<音色,音色> <文字>', '<voice,voice> <text>') },
    async handler(invocation) {
      const m = String(invocation?.rawInput ?? '').trim().match(/^(\S+)\s+(.+)$/s)
      if (!m) return { kind: 'error', text: L('用法：/voice-try <音色,音色> <文字>', 'Usage: /voice-try <voice,voice> <text>') }
      try {
        const { results } = await compareVoices({ voices: m[1], text: m[2], cwd: cwdOf(invocation) }, synthDeps)
        return { kind: 'success', text: results.map((r) => (r.ok ? formatSpoken(r) : `${r.vcn}：${r.error}。${r.hint ?? ''}`)).join('\n\n') }
      } catch (error) {
        return failed(error)
      }
    },
  }, '/voice-try <音色,音色> <文字>', L('用我的文案试音（S22）', 'Try voices on your text (S22)'))

  reg({
    name: 'voice-batch',
    description: L('批量生成语音包。用法：/voice-batch <清单文件> [--voice 音色] [--yes]', 'Generate voice prompts in bulk. Usage: /voice-batch <file> [--voice v] [--yes]'),
    input: { hint: L('<清单文件> [--voice 音色] [--yes]', '<file> [--voice v] [--yes]') },
    async handler(invocation) {
      const tokens = String(invocation?.rawInput ?? '').trim().split(/\s+/).filter(Boolean)
      const yes = tokens.includes('--yes')
      const voiceAt = tokens.indexOf('--voice')
      const vcn = voiceAt >= 0 ? tokens[voiceAt + 1] : undefined
      const file = tokens.find((t, i) => !t.startsWith('--') && (voiceAt < 0 || i !== voiceAt + 1))
      if (!file) return { kind: 'error', text: L('用法：/voice-batch <清单文件> [--voice 音色] [--yes]', 'Usage: /voice-batch <file> [--voice v] [--yes]') }
      const cwd = cwdOf(invocation)
      try {
        const plan = await planBatch({ file, cwd, env })
        if (!yes) {
          return {
            kind: 'success',
            text: L(
              `将合成 ${plan.items.length} 条，共 ${plan.chars} 字（已合成过的不重复扣量）。\n确认后发：/voice-batch ${tokens.join(' ')} --yes`,
              `This will synthesize ${plan.items.length} lines, ${plan.chars} characters (already generated ones are not charged again).\nTo confirm: /voice-batch ${tokens.join(' ')} --yes`,
            ),
          }
        }
        const r = await runBatch({ file, vcn, cwd }, synthDeps)
        return {
          kind: r.ok ? 'success' : 'error',
          text: [
            L(`输出目录：${r.outputDir}`, `Output: ${r.outputDir}`),
            L(`成功 ${r.done.length} 条，失败 ${r.failed.length} 条`, `${r.done.length} done, ${r.failed.length} failed`),
            ...r.failed.map((f) => `  ${f.name}：${f.error}。${f.hint ?? ''}`),
          ].join('\n'),
        }
      } catch (error) {
        return failed(error)
      }
    },
  }, '/voice-batch <清单文件> [--yes]', L('批量语音包（S13）', 'Bulk voice prompts (S13)'))

  reg({
    name: 'voice-listen',
    description: L('把音频或视频转成文字和字幕。用法：/voice-listen <文件> [--speakers]', 'Transcribe audio or video. Usage: /voice-listen <file> [--speakers]'),
    input: { hint: L('<文件> [--speakers] [--yes]', '<file> [--speakers] [--yes]') },
    async handler(invocation) {
      const raw = String(invocation?.rawInput ?? '').trim()
      const speakers = /(^|\s)--speakers(\s|$)/.test(raw)
      const yes = /(^|\s)--yes(\s|$)/.test(raw)
      // 路径里可能有空格，所以去掉选项后整段都当文件名
      const file = raw.replace(/(^|\s)--(speakers|yes)(?=\s|$)/g, '').trim().replace(/^(['"])(.*)\1$/, '$2')
      if (!file) return { kind: 'error', text: L('用法：/voice-listen <文件> [--speakers]', 'Usage: /voice-listen <file> [--speakers]') }
      const cwd = cwdOf(invocation)
      try {
        const plan = await planTranscribe({ file, speakers, cwd }, synthDeps)
        if (!plan.paid && !yes && !(plan.durationMs && plan.durationMs <= 30 * 60 * 1000)) {
          const length = plan.durationMs ? L(`${Math.round(plan.durationMs / 60000)} 分钟`, `${Math.round(plan.durationMs / 60000)} minutes`) : L('时长未知', 'unknown length')
          return { kind: 'success', text: L(`这个文件${length}，转写会消耗讯飞额度，同一个文件不重复扣费。\n确认后发：/voice-listen ${raw} --yes`, `This file is ${length}. Transcribing uses iFLYTEK quota; the same file is not charged twice.\nTo confirm: /voice-listen ${raw} --yes`) }
        }
        const r = await transcribe({ file, speakers, cwd }, synthDeps)
        if (r.status === 'running') return { kind: 'success', text: L('讯飞还在转写，任务已保存。稍后再发一次同样的命令，不会重复扣费。', 'Still transcribing; the task is saved. Send the same command again later. You will not be charged twice.') }
        if (r.empty) return { kind: 'success', text: L('讯飞没有转写出文字，音频可能没有人声。', 'No speech was found in this file.') }
        return { kind: 'success', text: [L(`转写完成：${(r.durationMs / 1000).toFixed(1)} 秒，${r.chars} 字${r.cached ? ' · 已有结果，未扣费' : ''}`, `Done: ${(r.durationMs / 1000).toFixed(1)}s, ${r.chars} characters${r.cached ? ' · already done, not charged' : ''}`), ...Object.values(r.files)].join('\n') }
      } catch (error) {
        return failed(error)
      }
    },
  }, '/voice-listen <文件> [--speakers]', L('音频视频转文字和字幕（S14、S15）', 'Transcribe audio or video (S14, S15)'))

  reg({
    name: 'voice-allow',
    description: L('在当前对话放行别的语音产品。用法：/voice-allow <名字>，/voice-allow --off 恢复', 'Allow another speech product in this conversation. Usage: /voice-allow <name>, /voice-allow --off to restore'),
    input: { hint: L('<名字> 或 --off', '<name> or --off') },
    async handler(invocation) {
      const session = sessionOf(invocation)
      if (!session) return { kind: 'error', text: L('拿不到当前对话，这个命令要在对话里发', 'Cannot tell which conversation this is. Send this command in a conversation') }
      const input = String(invocation?.rawInput ?? '').trim()
      if (input === '--off') {
        await setAllowed(session, [], env)
        return { kind: 'success', text: L('已恢复：这个对话的语音需求先用讯飞', 'Restored: speech requests in this conversation use iFLYTEK first') }
      }
      if (!input) {
        const now = allowedCached(session)
        return { kind: 'success', text: now.length ? L(`这个对话已放行：${now.join('、')}`, `Allowed here: ${now.join(', ')}`) : L('这个对话没有放行别的语音产品', 'Nothing else is allowed in this conversation') }
      }
      await setAllowed(session, [...new Set([...allowedCached(session), input])], env)
      return { kind: 'success', text: L(`这个对话已放行 ${input}。恢复发 /voice-allow --off`, `${input} is allowed in this conversation. To restore: /voice-allow --off`) }
    },
  }, '/voice-allow <名字>', L('在当前对话放行别的语音产品', 'Allow another speech product here'))

  const disposeAll = () => {
    for (const dispose of disposers) {
      try {
        dispose?.()
      } catch {
        // 反注册失败不影响卸载
      }
    }
  }
  disposeAll.count = catalog.length
  return disposeAll
}
