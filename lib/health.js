// lib/health.js — 插件各部分的注册结果，/voice-doctor 和设置页都看这里
//
// DSH 还在快速迭代，某个接口一变，插件的某一块就会悄悄失效。把结果记下来才查得到。

const parts = {}

export function markPart(name, ok, detail = '') {
  parts[name] = { ok: Boolean(ok), detail: String(detail ?? '').slice(0, 300), at: new Date().toISOString() }
}

export const partsSnapshot = () => ({ ...parts })

export function _resetParts() {
  for (const key of Object.keys(parts)) delete parts[key]
}
