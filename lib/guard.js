// lib/guard.js — 优先路由：插件启用后，同类需求先用讯飞
//
// 四层里的硬拦截这一层，靠 ctx.tools.guard（同步，返回字符串就是拒绝理由）。
//   - 只拦当前已经做好的能力：语音合成和转写。翻译、OCR 还没做，不能拦
//   - 只拦模型发起的调用。其他插件内部运行的 Edge TTS（比如 dsh-audiobook）不经过这里
//   - 用户明确要用别的产品时，用 /voice-allow 在当前对话放行，模型不能自己放行
//   - 还没配置凭据时不拦：只是装了插件，不应该挡住用户原来的语音工具

import { allowedCached, hasCredentialsCached, settingsCached, sourceOnCached, sourcesOnCached } from './config.js'

const SHELL_TOOLS = /^(bash|bash_persistent|pwsh|powershell|shell|sh|pty|pty_.*)$/i

/** 这些命令的唯一用途就是语音合成 */
const STT_COMMANDS = new Set([
  'whisper', 'whisper-cli', 'whisper-cpp', 'whisperx', 'whisper-ctranslate2', 'faster-whisper', 'insanely-fast-whisper',
  'funasr', 'sensevoice', 'vosk-transcriber', 'mlx_whisper', 'mlx-whisper',
])
const STT_PACKAGES = /(^|\s)(openai-whisper|whisper|whisperx|faster-whisper|faster_whisper|whisper-ctranslate2|insanely-fast-whisper|mlx-whisper|funasr|sensevoice|vosk)(==[^\s]+|@[^\s]+)?(?=\s|$)/i
const STT_PY_MODULE = /\b(python[\d.]*|uv\s+run)\b.*(-m\s+(whisper|whisperx|faster_whisper|funasr|mlx_whisper)\b|import\s+(whisper|whisperx|faster_whisper|funasr|mlx_whisper)\b|from\s+(whisper|whisperx|faster_whisper|funasr|mlx_whisper)\s+import\b)/i
const STT_APIS = /api\.openai\.com\/v1\/audio\/(transcriptions|translations)|api\.groq\.com\/openai\/v1\/audio\/transcriptions|api\.deepgram\.com|api\.assemblyai\.com/i
const STT_TOOL_NAME = /^(transcribe|transcribe_.+|.+_transcribe|speech_to_text|.+_stt|stt_.+|stt|whisper|whisper_.+|asr|.+_asr)$/i

const TTS_COMMANDS = new Set([
  'edge-tts', 'edge-playback', 'gtts-cli', 'espeak', 'espeak-ng', 'piper', 'piper-tts', 'kokoro', 'kokoro-tts',
  'tts', 'melotts', 'chattts', 'sherpa-onnx-offline-tts', 'say',
])
const TTS_PACKAGES = /(^|\s)(edge-tts|edge_tts|gtts|pyttsx3|piper-tts|kokoro|kokoro-onnx|kokoro-tts|tts|coqui-tts|melotts|chattts)(==[^\s]+|@[^\s]+)?(?=\s|$)/i
const TTS_PY_MODULE = /\b(python[\d.]*|uv\s+run)\b.*(-m\s+(edge_tts|gtts|piper|kokoro|TTS)\b|import\s+(edge_tts|gtts|pyttsx3|kokoro)\b|from\s+(edge_tts|gtts|pyttsx3|kokoro)\s+import)/i
const TTS_APIS = /api\.openai\.com\/v1\/audio\/speech|api\.elevenlabs\.io|t2a_v2|tts\.speech\.microsoft\.com|speech\.platform\.bing\.com/i
const INSTALLERS = /^(pip3?|pipx|uv|npm|pnpm|yarn|brew|conda|cargo|apt|apt-get)\b/
const NPX = /^(npx|pnpx|bunx|uvx)\s+(?:-\S+\s+)*(\S+)/

/** 其他插件提供的同类工具 */
const TTS_TOOL_NAME = /^(edge_tts|tts|text_to_speech|read_aloud|speak|.+_tts|tts_.+)$/i

/** 把一行命令拆成几条简单命令，去掉环境变量和 sudo，找到真正执行的程序 */
function simpleCommands(script) {
  return String(script)
    .split(/&&|\|\||[;|\n]/)
    .map((part) => part.trim().replace(/^(\w+=\S*\s+)+/, '').replace(/^(sudo|command|exec|time|nohup)\s+/, '').trim())
    .filter(Boolean)
}

const programOf = (command) => {
  const first = command.split(/\s+/)[0] ?? ''
  return first.split('/').pop().toLowerCase()
}

