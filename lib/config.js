// lib/config.js — 凭据、设置和状态的读写
//
// 目录 $DSH_HOME/dsh-voice-engine/：credentials.json（权限 600）、state.json、cache/、samples/。
// 凭据只在 host 侧使用：不进工具结果、不进日志、不下发给浏览器。

import { chmod, copyFile, cp, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const DEFAULT_SETTINGS = {
  guard: true, // 优先路由的硬拦截
  confirmChars: 2000, // 一次合成超过多少字要先问用户
  defaultVcn: '',
  engineApi: true, // 对外接口：别的产品通过本机 HTTP 用这个声音引擎
  engineAllowXfyun: false, // 讯飞会扣额度，默认不对外开放
  // 用哪几家声音：设置页勾选。没勾的那家，插件自己（AI 工具、音色库、命令）和对外接口都不用
  useXfyun: true,
  useEdge: true,
  useMing: true,
  enginePort: 18321,
}

/** $DSH_HOME 要读环境变量解析后的值，不能写死 ~/.dsh */
export function dshHome(env = process.env) {
  const fromEnv = env.DSH_HOME?.trim()
  return fromEnv ? resolve(fromEnv) : join(homedir(), '.dsh')
}

export function paths(env = process.env) {
  const root = join(dshHome(env), 'dsh-voice-engine')
  return {
    root,
    credentials: join(root, 'credentials.json'),
    state: join(root, 'state.json'),
    cache: join(root, 'cache'),
    samples: join(root, 'samples'),
    output: join(root, 'output'),
  }
}

export async function atomicWrite(file, content, mode = 0o600) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, content, { mode })
  await rename(tmp, file)
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

// —— 凭据 ——

/**
 * 检查形状，发现填错位置就直说。真实用户踩过的：AppID 填邮箱、APISecret 填网址、
 * 用大模型的 ak- 密钥、APIKey 和 APISecret 填反。返回的文字不带凭据内容。
 */
export function credentialProblem({ appId, apiKey, apiSecret } = {}) {
  if (!appId) return { code: 'missing-appid', text: '缺少 AppID' }
  if (/[@/:\s]/.test(appId)) return { code: 'bad-appid', text: 'AppID 填错了：它是控制台应用详情里的一串字母数字，不是邮箱或网址' }
  if (!apiKey) return { code: 'missing-apikey', text: '缺少 APIKey' }
  if (String(apiKey).startsWith('ak-')) {
    return { code: 'maas-key', text: '这是星火大模型（MaaS）的 ak- 密钥，语音接口要用控制台语音服务页上的 APIKey 和 APISecret' }
  }
  if (!apiSecret) return { code: 'missing-apisecret', text: '缺少 APISecret' }
  if (/^https?:/.test(apiSecret)) return { code: 'bad-apisecret', text: 'APISecret 填错了：它不是网址' }
  return null
}

/** 讯飞的 APIKey 是 32 位十六进制，APISecret 不是：反过来多半是填反了 */
export function looksSwapped({ apiKey, apiSecret } = {}) {
  const hex = /^[0-9a-f]{32}$/i
  return hex.test(String(apiSecret ?? '')) && !hex.test(String(apiKey ?? ''))
}

export async function loadCredentials(env = process.env) {
  if (env.IFLY_APP_ID && env.IFLY_API_KEY && env.IFLY_API_SECRET) {
    return { appId: env.IFLY_APP_ID, apiKey: env.IFLY_API_KEY, apiSecret: env.IFLY_API_SECRET, source: 'env' }
  }
  const file = await readJson(paths(env).credentials, null)
  return file ? { ...file, source: 'file' } : null
}

export async function saveCredentials(input, env = process.env) {
  const creds = {
    appId: String(input.appId ?? '').trim(),
    apiKey: String(input.apiKey ?? '').trim(),
    apiSecret: String(input.apiSecret ?? '').trim(),
  }
  const problem = credentialProblem(creds)
  if (problem) throw new Error(problem.text)
  // 控制台上 APISecret 排在 APIKey 前面，很容易贴反；能认出来就帮用户调回来
  const swapped = looksSwapped(creds)
  const saved = swapped ? { ...creds, apiKey: creds.apiSecret, apiSecret: creds.apiKey } : creds
  await atomicWrite(paths(env).credentials, `${JSON.stringify(saved, null, 2)}\n`)
  markCredentials(true)
  return { swapped }
}

/** 给界面和模型看的状态：绝不带密钥本身 */
export function credentialStatus(creds) {
  if (!creds) return { configured: false }
  const problem = credentialProblem(creds)
  return {
    configured: !problem,
    source: creds.source,
    appIdTail: String(creds.appId ?? '').slice(-3),
    problem: problem?.text,
  }
}

// —— 状态和设置 ——

const EMPTY_STATE = { schema: 1, settings: {}, voices: {}, allow: {}, usage: {} }

// 工具守卫是同步的，读不了文件，靠这份内存副本判断
const memory = { state: structuredClone(EMPTY_STATE), credentials: false, loaded: false }

