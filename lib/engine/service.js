// lib/engine/service.js — 给别的 DSH 插件用的服务：voiceEngine
//
//   ctx.inject(['voiceEngine'], async (c) => {
//     const { audio, format } = await c.voiceEngine.speak('你好', { voice: 'edge:zh-CN-XiaoxiaoNeural' })
//   })
//
// 和本机 HTTP 接口规则一样：讯飞会扣用户的额度，用户没在设置里打开「允许别的产品用讯飞」时不能用。

import { settingsCached } from '../config.js'
import { SpeakError } from '../speak.js'
import { engineStatus, listAllVoices, parseVoice, synthesizeAny } from './index.js'

export function createVoiceService(deps = {}) {
  const env = deps.env ?? process.env
  return {
    /** @returns {Promise<{ audio: Buffer, format: string, contentType: string, engine: string, voice: string, name: string, durationMs: number|null, charged: number, cached: boolean, warnings: string[] }>} */
    async speak(text, { voice, speed = 1, format = 'mp3' } = {}) {
      const parsed = parseVoice(voice || settingsCached().defaultVcn || '')
      if (parsed.engine === 'xfyun') {
        if (!settingsCached().engineAllowXfyun) {
          throw new SpeakError({ kind: 'xfyun-closed', summary: '讯飞会扣用户的额度，现在没有对外开放', hint: '请用户到「设置 → 声音引擎 → 声音引擎接口」打开；或者换 edge:、ming: 开头的免费音色' })
        }
        if ([...String(text ?? '')].length > settingsCached().confirmChars) {
          throw new SpeakError({ kind: 'too-long', summary: `讯飞一次最多 ${settingsCached().confirmChars} 字`, hint: '请分段' })
        }
      }
      return synthesizeAny({ voice, text, speed, format }, deps)
    },
    voices: (filter = {}) => listAllVoices(filter, env),
    engines: () => {
      const status = engineStatus(env)
      status.xfyun.open = settingsCached().engineAllowXfyun
      return status
    },
  }
}
