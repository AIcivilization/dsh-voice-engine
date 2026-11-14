#!/usr/bin/env node
// scripts/live-check.mjs — 用真实的讯飞接口跑一遍工具，走模型会走的路径（只是没有模型）
//
//   node scripts/live-check.mjs
//
// 用临时目录，不影响本机的缓存和用量记录。会消耗少量字符。

import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadState } from '../lib/config.js'
import { voiceGuard } from '../lib/guard.js'
import { buildToolDefinitions } from '../lib/tools.js'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push(Boolean(ok))
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `\n    ${String(detail).replace(/\n/g, '\n    ').slice(0, 500)}` : ''}`)
}

const home = await mkdtemp(join(tmpdir(), 'xfyun-live-'))
const env = { ...process.env, DSH_HOME: home }
await mkdir(join(home, 'dsh-voice-engine'), { recursive: true })
await copyFile(join(homedir(), '.dsh/dsh-voice-engine/credentials.json'), join(home, 'dsh-voice-engine/credentials.json'))
await loadState(env)

const defs = await buildToolDefinitions({ get: () => undefined }, { env })
const tools = Object.fromEntries(defs.map((d) => [d.name, d]))
const exec = { agent: { session: { id: 'live', header: { cwd: home } } }, callId: 'c', signal: new AbortController().signal }
const run = async (name, args) => {
  const value = await tools[name].execute(args, exec)
  return { value, text: tools[name].output.render(args, value)[0].text }
}

try {
  // —— S08 + 读音闭环：这句 M0 实测会把「调用」读错 ——
  const wrong = await run('voice_speak', { text: 'CEO说AI的API调用量翻了一倍。' })
  check('合成并返回读音', wrong.value.ok && wrong.value.readings, wrong.text)
  check('输出 mp3', wrong.value.format === 'mp3' && (await stat(wrong.value.file)).size > 1000, wrong.value.file)
  check('复现读错：模型能看到 调[tiao2]', wrong.value.readings?.includes('调[tiao2]'))

  const fixed = await run('voice_speak', { text: 'CEO说AI的API调[=diao4]用量翻了一倍。' })
  check('加标注后读对：调[diao4]', fixed.value.readings?.includes('调[diao4]'), fixed.value.readings)
  check('标注没有被念出来', !/[=[]diao/.test(fixed.value.readings.replace('调[diao4]', '')))
  check('说话时段在音频之内', fixed.value.speech.startMs > 0 && fixed.value.speech.endMs < fixed.value.durationMs, JSON.stringify(fixed.value.speech))

  const again = await run('voice_speak', { text: 'CEO说AI的API调[=diao4]用量翻了一倍。' })
  check('重复合成走缓存', again.value.cached === true)

  // —— v2：标注必须去掉 ——
  const v2 = await run('voice_speak', { text: '调[=diao4]用量翻了一倍。', vcn: 'xiaoyan', format: 'wav' })
  check('v2 去掉标注，时长正常（念出标注时是 3.1 秒）', v2.value.ok && v2.value.durationMs < 2500, `${v2.value.durationMs}ms`)
  check('v2 说明查不了读音', v2.value.warnings.some((w) => w.includes('没有读音信息')))

  // —— 未授权音色：给出可用的替代 ——
  const denied = await run('voice_speak', { text: '你好', vcn: 'x6_lingbosong_pro' })
  check('未授权音色给出替代', denied.value.ok === false && denied.value.kind === 'voice' && denied.value.alternatives?.length > 0, denied.text)

  // —— 查音色 ——
  const voices = await run('voice_voices', { query: '旁白' })
  check('按用途查音色', voices.value.total > 0, voices.text.split('\n').slice(0, 4).join('\n'))
  const present = await run('voice_voices', { action: 'present', codes: ['x6_pangbainan1_pro', 'x6_pangbainv1_pro', 'x6_lingfeihan_pro'], question: '选旁白', sampleText: '欢迎收听' })
  check('把候选发到界面', present.value.presented === 3)

  // —— S22 多音色试音 ——
  const compared = await run('voice_scene', { action: 'run', id: 'S22', voices: ['聆小璇', 'x6_lingfeiyi_pro'], text: '今天天气真好。' })
  check('多音色对比（名字也能用）', compared.value.results?.every((r) => r.ok), compared.text)

  // —— S13 批量 ——
  const list = join(home, 'prompts.txt')
  await writeFile(list, '# 语音包\nwelcome,您好，欢迎致电。\nbye,感谢来电，再见。\n')
  const batch = await run('voice_scene', { action: 'run', id: 'S13', file: 'prompts.txt', vcn: 'x5_lingxiaoxuan_flow' })
  check('批量语音包', batch.value.ok && batch.value.done.length === 2, batch.text)
  check('按清单命名', (await stat(join(batch.value.outputDir, 'welcome.mp3'))).size > 1000)

  // —— M2 工程：数字、英文、符号是字幕对齐最容易错的地方 ——
  const sentences = [
    '2024年，公司的营收增长了3.5%，用户突破1200万。',
    'CEO说AI的API调用量翻了一倍，iPhone 15 Pro和5G是主要来源。',
    '发布会定在上午10:30，地点在北京，门票¥99。',
    '张三和李四一起去银行办事。',
  ]
  const created = await run('voice_project', { action: 'create', name: '联调', sentences, vcn: 'x6_lingxiaoxuan_pro' })
  check('建工程', created.value.ok && created.value.sentences.length === 4, created.text)
  const built = await run('voice_project', { action: 'build', name: '联调', formats: ['srt', 'vtt', 'ass'], karaoke: true })
  check('导出音频和字幕', built.value.ok && (await stat(built.value.files.audio)).size > 1000, built.text)
  check('时间轴来自音素', built.value.timing?.phoneme === 4, JSON.stringify(built.value.timing))
  check('x6 音色的音素时长和音频一致', built.value.maxDriftMs <= 30, `最大偏差 ${built.value.maxDriftMs} 毫秒`)
  check('覆盖检查（数字英文符号）', built.value.checks?.coverage.ok, JSON.stringify(built.value.checks?.coverage))
  const srt = await readFile(built.value.files.srt, 'utf8')
  console.log(srt)
  console.log((await readFile(built.value.files.ass, 'utf8')).split('\n').filter((l) => l.startsWith('Dialogue')).slice(0, 3).join('\n'))
  check('字幕是原文，不是读音', srt.includes('2024年') && srt.includes('3.5%') && srt.includes('iPhone 15 Pro'))

  const glossaried = await run('voice_project', { action: 'edit', name: '联调', glossary: { 调用: '调[=diao4]用' } })
  check('词表只影响含这个词的句子', glossaried.value.changed?.length === 1 && glossaried.value.changed[0].id === 's2', glossaried.text)
  const edited = await run('voice_project', { action: 'edit', name: '联调', edits: [{ id: 's4', text: '张三和李四一起去银行办理业务。' }] })
  check('改一句', edited.value.changed?.length === 2, edited.text)
  const rebuilt = await run('voice_project', { action: 'build', name: '联调', formats: ['srt'] })
  check('只重配改过的句子', rebuilt.value.ok && rebuilt.value.resynthesized.join() === 's2,s4' && rebuilt.value.reused === 2, rebuilt.text)
  check('词表修正读音', rebuilt.value.pronunciation.some((p) => p.readings.includes('调[diao4]')), JSON.stringify(rebuilt.value.pronunciation))
  check('字幕不带标注', !(await readFile(rebuilt.value.files.srt, 'utf8')).includes('[='))
  const tight = await run('voice_project', { action: 'edit', name: '联调', gapMs: 150 })
  const tightBuilt = await run('voice_project', { action: 'build', name: '联调' })
  check('固定间隔不重新合成，只重排', tight.value.ok && tightBuilt.value.resynthesized.length === 0 && tightBuilt.value.chars === 0 && tightBuilt.value.totalMs < rebuilt.value.totalMs, `${rebuilt.value.totalMs} → ${tightBuilt.value?.totalMs}`)

  // —— M3 转写：把上面的成品转写回来。用临时目录，所以每跑一次都扣转写额度 ——
  const heard = await run('voice_listen', { file: tightBuilt.value.files.audio })
  check('转写真实音频', heard.value.status === 'done' && heard.value.chars > 20, heard.text)
  check('字幕文件有内容', (await stat(heard.value.files.srt)).size > 20)
  const relisten = await run('voice_project', { action: 'relisten', name: '联调' })
  check('回听比较', relisten.value.ok && relisten.value.relisten, relisten.text)
  const speakers = await run('voice_listen', { file: tightBuilt.value.files.audio, speakers: true })
  check('说话人分离（转成 wav 上传）', speakers.value.status === 'done', speakers.text)

  // —— 账号和拦截 ——
  const account = await run('voice_account', {})
  check('账号状态', account.value.voicesOk > 0, account.text)
  check('真实调用后拦截生效', Boolean(voiceGuard({ name: 'bash', arguments: { command: 'edge-tts -t hi' }, agent: { session: { id: 'live' } } })))
} finally {
  await rm(home, { recursive: true, force: true })
}

const failed = checks.filter((ok) => !ok).length
console.log(`\n${checks.length - failed}/${checks.length} 通过`)
process.exit(failed ? 1 : 0)
