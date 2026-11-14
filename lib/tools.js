// lib/tools.js — 给模型的工具
//
// 工具描述保持短，工作流写在 skill 和场景手册里。
// 返回值要让模型能接着行动：失败不抛异常，而是给出 kind、hint 和可替代的音色。
// 这是 M3 的 6 个工具；voice_capability 到对应阶段再加。

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { credentialStatus, getState, hasCredentialsCached, loadCredentials, settingsCached } from './config.js'
import { formatDoctor, runDoctor, scanVoices } from './doctor.js'
import { DOMAINS, compareToScript, planTranscribe, transcribe } from './listen.js'
import { presentVoices, requestLibrary } from './picker.js'
import { SUBTITLE_FORMATS, buildProject, createProject, diffProject, editProject, listProjects, planBuild, showProject } from './project.js'
import { getScene, listScenes, planBatch, runScene } from './scenes.js'
import { SpeakError, countChars, speak } from './speak.js'
import { isOtherEngineVoice, searchOtherVoices, speakAnyToFile } from './engine/index.js'
import { HYPER_QUOTA_PAGE, SERVICE_PAGE } from './xf/errors.js'
import { CATALOG, defaultVoiceAny, defaultVoiceInfo, searchVoices, setDefaultVoice } from './voices.js'

const OUTPUT_SCHEMA = { type: 'object' }
// DSH 的参数校验不接受 type 写成数组，可空要用 oneOf
const nullable = (type, description) => ({ oneOf: [{ type }, { type: 'null' }], ...(description ? { description } : {}) })
const SPEND_MULTIPLE = 3 // 工程累计合成超过文稿字数的这个倍数，就请用户确认
const CONFIRM_LISTEN_MS = 30 * 60 * 1000 // 转写超过这么长先问，时长不明时看文件大小
const CONFIRM_LISTEN_BYTES = 200 * 1024 * 1024

async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    return mod.defineTool ?? null
  } catch {
    return null // 插件从自己的目录加载时可能取不到，退回原始格式
  }
}

function parametersSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(spec)) {
    const { required: isRequired, ...rest } = value
    properties[key] = rest
    if (isRequired) required.push(key)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false }
}

/** DSH 只接受能无损转成 JSON 的返回值 */
export const toPlainJson = (value) => JSON.parse(JSON.stringify(value ?? null))

const failure = (error) => {
  if (error instanceof SpeakError) {
    return { ok: false, kind: error.kind, error: error.message, hint: error.hint, ...(error.code ? { code: error.code } : {}), ...(error.alternatives?.length ? { alternatives: error.alternatives } : {}) }
  }
  return { ok: false, kind: 'unknown', error: error?.message ?? String(error), hint: '可以请用户发 /voice-doctor 检查' }
}

const cwdOf = (exec) => exec?.agent?.session?.header?.cwd ?? exec?.agent?.session?.meta?.cwd

const seconds = (ms) => `${(ms / 1000).toFixed(1)} 秒`

function renderSpeak(v) {
  if (!v.ok) return renderFailure(v)
  const lines = [`已生成：${v.file}`, `音色：${v.voiceName}（${v.vcn}，${v.engine}）· 音频 ${seconds(v.durationMs)} · ${v.chars} 字${v.cached ? ' · 缓存，未扣量' : ''}`]
  if (v.speech) lines.push(`说话时段：${seconds(v.speech.startMs)}–${seconds(v.speech.endMs)}`)
  if (v.readings) lines.push(`实际读音（多音字标了拼音，请检查）：${v.readings}`)
  if (v.readingsFile) lines.push(`完整读音：${v.readingsFile}`)
  for (const w of v.warnings ?? []) lines.push(`注意：${w}`)
  return lines.join('\n')
}

function renderFailure(v) {
  return [
    `失败（${v.kind}）：${v.error}`,
    v.hint ? `处理：${v.hint}` : '',
    v.alternatives?.length ? `当前账号可用的音色：${v.alternatives.join('、')}` : '',
  ].filter(Boolean).join('\n')
}

