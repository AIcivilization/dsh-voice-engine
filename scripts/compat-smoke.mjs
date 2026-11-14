#!/usr/bin/env node
// scripts/compat-smoke.mjs — 用真的 DSH 把插件装上、启动网页版，逐项确认能用
//
// DSH 还在快速迭代，插件里任何一个注册点对不上，整个插件（有时是整个网页版）都会加载失败。
// 用临时目录当 DSH_HOME，不碰用户自己的配置。
//
//   node scripts/compat-smoke.mjs [--keep] [--live]
//     --live  把本机的讯飞凭据复制进临时目录，真实调用一次合成（会消耗少量字符）
//     --keep  结束后不关网页版，打印地址，用来手动检查界面（Ctrl+C 结束）

import { spawn, spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const has = (flag) => process.argv.includes(`--${flag}`)
const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok) })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `　${String(detail).slice(0, 240)}` : ''}`)
}

function run(cmd, args, env, { timeoutMs = 180000 } = {}) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      done({ code, out })
    })
  })
}

async function main() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-voice-engine-compat-'))
  const env = { ...process.env, DSH_HOME: join(home, '.dsh'), HOME: home, SSH_CONNECTION: '127.0.0.1 1 127.0.0.1 22' }
  delete env.HTTP_PROXY
  delete env.HTTPS_PROXY
  let web = null
  let log = ''
  const finish = async () => {
    if (has('keep') && web) {
      console.log('\n网页版还开着，Ctrl+C 结束。临时目录：', home)
      await new Promise((r) => {
        process.on('SIGINT', r)
        process.on('SIGTERM', r)
      })
    }
    web?.kill('SIGTERM')
    await rm(home, { recursive: true, force: true }).catch(() => {})
    const failed = checks.filter((c) => !c.ok).length
    console.log(`\n${checks.length - failed}/${checks.length} 通过`)
    process.exit(failed ? 1 : 0)
  }

  const version = await run('dsh', ['--version'], env)
  console.log(`DSH ${version.out.trim()}`)

  const pack = spawnSync('npm', ['pack', '--silent', '--pack-destination', home], { cwd: ROOT, encoding: 'utf8' })
  const tgz = join(home, pack.stdout.trim().split('\n').pop())
  check('打包', pack.status === 0, pack.status === 0 ? '' : pack.stderr)
  const listing = spawnSync('tar', ['-tzf', tgz], { encoding: 'utf8' }).stdout
  for (const file of ['package/lib/client.js', 'package/lib/skills/voice-engine.md', 'package/data/catalog.json', 'package/data/polyphones.json', 'package/scenes/scenes.json', 'package/scenes/playbooks/S23.md']) {
    check(`包里有 ${file.replace('package/', '')}`, listing.includes(file))
  }
  check('包里没有验证产物', !listing.includes('spike/') && !listing.includes('credentials'))

  const add = await run('dsh', ['plugin', '--profile', 'web', 'add', tgz], env)
  check('dsh plugin add 能装上', add.code === 0, add.code === 0 ? '' : add.out.slice(-400))
  if (add.code !== 0) return finish()

  if (has('live')) {
    await mkdir(join(env.DSH_HOME, 'dsh-voice-engine'), { recursive: true })
    await copyFile(join(homedir(), '.dsh/dsh-voice-engine/credentials.json'), join(env.DSH_HOME, 'dsh-voice-engine/credentials.json'))
  }

  const portAt = process.argv.indexOf('--port')
  const port = portAt > 0 ? process.argv[portAt + 1] : '0'
  web = spawn('dsh', ['--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', port], { env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] })
  web.stdout.on('data', (d) => { log += d })
  web.stderr.on('data', (d) => { log += d })
  const started = Date.now()
  let url = ''
  while (Date.now() - started < 90000 && web.exitCode === null) {
    url = /http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/.exec(log)?.[0] ?? ''
    if (url) break
    await new Promise((r) => setTimeout(r, 300))
  }
  check('网页版能启动（插件没有拖垮 DSH）', Boolean(url), url ? '' : log.slice(-800))
  if (!url) return finish()
  const base = url.slice(0, url.indexOf('/?token='))

  const login = await fetch(url, { redirect: 'manual' })
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
  check('能登录', login.status === 303 && cookie, `HTTP ${login.status}`)
  const index = await (await fetch(`${base}/`, { headers: { cookie } })).text()
  const clientRef = /dsh-voice-engine\/client\.js&(?:amp;)?rev=[\w-]+/.exec(index)?.[0]?.replace('&amp;', '&') ?? ''
  check('界面代码在加载清单里', clientRef)
  if (clientRef) {
    const res = await fetch(`${base}/plugins/??${clientRef}`, { headers: { cookie } })
    check('界面代码能取到', res.status === 200 && (await res.text()).includes("id: 'dsh-voice-engine'"), `HTTP ${res.status}`)
  }

  const api = async (body) => {
    const res = await fetch(`${base}/api/dsh-voice-engine`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) })
    return res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))
  }
  await new Promise((r) => setTimeout(r, 500))
  const status = await api({ action: 'status' })
  check('接口能用', status.ok, status.error ?? '')
  for (const part of ['tools', 'guard', 'prompt', 'skill', 'commands', 'routes', 'engine', 'service']) {
    const got = status.parts?.[part]
    check(`注册成功：${part}`, got?.ok, got?.detail ?? '没有记录')
  }
  check('工具数量', status.parts?.tools?.detail === '6', status.parts?.tools?.detail)
  check('30 个场景', status.scenes?.length === 30, status.scenes?.length)

  const noAuth = await fetch(`${base}/api/dsh-voice-engine`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"action":"status"}' })
  check('没登录访问不了接口', noAuth.status === 401 || noAuth.status === 403, `HTTP ${noAuth.status}`)
  const crossSite = await fetch(`${base}/api/dsh-voice-engine`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{"action":"status"}' })
  check('跨站请求被拒绝', crossSite.status === 403, `HTTP ${crossSite.status}`)

  const voices = await api({ action: 'voices', query: '旁白', limit: 3 })
  check('音色接口', voices.voices?.length === 3, voices.error ?? '')

  if (has('live')) {
    const doctor = await api({ action: 'doctor' })
    for (const step of doctor.doctor?.steps ?? []) check(`诊断：${step.title}`, step.ok, step.detail)
    const trial = await fetch(`${base}/api/dsh-voice-engine.audio`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: base }, body: JSON.stringify({ code: 'x5_lingxiaoxuan_flow', text: '你好' }) })
    check('合成试听', trial.headers.get('content-type') === 'audio/wav', `HTTP ${trial.status}`)
    const sample = await fetch(`${base}/api/dsh-voice-engine.audio`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: base }, body: JSON.stringify({ code: 'x2_mariane' }) })
    check('样音代理', sample.headers.get('content-type') === 'audio/wav', `HTTP ${sample.status}`)
    const stateFile = await readFile(join(env.DSH_HOME, 'dsh-voice-engine/state.json'), 'utf8').catch(() => '{}')
    check('状态文件不含密钥', !stateFile.includes('apiSecret') && !stateFile.includes('apiKey'))
  }

  if (has('keep')) console.log(`\n打开：${url}`)
  return finish()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
