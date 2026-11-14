// lib/subtitle.js — 把原文和读音时间对齐，生成字幕
//
// 字幕显示的是原文，时间来自 rhy。两者不是一一对应的：
//   2024 读成 二零二四（1 个词对 4 个读音），CEO 是一个读音单元。
// 所以按「能对上的字」做锚点，对不上的一段整体分配时间。
// 没有 rhy（v2/tts）时按字数估算，并标明精度来源，不假装准确。

import { stripAnnotations } from './speak.js'

const TOKEN = /[一-鿿㐀-䶿]|[A-Za-z]+(?:['’-][A-Za-z]+)*|\d+(?:[.,:：]\d+)*%?|\s+|[^]/gu
const SEARCH_WINDOW = 24
const BREAK_AFTER = /^[，。！？；：、,!?;:…—\n.]$/
const OPENERS = /^[「『“‘《（(【\[]$/
const TRIM_END = /[，。、；：,.;:…—\s]+$/

const kindOf = (t) => {
  if (/^[一-鿿㐀-䶿]$/.test(t)) return 'cjk'
  if (/^[A-Za-z]/.test(t)) return 'word'
  if (/^\d/.test(t)) return 'number'
  if (/^\s+$/.test(t)) return 'space'
  return 'punct'
}

const isSpoken = (t) => t.kind === 'cjk' || t.kind === 'word' || t.kind === 'number'

export function tokenize(text) {
  return (stripAnnotations(text).match(TOKEN) ?? []).map((t) => ({ text: t, kind: kindOf(t) }))
}

const weightOf = (t) => (t.kind === 'cjk' ? 1 : t.kind === 'number' ? Math.max(1, t.text.length * 0.8) : Math.max(1, t.text.length * 0.45))

const sameText = (token, unit) => token.kind !== 'number' && token.text.toLowerCase() === String(unit.text).toLowerCase()

/** 一段时间按字数分给几个词 */
function spread(tokens, startMs, endMs) {
  const total = tokens.reduce((n, t) => n + weightOf(t), 0)
  let at = startMs
  tokens.forEach((t, i) => {
    const next = i === tokens.length - 1 ? endMs : at + ((endMs - startMs) * weightOf(t)) / total
    t.startMs = Math.round(at)
    t.endMs = Math.round(next)
    at = next
  })
}

/**
 * 在后面找下一处能对上的字，优先跳过最少的原文。
 * 先要求连续两个字都对上：「10:30，地点」读成「十点半地点」，只看一个字会把读音里的「点」错认成「地点」的「点」。
 * 句尾只剩一个字时才退回单字匹配。
 */
function findAnchor(spoken, units, i, j) {
  const matches = (ii, jj, strict) => {
    if (ii >= spoken.length || jj >= units.length || !sameText(spoken[ii], units[jj])) return false
    return !strict || (ii + 1 < spoken.length && jj + 1 < units.length && sameText(spoken[ii + 1], units[jj + 1]))
  }
  for (const strict of [true, false]) {
    for (let a = 0; a <= SEARCH_WINDOW; a += 1) {
      for (let b = 0; b <= SEARCH_WINDOW; b += 1) {
        if ((a || b) && matches(i + a, j + b, strict)) return { ii: i + a, jj: j + b }
      }
    }
  }
  return null
}

/**
 * 给每个要读的词填上 startMs、endMs。
 * missed：原文有、读音里没有的词（可能漏读）；extra：读音里有、原文对不上的单元（可能多读）；
 * lost：后面完全对不上，只能整段估算。
 */
export function alignTokens(tokens, units) {
  const spoken = tokens.filter(isSpoken)
  const report = { missed: [], extra: [], lost: false }
  let i = 0
  let j = 0
  let lastEnd = units[0]?.startMs ?? 0
  const assign = (from, to, unitFrom, unitTo) => {
    const group = spoken.slice(from, to)
    if (!group.length) return
    if (unitTo <= unitFrom) {
      for (const t of group) {
        t.startMs = lastEnd
        t.endMs = lastEnd
        report.missed.push(t.text)
      }
      return
    }
    spread(group, units[unitFrom].startMs, units[unitTo - 1].endMs)
    lastEnd = units[unitTo - 1].endMs
  }
  while (i < spoken.length) {
    if (j < units.length && sameText(spoken[i], units[j])) {
      assign(i, i + 1, j, j + 1)
      i += 1
      j += 1
      continue
    }
    const anchor = findAnchor(spoken, units, i, j)
    if (!anchor) {
      if (spoken.slice(i).some((t) => t.kind !== 'number') && j < units.length) report.lost = true
      assign(i, spoken.length, j, units.length)
      i = spoken.length
      j = units.length
      break
    }
    if (anchor.ii === i) {
      for (const u of units.slice(j, anchor.jj)) report.extra.push(u.text)
    } else {
      assign(i, anchor.ii, j, anchor.jj)
    }
    i = anchor.ii
    j = anchor.jj
  }
  for (const u of units.slice(j)) report.extra.push(u.text)
  return report
}

/** 没有读音信息时，把说话时段按字数分给每个词 */
export function estimateTokens(tokens, startMs, endMs) {
  const spoken = tokens.filter(isSpoken)
  if (spoken.length) spread(spoken, startMs, endMs)
}

/** 转写结果用：一个词的时间分给拆开的每个字，标点不占时间 */
export const spreadTime = estimateTokens

const widthOf = (t) => (t.kind === 'cjk' ? 1 : t.text.length * 0.55)

/** 超长的一小句按等宽切开，避免最后剩一两个字单独成行 */
function splitLong(group, maxWidth) {
  const total = group.reduce((n, t) => n + widthOf(t), 0)
  if (total <= maxWidth) return [group]
  const target = total / Math.ceil(total / maxWidth)
  const out = []
  let current = []
  let width = 0
  group.forEach((t) => {
    if (width >= target && t.kind !== 'punct' && t.kind !== 'space') {
      out.push(current)
      current = []
      width = 0
    }
    current.push(t)
    width += widthOf(t)
  })
  if (current.length) out.push(current)
  return out
}

/** 一句话切成若干条字幕，时间相对这句的音频开头 */
export function cuesFromTokens(tokens, { maxWidth = 18 } = {}) {
  const groups = []
  let current = []
  for (const t of tokens) {
    if (t.kind === 'punct' && OPENERS.test(t.text) && current.some(isSpoken)) {
      groups.push(current)
      current = []
    }
    current.push(t)
    if (t.kind === 'punct' && BREAK_AFTER.test(t.text)) {
      groups.push(current)
      current = []
    }
  }
  if (current.length) groups.push(current)

  // 「3.14」里的点已经在数字里，这里的点只会是句号；只有标点的一组并回前一条
  const merged = []
  for (const g of groups) {
    if (!g.some(isSpoken) && merged.length) merged[merged.length - 1].push(...g)
    else merged.push(g)
  }

  const cues = []
  for (const g of merged) {
    for (const piece of splitLong(g, maxWidth)) {
      const words = piece.filter(isSpoken)
      if (!words.length) continue
      const text = piece.map((t) => t.text).join('').replace(TRIM_END, '').trim()
      cues.push({
        text,
        startMs: words[0].startMs,
        endMs: words.at(-1).endMs,
        words: words.map((w) => ({ text: w.text, startMs: w.startMs, endMs: w.endMs })),
      })
    }
  }
  return cues
}

/** 字幕之间的小缝填上不闪烁，太短的延长一点，但不和下一条重叠 */
export function polishCues(cues, { holdGapMs = 240, minMs = 400 } = {}) {
  return cues.map((cue, i) => {
    const next = cues[i + 1]
    let end = cue.endMs
    if (next && next.startMs - end > 0 && next.startMs - end <= holdGapMs) end = next.startMs
    if (end - cue.startMs < minMs) end = next ? Math.min(cue.startMs + minMs, next.startMs) : cue.startMs + minMs
    return { ...cue, endMs: Math.max(end, cue.startMs) }
  })
}

// —— 导出格式 ——

const pad = (n, w = 2) => String(n).padStart(w, '0')

function clock(ms, sep) {
  const t = Math.max(0, Math.round(ms))
  return `${pad(Math.floor(t / 3600000))}:${pad(Math.floor(t / 60000) % 60)}:${pad(Math.floor(t / 1000) % 60)}${sep}${pad(t % 1000, 3)}`
}

function assClock(ms) {
  const cs = Math.max(0, Math.round(ms / 10))
  return `${Math.floor(cs / 360000)}:${pad(Math.floor(cs / 6000) % 60)}:${pad(Math.floor(cs / 100) % 60)}.${pad(cs % 100)}`
}

const oneLine = (text) => String(text).replace(/\s*\n\s*/g, ' ')

export const toSrt = (cues) => cues
  .map((c, i) => `${i + 1}\n${clock(c.startMs, ',')} --> ${clock(c.endMs, ',')}\n${oneLine(c.text)}\n`)
  .join('\n')

export const toVtt = (cues) => `WEBVTT\n\n${cues
  .map((c) => `${clock(c.startMs, '.')} --> ${clock(c.endMs, '.')}\n${oneLine(c.text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}\n`)
  .join('\n')}`

const assText = (text) => oneLine(text).replace(/\\/g, '＼').replace(/\{/g, '｛').replace(/\}/g, '｝')

/** 卡点字幕：每个词一个 \k，读到哪个词哪个词变色 */
function karaokeLine(cue) {
  const tokens = cue.text.match(TOKEN) ?? []
  let wordIndex = 0
  let out = ''
  let cursor = cue.startMs
  for (const t of tokens) {
    const word = cue.words[wordIndex]
    if (word && isSpoken({ kind: kindOf(t) })) {
      const lead = Math.round((word.startMs - cursor) / 10)
      if (lead > 0) out += `{\\k${lead}}`
      const next = cue.words[wordIndex + 1]
      const end = next ? next.startMs : Math.max(word.endMs, cue.endMs)
      out += `{\\kf${Math.max(1, Math.round((end - word.startMs) / 10))}}${assText(t)}`
      cursor = end
      wordIndex += 1
    } else {
      out += assText(t)
    }
  }
  return out
}

export function toAss(cues, { karaoke = false, portrait = false } = {}) {
  const [w, h] = portrait ? [1080, 1920] : [1920, 1080]
  const size = portrait ? 72 : 64
  const marginV = portrait ? 420 : 60
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // 卡点时：SecondaryColour 是还没读到的颜色，PrimaryColour 是读到后的颜色
    `Style: Default,PingFang SC,${size},${karaoke ? '&H0000D7FF' : '&H00FFFFFF'},&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,3,1,2,60,60,${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...cues.map((c) => `Dialogue: 0,${assClock(c.startMs)},${assClock(c.endMs)},Default,,0,0,0,,${karaoke ? karaokeLine(c) : assText(c.text)}`),
    '',
  ].join('\n')
}