export const hasCredentialsCached = () => memory.credentials
export const markCredentials = (value) => { memory.credentials = Boolean(value) }
export const settingsCached = () => ({ ...DEFAULT_SETTINGS, ...memory.state.settings })
export const SOURCE_SWITCH = { xfyun: 'useXfyun', edge: 'useEdge', ming: 'useMing' }
/** 用户有没有勾选这个来源。没勾的哪里都不用 */
export const sourceOnCached = (engine) => Boolean(settingsCached()[SOURCE_SWITCH[engine]])
export const sourcesOnCached = () => Object.keys(SOURCE_SWITCH).filter(sourceOnCached)
/** 这个来源别的插件和产品能不能用：要勾选了；讯飞会扣额度，还要用户另外允许 */
export const engineOpenCached = (engine) => sourceOnCached(engine) && (engine !== 'xfyun' || settingsCached().engineAllowXfyun)
export const openEnginesCached = () => Object.keys(SOURCE_SWITCH).filter(engineOpenCached)
export const allowedCached = (sessionId) => memory.state.allow[String(sessionId ?? '')] ?? []

/**
 * 这个插件原来叫 dsh-xfyun。新目录还是空的、旧目录有东西时，把凭据、设置、缓存和接口令牌复制过来。
 * 只复制不删除：用户随时能退回旧版本。Edge 的虚拟环境不复制，里面写死了路径，搬过来会坏。
 */
export async function migrateFromXfyun(env = process.env) {
  const target = paths(env)
  const old = join(dshHome(env), 'dsh-xfyun')
  const exists = async (p) => stat(p).then(() => true, () => false)
  if (await exists(target.state) || await exists(target.credentials)) return { migrated: false }
  if (!(await exists(old))) return { migrated: false }
  await mkdir(target.root, { recursive: true, mode: 0o700 })
  const copied = []
  for (const name of ['credentials.json', 'state.json', 'engine.json']) {
    if (await exists(join(old, name))) {
      await copyFile(join(old, name), join(target.root, name))
      await chmod(join(target.root, name), 0o600)
      copied.push(name)
    }
  }
  for (const name of ['cache', 'samples']) {
    if (await exists(join(old, name))) {
      await cp(join(old, name), join(target.root, name), { recursive: true, force: false, errorOnExist: false })
      copied.push(name)
    }
  }
  return { migrated: copied.length > 0, copied, from: old }
}

export async function loadState(env = process.env) {
  memory.migration = await migrateFromXfyun(env).catch((error) => ({ migrated: false, error: error.message }))
  const stored = await readJson(paths(env).state, null)
  memory.state = { ...structuredClone(EMPTY_STATE), ...(stored ?? {}) }
  const creds = await loadCredentials(env)
  memory.credentials = Boolean(creds) && !credentialProblem(creds)
  memory.loaded = true
  return memory.state
}

export const getState = () => memory.state
export const migrationResult = () => memory.migration ?? null

// 写文件排队，避免两次并发保存互相覆盖
let writing = Promise.resolve()
export function saveState(env = process.env) {
  const snapshot = `${JSON.stringify(memory.state, null, 2)}\n`
  writing = writing.catch(() => {}).then(() => atomicWrite(paths(env).state, snapshot))
  return writing
}

export async function updateSettings(patch, env = process.env) {
  const next = { ...memory.state.settings }
  if (typeof patch.guard === 'boolean') next.guard = patch.guard
  if (Number.isInteger(patch.confirmChars) && patch.confirmChars >= 100) next.confirmChars = patch.confirmChars
  if (typeof patch.defaultVcn === 'string') next.defaultVcn = patch.defaultVcn.trim()
  if (typeof patch.engineApi === 'boolean') next.engineApi = patch.engineApi
  for (const key of ['engineAllowXfyun', 'useXfyun', 'useEdge', 'useMing']) {
    if (typeof patch[key] === 'boolean') next[key] = patch[key]
  }
  if (Number.isInteger(patch.enginePort) && patch.enginePort >= 1024 && patch.enginePort <= 65535) next.enginePort = patch.enginePort
  memory.state.settings = next
  await saveState(env)
  return settingsCached()
}

/** 记下某个音色在当前账号上的实际情况：只有真实调用才算数 */
export function markVoice(code, status, env = process.env) {
  const previous = memory.state.voices[code]
  memory.state.voices[code] = { status, at: new Date().toISOString() }
  if (previous?.status === status) return Promise.resolve()
  return saveState(env)
}

export function addUsage(chars, env = process.env, now = new Date()) {
  const day = now.toISOString().slice(0, 10)
  const usage = memory.state.usage
  usage[day] = { ...usage[day], chars: (usage[day]?.chars ?? 0) + chars, calls: (usage[day]?.calls ?? 0) + 1 }
  for (const key of Object.keys(usage).sort().slice(0, -31)) delete usage[key]
  return saveState(env)
}

/** 转写按时长计费，和合成的字数分开记 */
export function addListenUsage(ms, env = process.env, now = new Date()) {
  const day = now.toISOString().slice(0, 10)
  const usage = memory.state.usage
  usage[day] = { chars: 0, calls: 0, ...usage[day], listenMs: (usage[day]?.listenMs ?? 0) + ms, listens: (usage[day]?.listens ?? 0) + 1 }
  return saveState(env)
}

export async function setAllowed(sessionId, names, env = process.env) {
  const key = String(sessionId ?? '')
  if (names.length) memory.state.allow[key] = names
  else delete memory.state.allow[key]
  await saveState(env)
}

/** 测试用 */
export function _resetMemory() {
  memory.state = structuredClone(EMPTY_STATE)
  memory.credentials = false
  memory.loaded = false
}
