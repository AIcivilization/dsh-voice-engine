// lib/xf/rhy.js — 解析超拟人 rhy=1 返回的拼音标注
//
// 官方文档只给了一个示例，下面这些写法都是实测到的（spike/M0-验证报告.md）：
//   sil:24;你[=ni2]-n2:8;@-i2:16;好[=hao3]*-h3:24;@-ao3:36;sil:116;
//   CEO*-s:32;@-iy:44;@*-iy:16;{0:38}@*-ow:36;      英文缩写是一个单元
//   五[=wu3]*-u3:52;{0:63}@-sp3:68;                  句中停顿写成音素
// 不认识的片段放进 unparsed，绝不悄悄丢掉；时长照样计入，否则后面的时间全部错位。

export const FRAME_MS = 5 // 1 帧 5ms：实测音素合计和音频时长偏差 0ms

export function parseRhy(text) {
  const units = []
  const pauses = []
  const unparsed = []
  let frames = 0
  let current = null
  const ms = () => frames * FRAME_MS

  for (const raw of String(text ?? '').split(';')) {
    let token = raw.replace(/\{[^}]*\}/g, '').trim()
    if (token.startsWith('*')) token = token.slice(1).trim()
    if (!token) continue

    let m = token.match(/^(sil|sp):(\d+)$/)
    if (m) {
      const n = Number(m[2])
      pauses.push({ kind: m[1], startMs: ms(), endMs: ms() + n * FRAME_MS })
      frames += n
      current = null
      continue
    }
    m = token.match(/^@\*?-(.+):(\d+)$/)
    if (m && current) {
      const n = Number(m[2])
      if (/^sp\d*$/.test(m[1])) {
        pauses.push({ kind: 'sp', startMs: ms(), endMs: ms() + n * FRAME_MS })
        frames += n
        continue
      }
      frames += n
      current.endMs = ms()
      continue
    }
    m = token.match(/^(.+?)(?:\[=([^\]]+)\])?\*?-([^-]+):(\d+)$/)
    if (m) {
      const n = Number(m[4])
      current = { text: m[1], pinyin: m[2] ?? null, startMs: ms(), endMs: ms() + n * FRAME_MS }
      frames += n
      units.push(current)
      continue
    }
    unparsed.push(token)
    m = token.match(/:(\d+)$/)
    if (m) frames += Number(m[1])
  }
  return { units, pauses, unparsed, totalMs: ms() }
}

/** 开口和收声的时刻：首尾的 sil 不算说话 */
export function speechSpan(parsed) {
  if (!parsed?.units?.length) return null
  return { startMs: parsed.units[0].startMs, endMs: parsed.units.at(-1).endMs }
}

/**
 * 给模型看的读音：只标多音字，其余只保留文字。
 * 数字和英文按实际读出来的样子显示，比如 2024 显示成「二零二四」。
 */
export function inlineReadings(units, polyphones) {
  return units
    .map((u) => (u.pinyin && polyphones.has(u.text) ? `${u.text}[${u.pinyin}]` : u.text))
    .join('')
}