function renderVoices(v) {
  if (!v.ok) return renderFailure(v)
  if (!v.voices?.length) return '没有匹配的音色。放宽条件再查一次。'
  const lines = v.voices.map((x) => [x.code, x.name, x.engine, x.gender, x.lang, x.dialect, x.scene, x.style, x.status, x.hasSample ? '有样音' : ''].filter(Boolean).join(' | '))
  return [`共 ${v.total} 个，显示 ${v.voices.length} 个（编码 | 名字 | 引擎 | 性别 | 语种 | …… | 状态）：`, ...lines].join('\n')
}

function renderScene(v) {
  if (!v.ok) return renderFailure(v)
  if (v.scenes) return v.scenes.map((s) => `${s.id} ${s.name}（${s.mode}，${s.status === 'available' ? '可用' : `计划 ${s.milestone}`}）：${s.say}`).join('\n')
  if (v.scene) return [`${v.scene.id} ${v.scene.name}（${v.scene.status === 'available' ? '可用' : `计划 ${v.scene.milestone}，还不能用`}）`, v.scene.playbookText ?? '这个场景还没有手册。'].join('\n\n')
  if (v.results) return v.results.map(renderSpeak).join('\n\n')
  if (v.done) {
    const lines = [`输出目录：${v.outputDir}`, `共 ${v.total} 条，${v.chars} 字：成功 ${v.done.length}，失败 ${v.failed.length}${v.stopped ? `，因 ${v.stopped} 问题提前停止，跳过 ${v.skipped} 条` : ''}`]
    for (const d of v.done) if (d.readings) lines.push(`第 ${d.line} 行 ${d.name}：${d.readings}`)
    for (const f of v.failed) lines.push(`第 ${f.line} 行 ${f.name} 失败（${f.kind}）：${f.error}。${f.hint ?? ''}`)
    return lines.join('\n')
  }
  if (v.voices) return renderVoices(v)
  if (v.status) return renderListen(v)
  return renderSpeak(v)
}

function renderDiff(v) {
  const lines = [`工程「${v.name}」：要重新合成 ${v.changed.length} 句，不变 ${v.unchanged} 句，预计扣 ${v.charsToSynth} 字${v.reordered ? '，句子顺序变了' : ''}`]
  const LABEL = { text: '改文字', reading: '改读音' }
  for (const c of v.changed) lines.push(LABEL[c.change] ? `${c.id} ${LABEL[c.change]}：${c.before} → ${c.after}` : c.change === 'params' ? `${c.id} 改音色或参数：${c.after}` : `${c.id} 新句：${c.after}`)
  for (const r of v.removed) lines.push(`${r.id} 删除：${r.text}`)
  return lines.join('\n')
}

function renderBuild(v) {
  const lines = [
    `已导出工程「${v.name}」：总长 ${seconds(v.totalMs)}，${v.sentences} 句，${v.cues} 条字幕`,
    ...Object.entries(v.files).map(([k, f]) => `${k}：${f}`),
    `重新合成 ${v.resynthesized.length} 句${v.resynthesized.length ? `（${v.resynthesized.join('、')}）` : ''}，复用 ${v.reused} 句，这次扣 ${v.chars} 字，工程累计 ${v.spentChars} 字`,
    `时间轴来源：音素 ${v.timing.phoneme} 句，音频字节 ${v.timing.bytes} 句（句内估算），估算 ${v.timing.estimate} 句`,
  ]
  const d = v.checks.duration
  if (!d.skipped) lines.push(`时长检查：${d.ok ? '通过' : '不通过'}，目标 ${seconds(d.targetMs)}，实际 ${seconds(d.actualMs)}，差 ${(d.deltaMs / 1000).toFixed(1)} 秒，允许 ±${seconds(d.toleranceMs)}`)
  lines.push(v.checks.coverage.ok ? '覆盖检查：通过' : `覆盖检查：不通过\n${v.checks.coverage.problems.map((p) => `  - ${p}`).join('\n')}`)
  if (v.pronunciation.length) lines.push('实际读音（多音字标了拼音，请检查）：', ...v.pronunciation.map((p) => `  ${p.id} ${p.readings}`))
  for (const w of v.warnings) lines.push(`注意：${w}`)
  return lines.join('\n')
}

