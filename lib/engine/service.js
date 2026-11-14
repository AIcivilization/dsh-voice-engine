// lib/engine/service.js — 给别的 DSH 插件用的服务：voiceEngine
//
//   ctx.inject(['voiceEngine'], async (c) => {
//     const { audio, format } = await c.voiceEngine.speak('你好', { voice: 'edge:zh-CN-XiaoxiaoNeural' })
//   })
//
// 和本机 HTTP 接口规则一样：用户在设置页没勾选的来源不能用。讯飞会扣用户的额度，还要用户另外打开「允许别的产品用讯飞」。

import { openEnginesCached, settingsCached } from '../config.js'
import { SpeakError } from '../speak.js'
import { defaultVoiceAny } from '../voices.js'
import { closedEngine, engineStatusOpen, listAllVoices, parseVoice, synthesizeAny } from './index.js'

export function createVoiceService(deps = {}) {
  const env = deps.env ?? process.env
  return {
    /** @returns {Promise<{ audio: Buffer, format: string, contentType: string, engine: string, voice: string, name: string, durationMs: number|null, charged: number, cached: boolean, warnings: string[] }>} */
    async speak(text, { voice, speed = 1, format = 'mp3' } = {}) {
      const parsed = parseVoice(voice || defaultVoiceAny())
      const closed = closedEngine(parsed.engine)
      if (closed) throw new SpeakError(closed)
      if (parsed.engine === 'xfyun') {
        if ([...String(text ?? '')].length > settingsCached().confirmChars) {
          throw new SpeakError({ kind: 'too-long', summary: `讯飞一次最多 ${settingsCached().confirmChars} 字`, hint: '请分段' })
        }
      }
      return synthesizeAny({ voice, text, speed, format }, deps)
    },
    voices: (filter = {}) => listAllVoices({ ...filter, only: openEnginesCached() }, env),
    engines: () => engineStatusOpen(env),
  }
}
