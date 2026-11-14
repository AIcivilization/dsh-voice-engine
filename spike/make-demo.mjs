#!/usr/bin/env node
// spike/make-demo.mjs — 不调接口，用已有结果生成两样东西：
//   out/demo.srt        超拟人整段合成的字幕，配合 out/q2-hyper-whole.wav 拖进剪映检验
//   judge-prompt.txt    读音判断题，贴进 dsh 对话，看模型能否靠拼音发现读错

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseRhy } from './xf.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out')
const PARAGRAPH = '欢迎收听今天的节目。人工智能正在改变我们的工作方式，也在改变我们讲故事的方式。过去，做一条配音要反复录制；现在，改一句文案，只需要重新生成这一句。这听起来很简单，真正难的是让每句话都自然衔接。接下来，我们用三个例子说明这件事。'

const clock = (ms) => {
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`
}

/** 按标点切成字幕行，时间取这一行第一个字的开始和最后一个字的结束 */
export function toSrt(text, units) {
  const cues = []
  let index = 0
  for (const phrase of text.match(/[^，。；！？]+[，。；！？]?/g) ?? []) {
    const chars = [...phrase.replace(/[，。；！？]/g, '')]
    const first = units[index]
    const last = units[index + chars.length - 1]
    if (units.slice(index, index + chars.length).map((u) => u.text).join('') !== chars.join('')) {
      throw new Error(`字幕和音素对不上：${phrase}`)
    }
    cues.push({ text: chars.join(''), startMs: first.startMs, endMs: last.endMs })
    index += chars.length
  }
  return cues.map((c, i) => `${i + 1}\n${clock(c.startMs)} --> ${clock(c.endMs)}\n${c.text}\n`).join('\n')
}

const whole = parseRhy(readFileSync(join(OUT, 'q2-hyper-whole.rhy.txt'), 'utf8'))
writeFileSync(join(OUT, 'demo.srt'), toSrt(PARAGRAPH, whole.units))

// —— 读音判断题 ——
const line = (file, change) => {
  const { units } = parseRhy(readFileSync(join(OUT, file), 'utf8'))
  return units.map((u, i) => `${u.text}[${change?.[i] ?? u.pinyin ?? '英文'}]`).join(' ')
}
const firstIndex = (file, char, nth = 0) => {
  const { units } = parseRhy(readFileSync(join(OUT, file), 'utf8'))
  return units.map((u, i) => (u.text === char ? i : -1)).filter((i) => i >= 0)[nth]
}

const items = [
  ['我在重庆的银行工作，每天行走在长江边。', line('q1-0.rhy.txt', { [firstIndex('q1-0.rhy.txt', '行', 0)]: 'xing2' })], // 人为改错：银行
  ['他还没还钱，这首音乐让人快乐。', line('q1-1.rhy.txt')], // 正确
  ['这个重要的包裹很重。', line('q1-2.rhy.txt')], // 正确，含变调
  ['长大后他成了校长，头发却越来越长。', line('q1-3.rhy.txt', { [firstIndex('q1-3.rhy.txt', '长', 2)]: 'zhang3' })], // 人为改错：越来越长
  ['朝阳区的朝阳很美，他朝着单位走去。', line('q1-4.rhy.txt')], // 真实读错：朝阳（早晨的太阳）
  ['CEO说AI的API调用量翻了一倍。', line('q1-6.rhy.txt')], // 正确，含变调「一倍」
]

const prompt = `下面是语音合成引擎实际读出的拼音（数字是声调，5 是轻声）。请逐句检查有没有读错的字。

判断规则：
- 只报告真正读错的字，比如多音字选错了读音
- 连续三声变调和「一」「不」的变调属于正常现象，不算错误
- 不确定的字说明理由，不要猜

输出格式：每句一行，写「句 N：无错误」或「句 N：某字应读某音，实际读某音」。

${items.map(([text, py], i) => `句 ${i + 1}：${text}\n拼音：${py}`).join('\n\n')}
`
writeFileSync(join(HERE, 'judge-prompt.txt'), prompt)
console.log(readFileSync(join(OUT, 'demo.srt'), 'utf8'))
console.log('-----\n' + prompt)
