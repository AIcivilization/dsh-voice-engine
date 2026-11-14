// lib/i18n.js — 给人看的文字跟着 DSH 界面语言走（写法同 dsh-vps-manager）
//
// 界面在每个请求里带当前语言，服务端处理这个请求时照它说；没有请求可依的场合（命令输出）
// 用最近一次请求的语言，一次都没有就看系统语言。
// 给模型看的工具结果和 skill 固定用中文：它们是操作说明，不是界面。

import { AsyncLocalStorage } from 'node:async_hooks'

export const LANG_HEADER = 'x-dsh-voice-engine-lang'

const store = new AsyncLocalStorage()
let lastLang = ''

export function normalizeLang(value) {
  const s = String(value ?? '').trim().toLowerCase()
  if (!s) return ''
  return s === 'zh' || s.startsWith('zh-') || s.startsWith('zh_') ? 'zh' : 'en'
}

export function systemLang(env = process.env) {
  const fromEnv = env.LC_ALL || env.LC_MESSAGES || env.LANG || ''
  if (fromEnv && !/^(C|POSIX)(\.|$)/i.test(fromEnv)) return normalizeLang(fromEnv)
  try {
    return normalizeLang(Intl.DateTimeFormat().resolvedOptions().locale) || 'zh'
  } catch {
    return 'zh'
  }
}

export function currentLang() {
  return store.getStore() || lastLang || normalizeLang(process.env.DSH_XFYUN_LANG) || systemLang()
}

const listeners = new Set()

/** 界面语言变化时通知：命令说明是登记时定死的文字，要整组重新登记 */
export function onLangChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function withLang(value, fn) {
  const lang = normalizeLang(value)
  if (!lang) return fn()
  const changed = lang !== lastLang
  lastLang = lang
  return store.run(lang, () => {
    if (changed) for (const listener of listeners) listener()
    return fn()
  })
}

export const L = (zh, en) => (currentLang() === 'zh' ? zh : en)