function renderListen(v) {
  if (!v.ok) return renderFailure(v)
  if (v.status === 'running') return `${v.hint}${v.durationMs ? `（音频 ${seconds(v.durationMs)}）` : ''}`
  if (v.empty) return v.hint
  const lines = [
    `转写完成：音频 ${seconds(v.durationMs)}，${v.chars} 字，${v.segments} 段，${v.cues} 条字幕${v.cached ? ' · 已有结果，未扣费' : v.resumed ? ' · 接上已提交的任务，未重复扣费' : ''}`,
    ...(v.speakers?.length ? [`说话人：${v.speakers.join('、')}（讯飞只分得出是不是同一个人，不知道是谁）`] : []),
    ...Object.entries(v.files).map(([k, f]) => `${k}：${f}`),
    v.truncated ? `开头部分（完整文稿读 ${v.files.txt}）：` : '全文：',
    v.text,
  ]
  return lines.join('\n')
}

function renderRelisten(v) {
  if (v.status === 'running') return renderListen(v)
  if (!v.differences.length) return `回听通过：${v.checked} 句听到的文字和原稿一致。注意：回听查不出同字异音，读音看 pronunciation。`
  return [
    `回听发现 ${v.differences.length} 句和原稿不同（共 ${v.checked} 句）。转写本身也会出错，请你判断是真的读错，还是写法不同：`,
    ...v.differences.map((d) => `${d.id} 原稿：${d.expected}\n  听到：${d.heard}\n  原稿有而没听到：${d.missing.join('、') || '无'}；多听到：${d.extra.join('、') || '无'}${d.hasNumbers ? '（含数字，写法不同很常见）' : ''}`),
  ].join('\n')
}

function renderProject(v) {
  if (!v.ok) {
    const failed = (v.failed ?? []).map((f) => `  ${f.id} ${f.text}：${f.error}`)
    return [renderFailure(v), ...(v.totalSentences ? [`已合成 ${v.doneSentences}/${v.totalSentences} 句`] : []), ...failed].join('\n')
  }
  if (v.built) return renderBuild(v)
  if (v.relisten) return renderRelisten(v)
  if (v.projects) return v.projects.length ? v.projects.map((p) => `${p.name}：${p.sentences} 句，${p.chars} 字${p.totalMs ? `，${seconds(p.totalMs)}` : '，未导出'}`).join('\n') : '当前目录还没有工程。'
  if (v.changed) return renderDiff(v)
  const glossary = Object.entries(v.glossary)
  return [
    `工程「${v.name}」${v.created ? '已创建' : ''}：${v.sentences.length} 句，${v.chars} 字，音色 ${v.voiceName}（${v.vcn}），语速 ${v.speed}${v.targetMs ? `，目标 ${seconds(v.targetMs)}` : ''}${v.lastBuild ? `，上次导出 ${seconds(v.lastBuild.totalMs)}` : '，未导出'}`,
    ...(glossary.length ? [`词表：${glossary.map(([w, m]) => `${w} → ${m}`).join('，')}`] : []),
    ...v.sentences.map((s) => `${s.id}${s.durationMs ? ` [${seconds(s.startMs)}–${seconds(s.endMs)}]` : ''}${s.vcn ? ` (${s.vcn})` : ''} ${s.text}`),
    ...(v.lastBuild ? Object.entries(v.lastBuild.files).map(([k, f]) => `${k}：${f}`) : []),
  ].join('\n')
}

