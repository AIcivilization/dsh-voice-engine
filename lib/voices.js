// lib/voices.js — 音色目录和当前账号的授权状态
//
// 目录（data/catalog.json）说明「有这个音色」，不说明「这个账号能用」。
// 能不能用只认真实调用的结果，记在 state.voices 里：ok / denied，没试过就是 unknown。

import { readFileSync } from 'node:fs'
import { getState, settingsCached, sourceOnCached, sourcesOnCached, updateSettings } from './config.js'
import { OTHER_VOICES, findOtherVoice, otherCode } from './engine/catalog.js'

const read = (name) => JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8'))

export const CATALOG = read('catalog.json')
export const POLYPHONES = new Set(read('polyphones.json'))
const BY_CODE = new Map(CATALOG.map((v) => [v.code, v]))

/** 官方标注的免费音色排在前面，诊断和默认音色都从这里选 */
export const PREFERRED_HYPER = ['x5_lingxiaoxuan_flow', 'x6_lingxiaoxuan_pro', 'x5_lingxiaotang_flow', 'x5_lingyuzhao_flow', 'x6_lingfeiyi_pro']
export const V2_PROBE = 'xiaoyan'

export const findVoice = (code) => BY_CODE.get(code) ?? null

export function voiceStatus(code, state = getState()) {
  return state.voices[code]?.status ?? 'unknown'
}

/** 目录里没有的编码：超拟人有明显的命名特征，其余按 v2 处理 */
export function engineOf(code) {
  const known = BY_CODE.get(code)?.engine
  if (known) return known
  return /^x\d_.*_(flow|pro|mini|oral|emo|assist)/i.test(code) ? 'hyper' : 'v2'
}

/** 模型可能传名字：优先选已授权的那个同名音色 */
export function resolveVoice(input, state = getState()) {
  const text = String(input ?? '').trim()
  if (!text) return null
  if (BY_CODE.has(text)) return text
  const same = CATALOG.filter((v) => v.engine && (v.name === text || v.aliases?.includes(text)))
  if (!same.length) return text
  return (same.find((v) => voiceStatus(v.code, state) === 'ok') ?? same.find((v) => v.engine === 'hyper') ?? same[0]).code
}

/** 讯飞用的默认音色。默认音色设成了 Edge、Ming 时，讯飞自己的功能（配音工程、读音检查）仍用声音引擎 */
export function defaultVoice(state = getState()) {
  const configured = settingsCached().defaultVcn
  if (configured && !findOtherVoice(configured)) return configured
  return PREFERRED_HYPER.find((code) => voiceStatus(code, state) === 'ok') ?? PREFERRED_HYPER[0]
}

export function knownOkVoices(engine, state = getState()) {
  return Object.entries(state.voices)
    .filter(([code, v]) => v.status === 'ok' && engineOf(code) === engine)
    .map(([code]) => code)
}

const RANK = { ok: 0, unknown: 1, denied: 2 }

/** 给模型和界面共用的搜索。未授权的排在后面但不隐藏，方便告诉用户去开通 */
export function searchVoices({ query, gender, lang, dialect, scene, engine, status, sample, limit = 12 } = {}, state = getState()) {
  if (!sourceOnCached('xfyun')) return { total: 0, voices: [], off: true } // 用户没勾选讯飞
  const q = String(query ?? '').trim().toLowerCase()
  const rows = CATALOG.filter((v) => {
    if (!v.engine) return false // 没有编码的音色调不了接口，不提供给模型
    if (gender && v.gender !== gender) return false
    if (lang && v.lang !== lang) return false
    if (dialect && !(v.dialect ?? '').includes(dialect)) return false
    if (scene && !(v.scene ?? '').includes(scene)) return false
    if (engine && v.engine !== engine) return false
    if (status && voiceStatus(v.code, state) !== status) return false
    if (sample && !v.sample) return false
    if (!q) return true
    return (
      v.name.toLowerCase().includes(q)
      || v.code.toLowerCase().includes(q)
      || v.py.includes(q)
      || (v.pyi && v.pyi === q)
      || (v.aliases ?? []).some((a) => a.toLowerCase().includes(q))
      || (v.scene ?? '').includes(q)
      || (v.style ?? '').includes(q)
      || (v.dialect ?? '').includes(q)
    )
  })
  rows.sort((a, b) => RANK[voiceStatus(a.code, state)] - RANK[voiceStatus(b.code, state)]
    || Number(b.engine === 'hyper') - Number(a.engine === 'hyper')
    || Number(a.name === a.code) - Number(b.name === b.code))
  return { total: rows.length, voices: rows.slice(0, limit).map((v) => describeVoice(v, state)) }
}

export function describeVoice(v, state = getState()) {
  return {
    code: v.code,
    name: v.name,
    engine: v.engine,
    gender: v.gender,
    lang: v.lang,
    ...(v.dialect ? { dialect: v.dialect } : {}),
    ...(v.scene ? { scene: v.scene } : {}),
    ...(v.style ? { style: v.style } : {}),
    hasSample: Boolean(v.sample),
    status: voiceStatus(v.code, state),
  }
}

/** 筛选项：只列目录里真有的语种和方言，带数量 */
export function voiceFacets() {
  const count = (pick) => {
    const seen = new Map()
    for (const v of CATALOG) {
      const value = v.engine ? pick(v) : null
      if (value) seen.set(value, (seen.get(value) ?? 0) + 1)
    }
    return [...seen].sort((a, b) => b[1] - a[1]).map(([value, n]) => ({ value, count: n }))
  }
  return { langs: count((v) => v.lang), dialects: count((v) => v.dialect) }
}

export const usableTotal = () => CATALOG.filter((v) => v.engine).length
export const hyperTotal = () => CATALOG.filter((v) => v.engine === 'hyper').length

/** 用户选的默认音色，哪家都可以；没选就是讯飞的默认音色。那一家没勾选时换成勾选了的 */
export function defaultVoiceAny() {
  const wanted = settingsCached().defaultVcn || defaultVoice()
  const engine = findOtherVoice(wanted)?.engine ?? 'xfyun'
  if (sourceOnCached(engine)) return wanted
  // 默认音色那家没勾选：换成勾选了的第一家，免得不指定音色时每次都报错
  const next = sourcesOnCached()[0]
  if (!next) return wanted
  return next === 'xfyun' ? defaultVoice() : otherCode(next, OTHER_VOICES[next][0])
}

export function defaultVoiceInfo() {
  const code = defaultVoiceAny()
  const other = findOtherVoice(code)
  return { code, name: other?.voice.name ?? findVoice(code)?.name ?? code, engine: other?.engine ?? 'xfyun', chosen: Boolean(settingsCached().defaultVcn) && code === settingsCached().defaultVcn }
}

/** 设默认音色：名字和编码都行；空的表示恢复自动选择。目录里没有的不接受，免得之后每次合成都报错 */
export async function setDefaultVoice(input, env = process.env) {
  const text = String(input ?? '').trim()
  if (!text) {
    await updateSettings({ defaultVcn: '' }, env)
    return defaultVoiceInfo()
  }
  const code = resolveVoice(text)
  const other = findVoice(code)?.engine ? null : findOtherVoice(text)
  if (!findVoice(code)?.engine && !other) throw new Error(`目录里没有这个音色：${text}`)
  await updateSettings({ defaultVcn: other ? otherCode(other.engine, other.voice) : code }, env)
  return defaultVoiceInfo()
}

export const STATUS_LABEL = { ok: '可用', denied: '未授权', unknown: '未试过' }
