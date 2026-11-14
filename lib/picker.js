// lib/picker.js — 模型请用户选音色：候选发到界面，用户试听后点选，选择发回对话
//
// 模型听不到声音，这一步必须交给人。候选按对话存放，界面轮询取走。

import { describeOtherVoice, engineStatus } from './engine/index.js'
import { findOtherVoice } from './engine/catalog.js'
import { describeVoice, findVoice } from './voices.js'

const EXPIRE_MS = 30 * 60 * 1000
const pending = new Map()

export function presentVoices(sessionId, { codes, question, sampleText }, now = Date.now) {
  const key = String(sessionId ?? '')
  if (!key) throw new Error('拿不到当前对话')
  const status = engineStatus()
  const voices = (codes ?? []).map((code) => {
    if (findVoice(code)) return describeVoice(findVoice(code))
    const other = findOtherVoice(code)
    return other ? describeOtherVoice(other.engine, other.voice, status[other.engine]) : null
  }).filter(Boolean)
  if (!voices.length) throw new Error('这些编码在目录里都找不到，先用 voice_voices 查')
  const entry = { id: `${now()}`, voices, question: question ?? '', sampleText: sampleText ?? '', at: now() }
  pending.set(key, entry)
  return entry
}

export function pendingVoices(sessionId, now = Date.now) {
  const key = String(sessionId ?? '')
  const entry = pending.get(key)
  if (!entry) return null
  if (now() - entry.at > EXPIRE_MS) {
    pending.delete(key)
    return null
  }
  return entry
}

const openRequests = new Map()

/** 请界面打开音色库。界面轮询时取走，只生效一次 */
export function requestLibrary(sessionId, query = '') {
  const key = String(sessionId ?? '')
  if (key) openRequests.set(key, { query: String(query ?? '').trim() })
  return Boolean(key)
}

export function takeLibraryRequest(sessionId) {
  const key = String(sessionId ?? '')
  const request = openRequests.get(key) ?? null
  openRequests.delete(key)
  return request
}

export function clearPicker(sessionId) {
  pending.delete(String(sessionId ?? ''))
}