function renderAccount(v) {
  if (!v.ok) return renderFailure(v)
  if (v.doctorText) return v.doctorText
  if (v.scan) return `试了 ${v.scan.total} 个超拟人音色：可用 ${v.scan.ok.length} 个，未授权 ${v.scan.denied} 个，其他失败 ${v.scan.failed} 个。\n可用：${v.scan.ok.join('、')}`
  return [
    `凭据：${v.credentials.configured ? `已配置（AppID 尾号 ${v.credentials.appIdTail}）` : `未配置${v.credentials.problem ? `：${v.credentials.problem}` : ''}`}`,
    `音色：目录 ${v.catalog} 个，已确认可用 ${v.voicesOk} 个，已确认未授权 ${v.voicesDenied} 个，其余未试过`,
    `今天本机合成：${v.today.chars} 字，${v.today.calls} 次；转写 ${Math.round((v.today.listenMs ?? 0) / 60000)} 分钟（只统计本插件，不是讯飞账户余额）`,
    `超过 ${v.confirmChars} 字先请用户确认；优先路由${v.guard ? '已开启' : '已关闭'}`,
    `超拟人服务页：${v.pages.hyper}`,
    `领取超拟人字符量：${v.pages.hyperQuota}`,
  ].join('\n')
}

/** 走一次审批。没有审批界面时按拒绝处理，并把原因告诉模型 */
async function confirmSpend(ctx, exec, toolName, reason) {
  let approval
  try {
    approval = ctx?.get?.('approval')
  } catch {
    approval = undefined
  }
  if (!approval || typeof approval.request !== 'function') return { allowed: false, hint: '当前环境弹不出确认框，这么大的任务请用户在有界面的对话里发起，或分段处理' }
  try {
    const outcome = await approval.request({ agent: exec.agent, toolName, ...(exec.callId !== undefined ? { callId: exec.callId } : {}), reason, signal: exec.signal })
    if (outcome === 'allowed-once') return { allowed: true }
    return { allowed: false, hint: outcome === 'rejected' ? '用户拒绝了这次合成' : '没有得到用户确认' }
  } catch (error) {
    return { allowed: false, hint: `确认失败：${error.message}` }
  }
}

