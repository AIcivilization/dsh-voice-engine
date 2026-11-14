// lib/index.js — 插件入口
//
// 挂载要点（照 dsh-vps-manager）：
//   - tools 是硬依赖，没有它这个插件没有意义
//   - skills、systemPrompt、commands、connection 都是可选宿主服务，一律经 ctx.inject 延迟注册：
//     没声明就直接读 ctx.skills 会抛异常；服务缺席时回调不执行，插件照常激活
//   - 任何一处注册失败只降级，绝不阻断插件加载，但一定要写进日志和 /voice-doctor

import { readFile } from 'node:fs/promises'
import { registerCommands } from './commands.js'
import { loadState } from './config.js'
import { routingPrompt, voiceGuard } from './guard.js'
import { markPart } from './health.js'
import { onLangChange } from './i18n.js'
import { registerRoutes } from './routes.js'
import { registerTools } from './tools.js'
import { applyEngineSettings, engineServerInfo, stopEngineServer } from './engine/server.js'
import { stopMing } from './engine/ming.js'
import { createVoiceService } from './engine/service.js'

export const name = 'dsh-voice-engine'
export const inject = ['tools']

const SKILL_NAME = 'voice-engine'
const PROMPT_ORDER = 2500 // 排在 DSH 自带工具说明之后

// 插件市场会热挂载一份、profile 又加载一份。第二份注册时会撞车，让它让路（dsh-vps-manager 实测过）
const RUNNING = Symbol.for('dsh-voice-engine.running')
export function _resetInstanceGuard() {
  delete globalThis[RUNNING]
}

function warn(ctx, message, error) {
  const text = `[dsh-voice-engine] ${message}${error ? `：${error.message ?? error}` : ''}`
  if (ctx?.logger?.warn) ctx.logger.warn(text)
  else console.warn(text)
}

function track(scoped, dispose, label) {
  try {
    scoped.effect?.(() => dispose, label)
  } catch {
    // 老版本 cordis 没有 effect
  }
}

export async function registerSkill(skillCtx) {
  const content = await readFile(new URL('./skills/voice-engine.md', import.meta.url), 'utf8')
  return skillCtx.skills.register({
    name: SKILL_NAME,
    // source 在加载时还会校验一遍，漏了注册成功、模型一读就报错（dsh-vps-manager 实测过）
    source: 'runtime',
    description: '声音引擎：用讯飞、Edge、Ming 朗读、配音、选音色和转写；怎么检查和改正读音、30 个场景',
    whenToUse: '用户要朗读、语音合成、配音、试音色、选音色或转写音频视频时，在调用 voice_* 工具之前先读',
    content,
    invocation: { modelInvocable: true, userInvocable: false },
  })
}

export function apply(ctx, config = {}) {
  const running = globalThis[RUNNING]
  if (running && !running.released) {
    warn(ctx, '同一个 DSH 里已经有一份本插件在运行，这一份不再重复注册')
    return
  }
  const instance = { released: false }
  globalThis[RUNNING] = instance
  track(ctx, () => {
    instance.released = true
    if (globalThis[RUNNING] === instance) delete globalThis[RUNNING]
  }, 'dsh-voice-engine: single instance')

  const deps = { env: process.env, ...config }
  const ok = (part, detail = '') => markPart(part, true, detail)
  const fail = (part, message, error) => {
    markPart(part, false, error?.message ?? String(error ?? message))
    warn(ctx, message, error)
  }

  // 对外接口在状态读完之后再起：要看设置里开没开
  loadState(deps.env)
    .catch((error) => warn(ctx, '读取插件状态失败', error))
    .then(() => applyEngineSettings(deps))
    .then(() => ok('engine', engineServerInfo().running ? engineServerInfo().url : '设置里关掉了'))
    .catch((error) => fail('engine', '声音引擎接口没起来（插件其他功能不受影响）', error))
  track(ctx, () => {
    stopEngineServer().catch(() => {})
    stopMing()
  }, 'dsh-voice-engine: engine')

  // 别的 DSH 插件直接用：ctx.inject(['voiceEngine'], (c) => c.voiceEngine.speak('你好'))。做法照 dsh-her 的 herVoices
  if (typeof ctx.provide === 'function') {
    const provide = () => {
      try {
        return ctx.provide('voiceEngine', createVoiceService(deps))
      } catch (error) {
        fail('service', '没能把声音引擎开放给别的插件', error)
        return () => {}
      }
    }
    if (typeof ctx.effect === 'function') ctx.effect(provide, 'dsh-voice-engine: voiceEngine')
    else provide()
    // 用别的插件的方式取一次，确认真的能取到
    ctx.inject?.(['voiceEngine'], (used) => {
      const svc = used.voiceEngine ?? used.get?.('voiceEngine')
      if (typeof svc?.speak === 'function') ok('service', 'voiceEngine')
      else markPart('service', false, '取到的服务不对')
    })
  } else {
    markPart('service', false, '这个版本的 DSH 不能开放服务给别的插件')
  }

  registerTools(ctx, deps)
    .then((registered) => ok('tools', String(registered.length)))
    .catch((error) => fail('tools', '工具注册失败', error))

  try {
    if (typeof ctx.tools?.guard === 'function') {
      ctx.tools.guard(voiceGuard)
      ok('guard')
    } else {
      markPart('guard', false, 'DSH 没有提供 tools.guard')
    }
  } catch (error) {
    fail('guard', '优先路由拦截注册失败', error)
  }

  if (typeof ctx.inject !== 'function') return

  ctx.inject(['systemPrompt'], (promptCtx) => {
    try {
      promptCtx.systemPrompt.section({ name: 'dsh-voice-engine:routing', order: PROMPT_ORDER, interpolate: false, text: () => routingPrompt() })
      ok('prompt')
    } catch (error) {
      fail('prompt', '优先路由规则注册失败', error)
    }
  })

  ctx.inject(['skills'], (skillCtx) => {
    registerSkill(skillCtx)
      .then(() => ok('skill', SKILL_NAME))
      .catch((error) => fail('skill', 'skill 注册失败', error))
  })

  // 命令说明是登记时交给 DSH 的固定文字，界面换了语言就整组重新登记（同 dsh-vps-manager）
  ctx.inject(['commands'], (cmdCtx) => {
    let current = null
    const mount = () => {
      try {
        current?.()
      } catch {
        // 旧的撤不掉也照样登记新的
      }
      current = null
      try {
        current = registerCommands(cmdCtx, deps)
        ok('commands', String(current.count))
      } catch (error) {
        fail('commands', '命令注册失败', error)
      }
    }
    mount()
    const off = onLangChange(mount)
    track(cmdCtx, () => {
      off()
      current?.()
    }, 'dsh-voice-engine: commands')
  })

  ctx.inject(['connection'], (connCtx) => {
    const fetchApi = connCtx.connection?.fetch ?? connCtx.get?.('connection')?.fetch
    if (!fetchApi || typeof fetchApi.register !== 'function') {
      markPart('routes', false, 'DSH 没有提供 connection.fetch，设置页不可用')
      return
    }
    try {
      track(connCtx, registerRoutes(fetchApi, deps), 'dsh-voice-engine: routes')
      ok('routes')
    } catch (error) {
      fail('routes', '界面接口注册失败（设置页不可用，工具和命令不受影响）', error)
    }
  })
}

export default { name, inject, apply }
