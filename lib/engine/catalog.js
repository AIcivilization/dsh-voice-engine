// lib/engine/catalog.js — 讯飞以外的音色：Edge、Ming
//
// 编号统一写成「引擎:声音」，如 edge:zh-CN-XiaoxiaoNeural、ming:灵小雅。
// 讯飞的音色仍然用原来的编码（x6_lingfeihan_pro），也可以写成 xfyun:x6_lingfeihan_pro。

import { EDGE_VOICES } from './edge.js'
import { MING_VOICES } from './ming.js'

export const ENGINE_IDS = ['xfyun', 'edge', 'ming']
export const OTHER_VOICES = { edge: EDGE_VOICES, ming: MING_VOICES }

export const ENGINE_INFO = {
  xfyun: { name: '讯飞', cost: 'paid', network: true, readings: true, note: '扣讯飞字符量；超拟人音色返回读音，模型能自己查错改错' },
  edge: { name: 'Edge', cost: 'free', network: true, readings: false, note: '免费，要联网，文字发到微软；不是微软的正式接口，可能失效' },
  ming: { name: 'Ming', cost: 'free', network: false, readings: false, note: '免费，在本机合成，不联网；只支持 Apple 芯片的 Mac，第一次要加载模型' },
}

/** 「edge:xxx」这类带引擎前缀的编号；不带前缀返回 null */
export function splitVoiceId(input) {
  const m = String(input ?? '').trim().match(/^(xfyun|edge|ming):(.+)$/i)
  return m ? { engine: m[1].toLowerCase(), id: m[2].trim() } : null
}

/** 在 Edge、Ming 里找：带前缀的按编号，不带前缀的按名字或声音名 */
export function findOtherVoice(input) {
  const text = String(input ?? '').trim()
  if (!text) return null
  const split = splitVoiceId(text)
  if (split) {
    const list = OTHER_VOICES[split.engine]
    const voice = list?.find((v) => v.id === split.id || v.name === split.id)
    return voice ? { engine: split.engine, voice } : null
  }
  for (const [engine, list] of Object.entries(OTHER_VOICES)) {
    const voice = list.find((v) => v.id === text || v.name === text)
    if (voice) return { engine, voice }
  }
  return null
}

export const otherCode = (engine, voice) => `${engine}:${voice.id}`

/** 试听用的句子：跟着声音的语种走 */
export const trialTextFor = (lang) => (lang === 'en' ? 'Hello, this is my voice.' : lang === 'yue' ? '你好，呢个系我嘅声音。' : '你好，这是我的声音。')
