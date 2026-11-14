#!/usr/bin/env node
// spike/fix-test.mjs — 模型发现读错后，能不能让引擎改过来
//
// 严格对照：复现真实读错的原句；再故意标错误读音，引擎照读才算标注真的生效。
// 每句跑两遍，看同样的输入结果是否稳定。

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hyperSynth, loadCredentials, parseRhy } from './xf.mjs'

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out')
const creds = loadCredentials()
const RUNS = 2

const CASES = [
  { name: '原句 调用', text: 'CEO说AI的API调用量翻了一倍。', char: '调', nth: 0, want: 'diao4' },
  { name: '标注 调用', text: 'CEO说AI的API调[=diao4]用量翻了一倍。', char: '调', nth: 0, want: 'diao4' },
  { name: '原句 朝阳', text: '朝阳区的朝阳很美，他朝着单位走去。', char: '朝', nth: 1, want: 'zhao1' },
  { name: '标注 朝阳', text: '朝阳区的朝[=zhao1]阳很美，他朝着单位走去。', char: '朝', nth: 1, want: 'zhao1' },
  { name: '故意标错 银行→xing2', text: '银行[=xing2]的利率。', char: '行', nth: 0, want: 'xing2' },
  { name: '故意标错 重庆→zhong4', text: '重[=zhong4]庆很美。', char: '重', nth: 0, want: 'zhong4' },
  { name: '改写绕开 朝阳→清晨的太阳', text: '朝阳区清晨的太阳很美，他朝着单位走去。', char: '朝', nth: 0, want: 'chao2' },
]

const rows = []
for (const item of CASES) {
  const got = []
  let units = ''
  let leaked = false
  for (let run = 0; run < RUNS; run += 1) {
    try {
      const r = await hyperSynth(item.text, { creds })
      const parsed = parseRhy(r.rhyText ?? '')
      got.push(parsed.units.filter((u) => u.text === item.char)[item.nth]?.pinyin ?? null)
      units = parsed.units.map((u) => `${u.text}[${u.pinyin ?? '-'}]`).join(' ')
      // 标注符号如果被读出来，会以 [、= 或 字母单元的形式出现
      leaked ||= parsed.units.some((u) => /[[\]=]|^(xing|zhao|diao|zhong)\d?$/.test(u.text))
    } catch (error) {
      got.push(`错误 ${error.code ?? error.message}`)
    }
  }
  rows.push({ name: item.name, want: item.want, got, ok: got.every((g) => g === item.want), leaked, units })
}

writeFileSync(join(OUT, 'q5-report.json'), `${JSON.stringify(rows, null, 2)}\n`)
for (const row of rows) {
  console.log(`${row.ok ? '✓' : '✗'} ${row.name}  期望 ${row.want}，实际 ${row.got.join(' / ')}${row.leaked ? '  ⚠ 标注被读出' : ''}`)
  console.log(`    ${row.units}`)
}