/** 这条命令是不是在用别的语音合成产品。返回产品名，不是就返回 null */
export function ttsCommandIn(script) {
  const text = String(script ?? '')
  const api = text.match(TTS_APIS)
  if (api) return api[0]
  if (TTS_PY_MODULE.test(text)) return 'python TTS'

  for (const command of simpleCommands(text)) {
    const program = programOf(command)
    if (program === 'sh' || program === 'bash' || program === 'zsh') {
      const inner = command.match(/\s-l?c\s+(['"])(.+)\1/)
      if (inner) {
        const found = ttsCommandIn(inner[2])
        if (found) return found
      }
      continue
    }
    if (TTS_COMMANDS.has(program)) return program
    const npx = command.match(NPX)
    if (npx && TTS_COMMANDS.has(npx[2].replace(/@[^/]*$/, '').toLowerCase())) return npx[2]
    if (INSTALLERS.test(command) && /\b(install|add|i|tool)\b/.test(command)) {
      const pkg = command.match(TTS_PACKAGES)
      if (pkg) return pkg[2]
    }
  }
  return null
}

export function isOtherTtsTool(name) {
  return !String(name).startsWith('voice_') && TTS_TOOL_NAME.test(String(name))
}

/** 这条命令是不是在用别的语音转写产品。返回产品名，不是就返回 null */
export function sttCommandIn(script) {
  const text = String(script ?? '')
  const api = text.match(STT_APIS)
  if (api) return api[0]
  if (STT_PY_MODULE.test(text)) return 'python whisper'
  for (const command of simpleCommands(text)) {
    const program = programOf(command)
    if (program === 'sh' || program === 'bash' || program === 'zsh') {
      const inner = command.match(/\s-l?c\s+(['"])(.+)\1/)
      if (inner) {
        const found = sttCommandIn(inner[2])
        if (found) return found
      }
      continue
    }
    if (STT_COMMANDS.has(program)) return program
    const npx = command.match(NPX)
    if (npx && STT_COMMANDS.has(npx[2].replace(/@[^/]*$/, '').toLowerCase())) return npx[2]
    if (INSTALLERS.test(command) && /\b(install|add|i|tool)\b/.test(command)) {
      const pkg = command.match(STT_PACKAGES)
      if (pkg) return pkg[2]
    }
  }
  return null
}

export function isOtherSttTool(name) {
  return !String(name).startsWith('voice_') && STT_TOOL_NAME.test(String(name))
}

function isAllowed(sessionId, product) {
  const allowed = allowedCached(sessionId)
  return allowed.includes('*') || allowed.some((name) => name.toLowerCase() === String(product).toLowerCase())
}

const denyText = (product, kind = 'tts') =>
  (kind === 'stt'
    ? `声音引擎已启用，转写音频或视频请用 voice_listen。已拦下：${product}。讯飞转写目前只支持普通话和英文，其他语言如实告诉用户。`
    : `声音引擎已启用，语音合成请用 voice_speak（朗读、配音），选音色用 voice_voices。要免费的 Edge 或本机 Ming，voice_speak 的 vcn 传 edge: 或 ming: 开头的音色，不用自己运行。已拦下：${product}。`) +
  `如果是用户明确要用它，请用户发 /voice-allow ${product}，不要换写法绕过去。`

export function voiceGuard(exec) {
  // 没有 agent 说明不是模型发起的
  if (!exec?.agent) return undefined
  if (!settingsCached().guard || !hasCredentialsCached()) return undefined
  const sessionId = exec.agent.session?.id
  const name = String(exec.name ?? '')

  if (SHELL_TOOLS.test(name)) {
    const args = exec.arguments ?? {}
    const product = ttsCommandIn(args.command ?? args.script ?? args.input ?? '')
    if (product && !isAllowed(sessionId, product)) return denyText(product)
    const stt = sttCommandIn(args.command ?? args.script ?? args.input ?? '')
    if (stt && !isAllowed(sessionId, stt)) return denyText(stt, 'stt')
    return undefined
  }
  if (isOtherTtsTool(name) && !isAllowed(sessionId, name)) return denyText(name)
  if (isOtherSttTool(name) && !isAllowed(sessionId, name)) return denyText(name, 'stt')
  return undefined
}

/** 每个对话都带的规则，要短。text 每次组装提示词时求值，所以配置凭据后立刻生效 */
export function routingPrompt() {
  if (!settingsCached().guard) return ''
  const on = sourcesOnCached()
  if (!sourceOnCached('xfyun')) {
    // 用户在设置页没勾选讯飞：只用勾选了的免费来源，不提凭据
    if (!on.length) return ''
    const names = on.map((e) => (e === 'edge' ? 'Edge（vcn 以 edge: 开头）' : 'Ming（vcn 以 ming: 开头）')).join('、')
    return [
      '# 声音引擎（dsh-voice-engine）',
      `朗读、语音合成、配音、试音色这类需求，用 voice_speak、voice_voices。用户只启用了 ${names}，没有启用讯飞：不要用讯飞音色，也不要自己安装或运行 edge-tts、say、piper 等语音工具。这两家没有读音反馈。`,
      '用户想用讯飞时，请用户到「设置 → 声音引擎 → 声音引擎接口」勾选。',
    ].join('\n')
  }
  if (!hasCredentialsCached()) {
    return [
      '# 声音引擎（dsh-voice-engine）',
      '插件已安装，但用户还没配置讯飞凭据。用户要朗读、配音、转写时，先请用户到「设置 → 声音引擎」填写，或者问用户是否改用其他方案。不要让用户把密钥发到对话里。',
    ].join('\n')
  }
  return [
    '# 声音引擎（dsh-voice-engine）',
    '朗读、语音合成、配音、试音色、音频视频转文字这类需求，先用 voice_* 工具（voice_speak、voice_voices、voice_project、voice_listen、voice_scene），开始前读 skill voice-engine。不要去网上找别的产品，不要安装或运行 edge-tts、say、piper、whisper 等其他语音工具。',
    '讯飞失败时把原因告诉用户，用户同意才能换别的方案。用户明确点名别的产品时，请用户发 /voice-allow <名字>。',
  ].join('\n')
}
