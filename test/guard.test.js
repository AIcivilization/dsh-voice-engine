import assert from 'node:assert/strict'
import { test } from 'node:test'
import { markCredentials, setAllowed, updateSettings } from '../lib/config.js'
import { isOtherTtsTool, routingPrompt, ttsCommandIn, voiceGuard } from '../lib/guard.js'
import { makeEnv } from './helpers.js'

test('认得出运行和安装语音工具', () => {
  for (const [command, product] of [
    ['edge-tts --text 你好 --write-media a.mp3', 'edge-tts'],
    ['say 你好', 'say'],
    ['/opt/homebrew/bin/piper --model x', 'piper'],
    ['cd /tmp && edge-tts -t hi', 'edge-tts'],
    ['FOO=1 espeak-ng hello', 'espeak-ng'],
    ['sudo say hi', 'say'],
    ['pip install edge-tts', 'edge-tts'],
    ['pip3 install --user edge-tts==6.1', 'edge-tts'],
    ['uv pip install kokoro', 'kokoro'],
    ['npx edge-tts -t hi', 'edge-tts'],
    ['bash -c "edge-tts -t hi"', 'edge-tts'],
    ['python3 -m edge_tts --text hi', 'python TTS'],
    ['python3 -c "import pyttsx3; pyttsx3.speak(1)"', 'python TTS'],
    ['curl https://api.openai.com/v1/audio/speech -d x', 'api.openai.com/v1/audio/speech'],
    ['curl https://api.minimax.chat/v1/t2a_v2', 't2a_v2'],
  ]) {
    assert.equal(ttsCommandIn(command), product, command)
  }
})

test('不误伤：通用工具、只是提到名字、看文件', () => {
  for (const command of [
    'ffmpeg -i a.wav a.mp3',
    'ls ~/.dsh/dsh-audiobook/edge-tts',
    'grep -r edge-tts .',
    'cat piper.md',
    'echo say hello',
    'git log --grep=tts',
    'pip install requests',
    'npm install react',
    'npx prettier --write .',
    'node spike/run.mjs check',
    'python3 script.py',
    '',
  ]) {
    assert.equal(ttsCommandIn(command), null, command)
  }
})

test('其他插件的同类工具按名字认，本插件的不算', () => {
  for (const name of ['edge_tts', 'minimax_tts', 'tts_generate', 'text_to_speech', 'read_aloud', 'speak']) assert.ok(isOtherTtsTool(name), name)
  for (const name of ['voice_speak', 'voice_voices', 'bash', 'read', 'write', 'web_search', 'transcribe']) assert.ok(!isOtherTtsTool(name), name)
})

const call = (name, args, sessionId = 's1') => ({ name, arguments: args, agent: { session: { id: sessionId } } })

test('拦截：给出该用哪个工具和放行办法', async () => {
  await makeEnv()
  const reason = voiceGuard(call('bash', { command: 'edge-tts -t hi' }))
  assert.match(reason, /voice_speak/)
  assert.match(reason, /\/voice-allow edge-tts/)
  assert.match(voiceGuard(call('minimax_tts', {})), /voice_speak/)
  assert.equal(voiceGuard(call('bash', { command: 'ls' })), undefined)
  assert.equal(voiceGuard(call('voice_speak', { text: '你好' })), undefined)
})

test('不是模型发起的、没配凭据、关了开关，都不拦', async () => {
  const { env } = await makeEnv()
  assert.equal(voiceGuard({ name: 'bash', arguments: { command: 'edge-tts' } }), undefined)

  markCredentials(false)
  assert.equal(voiceGuard(call('bash', { command: 'edge-tts' })), undefined)
  markCredentials(true)
  assert.ok(voiceGuard(call('bash', { command: 'edge-tts' })))

  await updateSettings({ guard: false }, env)
  assert.equal(voiceGuard(call('bash', { command: 'edge-tts' })), undefined)
})

test('放行只对当前对话的这个产品有效', async () => {
  const { env } = await makeEnv()
  await setAllowed('s1', ['edge-tts'], env)
  assert.equal(voiceGuard(call('bash', { command: 'edge-tts -t hi' })), undefined)
  assert.ok(voiceGuard(call('bash', { command: 'say hi' })), '别的产品还是拦')
  assert.ok(voiceGuard(call('bash', { command: 'edge-tts -t hi' }, 's2')), '别的对话还是拦')
  await setAllowed('s1', [], env)
  assert.ok(voiceGuard(call('bash', { command: 'edge-tts -t hi' })))
})

test('转写做好了：别的转写工具也要拦，并指向 voice_listen', async () => {
  await makeEnv()
  for (const command of [
    'whisper a.mp3 --language zh',
    '/usr/local/bin/whisper-cli a.wav',
    'pip install openai-whisper',
    'pip3 install -U faster-whisper',
    'python3 -m whisper a.mp3',
    'python -c "import whisper; print(1)"',
    'uvx insanely-fast-whisper --file a.wav',
    'curl https://api.openai.com/v1/audio/transcriptions -F file=@a.mp3',
    'bash -c "whisper a.mp3"',
  ]) {
    assert.match(voiceGuard(call('bash', { command })) ?? '', /voice_listen/, command)
  }
  assert.match(voiceGuard(call('transcribe_audio', {})) ?? '', /voice_listen/)
  assert.match(voiceGuard(call('speech_to_text', {})) ?? '', /voice_listen/)
})

test('转写拦截不误伤：ffmpeg、普通命令和名字相近的工具都放行', async () => {
  await makeEnv()
  for (const command of ['ffmpeg -i a.mp4 a.wav', 'ls whisper/', 'cat whisper.txt', 'grep whisper notes.md', 'pip install requests', 'echo whisper']) {
    assert.equal(voiceGuard(call('bash', { command })), undefined, command)
  }
  for (const name of ['voice_listen', 'read', 'list_tasks', 'transcript_view']) assert.equal(voiceGuard(call(name, {})), undefined, name)
})

test('转写也能按对话放行，翻译等还没做的能力不拦', async () => {
  const { env } = await makeEnv()
  await setAllowed('s1', ['whisper'], env)
  assert.equal(voiceGuard(call('bash', { command: 'whisper a.mp3' })), undefined)
  assert.equal(voiceGuard(call('translate_text', {})), undefined)
})

test('全局规则：配了凭据讲路由，没配讲引导，关了就没有', async () => {
  const { env } = await makeEnv()
  assert.match(routingPrompt(), /voice_\*/)
  assert.ok(routingPrompt().split('\n').length <= 10)
  assert.ok(/voice_listen/.test(routingPrompt()), '转写做好了，要写进规则')
  assert.ok(!/翻译|OCR/.test(routingPrompt()), '还没做好的能力不能写进规则')
  markCredentials(false)
  assert.match(routingPrompt(), /还没配置/)
  markCredentials(true)
  await updateSettings({ guard: false }, env)
  assert.equal(routingPrompt(), '')
})