export async function buildToolDefinitions(ctx, deps = {}) {
  const defineTool = await loadDefineTool()
  const env = deps.env ?? process.env
  const synthDeps = { env, ...(deps.synth ? { synth: deps.synth } : {}), ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), ...(deps.findFfmpeg ? { findFfmpeg: deps.findFfmpeg } : {}), ...(deps.sleep ? { sleep: deps.sleep } : {}), ...(deps.edgeRun ? { edgeRun: deps.edgeRun } : {}), ...(deps.mingWorker ? { mingWorker: deps.mingWorker } : {}) }

  const tool = (def) => (defineTool
    ? defineTool({ ...def, output: { schema: { type: 'json' }, render: (_a, value) => [{ type: 'text', text: def.render(value) }] } })
    : {
        name: def.name,
        description: def.description,
        parameters: parametersSchema(def.parameters),
        output: { schema: OUTPUT_SCHEMA, render: (_a, value) => [{ type: 'text', text: def.render(value) }] },
        execute: def.execute,
      })

  const guarded = (fn) => async (args, exec) => {
    try {
      return toPlainJson(await fn(args ?? {}, exec))
    } catch (error) {
      return toPlainJson(failure(error))
    }
  }

  const needConfirm = async (chars, exec, toolName) => {
    const limit = settingsCached().confirmChars
    if (chars <= limit) return null
    const res = await confirmSpend(ctx, exec, toolName, `这次要合成 ${chars} 字（超过确认阈值 ${limit} 字），会消耗讯飞字符量。已合成过的内容走缓存，不重复扣量。`)
    return res.allowed ? null : { ok: false, kind: 'rejected', error: '没有执行合成', hint: res.hint }
  }

  /** 转写：够长才请用户确认，已提交过的不用再确认 */
  const listen = async (args, exec) => {
    const input = { ...args, cwd: cwdOf(exec), signal: exec?.signal }
    const plan = await planTranscribe(input, synthDeps)
    const big = plan.durationMs ? plan.durationMs > CONFIRM_LISTEN_MS : plan.size > CONFIRM_LISTEN_BYTES
    if (!plan.paid && big) {
      const length = plan.durationMs ? `${Math.round(plan.durationMs / 60000)} 分钟` : `${Math.round(plan.size / 1048576)}M`
      const res = await confirmSpend(ctx, exec, 'voice_listen', `这次要转写 ${length}的音频，会消耗讯飞转写额度。同一个文件不重复扣费。`)
      if (!res.allowed) return { ok: false, kind: 'rejected', error: '没有执行转写', hint: res.hint }
    }
    return transcribe(input, synthDeps)
  }

  return [
    tool({
      name: 'voice_listen',
      description: '讯飞转写：把本机的音频或视频变成文稿和字幕（txt、srt、vtt、json），支持说话人分离。返回摘要和文件路径，长文稿要读文件。status=running 时用同样参数再调一次，不重复扣费。同一个文件不重复扣费。',
      parameters: {
        file: { type: 'string', required: true, description: '音频或视频路径，相对当前工作目录' },
        speakers: { type: 'boolean', description: '区分说话人。默认关' },
        speakerCount: { type: 'integer', description: '说话人数，不知道就不传' },
        hotwords: { type: 'array', items: { type: 'string' }, description: '容易听错的专有名词，提高识别率' },
        domain: { type: 'string', enum: DOMAINS, description: '内容领域：court 法律、edu 教育、finance 金融、medical 医疗、tech 科技、sport 体育、gov 政务、game 游戏、ecom 电商、car 汽车' },
        outputDir: { type: 'string', description: '输出目录。不传就放进 voice-output/' },
        maxWidth: { type: 'integer', description: '每条字幕最多多少个汉字宽，默认 18' },
      },
      render: renderListen,
      execute: guarded(listen),
    }),

    tool({
      name: 'voice_account',
      description: '查讯飞账号状态。action：status 看凭据和用量；doctor 逐项诊断为什么用不了；scan 试遍超拟人音色，找出当前账号能用哪些（约一分钟）。',
      parameters: {
        action: { type: 'string', enum: ['status', 'doctor', 'scan'], description: '默认 status' },
      },
      render: renderAccount,
      execute: guarded(async (args, exec) => {
        if (args.action === 'doctor') {
          const report = await runDoctor(synthDeps)
          return { ok: true, doctor: report, doctorText: formatDoctor(report) }
        }
        if (args.action === 'scan') return { ok: true, scan: await scanVoices({ ...synthDeps, signal: exec?.signal }) }
        const state = getState()
        const statuses = Object.values(state.voices).map((v) => v.status)
        const today = state.usage[new Date().toISOString().slice(0, 10)] ?? { chars: 0, calls: 0 }
        const settings = settingsCached()
        return {
          ok: true,
          credentials: credentialStatus(await loadCredentials(env)),
          catalog: CATALOG.filter((v) => v.engine).length,
          voicesOk: statuses.filter((s) => s === 'ok').length,
          voicesDenied: statuses.filter((s) => s === 'denied').length,
          today,
          guard: settings.guard && hasCredentialsCached(),
          confirmChars: settings.confirmChars,
          pages: { hyper: SERVICE_PAGE.hyper, hyperQuota: HYPER_QUOTA_PAGE },
        }
      }),
    }),

    tool({
      name: 'voice_voices',
      description: '查声音引擎，或交给用户试听选择。action=search（默认）按条件查；present 传 codes 发到输入框上方让用户试听对比后点选；open 打开右侧栏音色库，用户想自己逛时用；default 传 code 设默认音色，用户说以后都用某个音色时用，不传 code 查看。status：ok 可用，denied 未授权，unknown 未试过。',
      parameters: {
        action: { type: 'string', enum: ['search', 'present', 'open', 'default'], description: '默认 search' },
        query: { type: 'string', description: '名字、拼音、编码、场景或风格关键词' },
        gender: { type: 'string', enum: ['male', 'female', 'child', 'unknown'] },
        lang: { type: 'string', description: '语种码：zh、en、ja、ko、fr、yue……' },
        dialect: { type: 'string', description: '方言地区：四川、东北、台湾……' },
        scene: { type: 'string', description: '场景关键词：旁白、新闻、客服、宣传……' },
        engine: { type: 'string', enum: ['hyper', 'v2', 'edge', 'ming'], description: 'hyper 讯飞超拟人（有读音反馈），v2 讯飞传统合成；edge 微软（免费、联网），ming 本机（免费、只在 Apple 芯片 Mac）' },
        status: { type: 'string', enum: ['ok', 'denied', 'unknown'] },
        sample: { type: 'boolean', description: '只看有免费样音的' },
        code: { type: 'string', description: 'default 用：音色编码或名字' },
        limit: { type: 'integer', description: '最多返回几个，默认 12' },
        codes: { type: 'array', items: { type: 'string' }, description: 'present 用：候选音色编码，建议 3 个' },
        question: { type: 'string', description: 'present 用：告诉用户在选什么' },
        sampleText: { type: 'string', description: 'present 用：试听时合成的文字，取用户文案里的一句' },
      },
      render: (v) => {
        if (v.presented) return `已把 ${v.presented} 个候选发到界面，等用户试听、对比后点选。用户选好后，选择会作为一条消息发回对话。现在结束这一轮，不要继续往下做。`
        if (v.opened !== undefined) return v.opened ? '已打开右侧栏的音色库，用户可以自己搜索、试听、对比、选用。' : '打不开音色库。请用户点对话页右侧栏的「声音引擎」。'
        if (v.default) return `默认音色：${v.default.name}（${v.default.code}）${v.default.chosen ? '，不指定音色时都用它' : '，自动选择'}`
        return renderVoices(v)
      },
      execute: guarded(async (args, exec) => {
        if (args.action === 'present') {
          const entry = presentVoices(exec?.agent?.session?.id, { codes: args.codes, question: args.question, sampleText: args.sampleText })
          return { ok: true, presented: entry.voices.length }
        }
        if (args.action === 'open') return { ok: true, opened: requestLibrary(exec?.agent?.session?.id, args.query) }
        if (args.action === 'default') {
          if (!args.code) return { ok: true, default: defaultVoiceInfo() }
          try {
            return { ok: true, default: await setDefaultVoice(args.code, env) }
          } catch (error) {
            throw new SpeakError({ kind: 'param', summary: error.message, hint: '用 voice_voices 查编码' })
          }
        }
        if (args.engine === 'edge' || args.engine === 'ming') {
          const found = searchOtherVoices({ ...args }, env)
          return { ok: true, total: found.total, voices: found.voices.slice(0, args.limit ?? 12) }
        }
        return { ok: true, ...searchVoices({ ...args, limit: args.limit ?? 12 }) }
      }),
    }),

    tool({
      name: 'voice_speak',
      description: '语音合成，生成音频文件。默认用讯飞：返回实际读音，多音字标了拼音，要检查；读错就在字后加 [=拼音] 重新调用，如 调[=diao4]用。超拟人音色才有读音反馈和标注。已合成过的不重复扣量。用户要免费的，vcn 传 edge: 开头（微软，联网）或 ming: 开头（本机）的音色，它们不扣讯飞额度，但没有读音反馈。',
      parameters: {
        text: { type: 'string', required: true, description: '要合成的文字，可带 字[=拼音] 标注' },
        vcn: { type: 'string', description: '音色编码或名字。讯飞用原编码；Edge 如 edge:zh-CN-XiaoxiaoNeural，Ming 如 ming:灵小雅。不传用默认音色' },
        speed: { type: 'integer', description: '语速 0–100，默认 50' },
        pitch: { type: 'integer', description: '音调 0–100，默认 50' },
        volume: { type: 'integer', description: '音量 0–100，默认 50' },
        output: { type: 'string', description: '输出路径，相对当前工作目录。不传就放进 voice-output/' },
        format: { type: 'string', enum: ['mp3', 'wav'], description: '默认 mp3' },
      },
      render: renderSpeak,
      execute: guarded(async (args, exec) => {
        // Edge、Ming 免费，不用确认
        if (isOtherEngineVoice(args.vcn || defaultVoiceAny())) {
          const speed = args.speed === undefined ? 1 : Math.min(2, Math.max(0.5, 1 + (args.speed - 50) / 50))
          return speakAnyToFile({ voice: args.vcn || defaultVoiceAny(), text: args.text, speed, output: args.output, format: args.format, cwd: cwdOf(exec), signal: exec?.signal }, synthDeps)
        }
        const refused = await needConfirm(countChars(args.text ?? ''), exec, 'voice_speak')
        if (refused) return refused
        return speak({ ...args, cwd: cwdOf(exec), signal: exec?.signal }, synthDeps)
      }),
    }),

    tool({
      name: 'voice_project',
      description: '配音工程，用来做带字幕的成片。action：create 建工程；show 看文稿；edit 按句修改；diff 看哪些句子要重配；build 合成并导出音频和字幕（只重配变了的句子）；list 列出工程；relisten 把成品转写回来和原稿比较，查漏读多读，要消耗转写额度，用户同意才用。先读 S01 或 S03 的手册。',
      parameters: {
        action: { type: 'string', enum: ['create', 'show', 'edit', 'diff', 'build', 'list', 'relisten'], required: true },
        name: { type: 'string', description: '工程名' },
        sentences: { type: 'array', items: { type: 'string' }, description: 'create：断好的句子。按语义断句，推荐传这个' },
        text: { type: 'string', description: 'create：整段文稿，没传 sentences 时按标点切句' },
        vcn: { type: 'string', description: 'create、edit：工程默认音色' },
        speed: { type: 'integer', description: 'create、edit：整个工程的语速 0–100' },
        pitch: { type: 'integer', description: 'create、edit：整个工程的音调 0–100' },
        volume: { type: 'integer', description: 'create、edit：整个工程的音量 0–100' },
        gapMs: nullable('integer', 'create、edit：句间停顿毫秒数。不设就保留合成自带的停顿；设了会裁掉静音换成固定间隔，口播可以设 150 左右'),
        targetSeconds: { type: 'number', description: 'create、edit：目标时长，build 时检查' },
        glossary: { type: 'object', additionalProperties: true, description: 'create、edit：工程词表，确认过的读音，如 {"调用":"调[=diao4]用"}，自动用于所有句子；值传 null 删除' },
        edits: {
          type: 'array',
          description: 'edit：逐句修改。语速、音调、音量不能单独调一句，要改语气就改文字',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['set', 'delete', 'insert'], description: '默认 set；insert 插到 id 这句后面，不传 id 插到开头' },
              id: { type: 'string', description: '句子编号，如 s3' },
              text: { type: 'string' },
              vcn: nullable('string', '这句换一个角色的音色，null 恢复默认。不要用来调语气'),
              gapAfterMs: nullable('integer', '这句之后的停顿毫秒数'),
            },
            additionalProperties: false,
          },
        },
        formats: { type: 'array', items: { type: 'string', enum: SUBTITLE_FORMATS }, description: 'build：字幕格式，默认 srt' },
        audioFormat: { type: 'string', enum: ['mp3', 'wav'], description: 'build：默认 mp3' },
        karaoke: { type: 'boolean', description: 'build：ASS 逐字变色的卡点字幕' },
        portrait: { type: 'boolean', description: 'build：ASS 按竖屏 1080×1920 排版' },
        maxWidth: { type: 'integer', description: 'build：每条字幕最多多少个汉字宽，默认 18' },
      },
      render: renderProject,
      execute: guarded(async (args, exec) => {
        const cwd = cwdOf(exec)
        const input = { ...args, cwd }
        switch (args.action) {
          case 'list': return listProjects(input, synthDeps)
          case 'create': return createProject(input, synthDeps)
          case 'show': return showProject(input, synthDeps)
          case 'edit': return editProject(input, synthDeps)
          case 'diff': return diffProject(input, synthDeps)
          case 'relisten': {
            const shown = await showProject(input, synthDeps)
            if (!shown.lastBuild?.files?.audio) throw new SpeakError({ kind: 'param', summary: '这个工程还没有导出过', hint: '先用 action=build 导出' })
            const heard = await listen({ file: shown.lastBuild.files.audio, outputDir: join(shown.dir, 'relisten') }, exec)
            if (!heard.ok || heard.status === 'running') return { ...heard, relisten: true }
            const parsed = heard.empty ? { segments: [] } : JSON.parse(await readFile(heard.files.json, 'utf8'))
            return { ok: true, relisten: true, status: 'done', checked: shown.sentences.length, differences: compareToScript(shown.sentences, parsed.segments), cached: heard.cached }
          }
          case 'build': {
            const { newChars, spentChars, scriptChars } = await planBuild(input, synthDeps)
            const refused = await needConfirm(newChars, exec, 'voice_project')
            if (refused) return refused
            // 单次不超阈值，但反复修改累计花了很多：停下来问一次，防止循环扣费
            const budget = Math.max(settingsCached().confirmChars, scriptChars * SPEND_MULTIPLE)
            if (newChars && newChars <= settingsCached().confirmChars && spentChars + newChars > budget) {
              const res = await confirmSpend(ctx, exec, 'voice_project', `这个工程已累计合成 ${spentChars} 字（文稿只有 ${scriptChars} 字），这次还要 ${newChars} 字。确认继续吗？`)
              if (!res.allowed) return { ok: false, kind: 'rejected', error: '工程累计花费过多，没有继续合成', hint: res.hint }
            }
            return buildProject({ ...input, signal: exec?.signal }, synthDeps)
          }
          default:
            throw new SpeakError({ kind: 'param', summary: `不认识的操作：${args.action}`, hint: 'action 只能是 create、show、edit、diff、build、list、relisten' })
        }
      }),
    }),

    tool({
      name: 'voice_scene',
      description: '产品的 30 个固定场景。action=list 看清单；action=get 传 id 读手册，进入场景前先读；action=run 传 id 运行代码类场景（S08 朗读、S13 批量语音包、S14 音频转文字、S15 视频转字幕、S21 查音色、S22 多音色试音）。',
      parameters: {
        action: { type: 'string', enum: ['list', 'get', 'run'], required: true },
        id: { type: 'string', description: '场景编号，如 S13' },
        status: { type: 'string', enum: ['available', 'planned'], description: 'list 用：只看可用或计划中的' },
        text: { type: 'string', description: 'S08、S22：要合成的文字' },
        vcn: { type: 'string', description: 'S08、S13：音色' },
        voices: { type: 'array', items: { type: 'string' }, description: 'S22：要比较的音色，最多 5 个' },
        file: { type: 'string', description: 'S13：清单文件路径；S14、S15：音频或视频' },
        outputDir: { type: 'string', description: 'S13：输出目录' },
        output: { type: 'string', description: 'S08：输出路径' },
        format: { type: 'string', enum: ['mp3', 'wav'] },
        query: { type: 'string', description: 'S21：搜索词' },
        gender: { type: 'string', enum: ['male', 'female', 'child', 'unknown'] },
        lang: { type: 'string' },
      },
      render: renderScene,
      execute: guarded(async (args, exec) => {
        if (args.action === 'list') return { ok: true, scenes: listScenes({ status: args.status }) }
        if (args.action === 'get') {
          const scene = await getScene(args.id)
          if (!scene) throw new SpeakError({ kind: 'param', summary: `没有这个场景：${args.id}`, hint: '用 action=list 查看清单' })
          return { ok: true, scene }
        }
        const { action: _action, id, ...rest } = args
        const cwd = cwdOf(exec)
        const sceneId = String(id ?? '').toUpperCase()
        let chars = 0
        if (sceneId === 'S08') chars = countChars(rest.text ?? '')
        if (sceneId === 'S13') chars = (await planBatch({ file: rest.file, cwd, env })).chars
        const refused = await needConfirm(chars, exec, 'voice_scene')
        if (refused) return refused
        if (sceneId === 'S14' || sceneId === 'S15') return listen(rest, exec)
        return runScene(sceneId, { ...rest, cwd, signal: exec?.signal }, synthDeps)
      }),
    }),
  ]
}

export async function registerTools(ctx, deps = {}) {
  const defs = await buildToolDefinitions(ctx, deps)
  return defs.map((def) => ctx.tools.register(def))
}
