/* global window, document, fetch, navigator, setTimeout, clearTimeout, setInterval, clearInterval, Audio, URL, AbortSignal, console */
// lib/client.js — 界面
//
// 手写单文件 bundle，没有构建链：供 DSH web 客户端的 ModuleLoader 注入（写法照 dsh-vps-manager）。
// 界面只做模型替代不了的事，一共三处：
//   settings.section           填凭据、检测、设置（密钥不能经过对话）
//   sidebar.right.pane.tab     音色库：找音色、听、对比、设默认（模型听不到，这些只能人做）
//   conversation.composer.dock 模型推荐的候选，用户试听、对比后点选，选择发回对话
//
// 硬约束：界面崩了不能影响命令和 AI 工具，注册一律包在 try/catch 里。

window.__ModuleLoader__.load({
  id: 'dsh-voice-engine',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const h = React.createElement

    // —— 界面语言：跟着 DSH ——
    let localeSvc = null
    function lang() {
      try {
        const active = localeSvc?.getLocale?.()?.active
        if (active) return String(active).toLowerCase().startsWith('zh') ? 'zh' : 'en'
      } catch {
        // 语言服务出错就看网页
      }
      const page = typeof document !== 'undefined' ? document.documentElement.lang : ''
      return !page || page.toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }
    const L = (zh, en) => (lang() === 'zh' ? zh : en)

    // 跟随 DSH 主题，写死颜色会在浅色主题下变成黑块
    const T = {
      border: 'var(--dsw-alias-border-l3, rgba(127,127,127,0.24))',
      field: 'var(--dsw-alias-border-l4, rgba(127,127,127,0.32))',
      text: 'var(--dsw-alias-label-primary, inherit)',
      secondary: 'var(--dsw-alias-label-secondary, inherit)',
      tertiary: 'var(--dsw-alias-label-tertiary, #81858c)',
      layer: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.10))',
      danger: 'var(--dsw-alias-state-error-primary, #e5534b)',
      ok: 'var(--dsw-alias-state-success-primary, #2ea043)',
      accent: 'var(--primary, #3b82f6)',
    }
    const S = {
      card: { border: `0.5px solid ${T.border}`, borderRadius: 10, padding: 14, marginBottom: 12, color: T.text },
      title: { fontSize: 13, fontWeight: 600, marginBottom: 8 },
      muted: { fontSize: 12, color: T.secondary, lineHeight: 1.6 },
      input: { width: '100%', boxSizing: 'border-box', height: 30, padding: '0 8px', borderRadius: 7, border: `0.5px solid ${T.field}`, background: 'transparent', color: T.text, fontSize: 13 },
      button: { height: 28, padding: '0 11px', borderRadius: 7, border: `0.5px solid ${T.field}`, background: 'transparent', color: T.text, fontSize: 12.5, cursor: 'pointer', whiteSpace: 'nowrap' },
      primary: { height: 28, padding: '0 12px', borderRadius: 7, border: 'none', background: T.accent, color: '#fff', fontSize: 12.5, cursor: 'pointer', whiteSpace: 'nowrap' },
    }

    // —— 接口 ——
    const API = '/api/dsh-voice-engine'
    const AUDIO_API = '/api/dsh-voice-engine.audio'

    async function post(path, body, timeoutMs) {
      let res
      try {
        res = await fetch(path, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'content-type': 'application/json', 'x-dsh-voice-engine-lang': lang() },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        if (error?.name === 'TimeoutError') throw new Error(L('等了太久没有回应，再试一次', 'No response for too long. Try again'))
        throw new Error(L('连不上 DSH，看看 DSH 还开着吗', 'Cannot reach DSH. Check that it is still running'))
      }
      return res
    }

    async function api(action, body = {}, timeoutMs = 30000) {
      const res = await post(API, { action, ...body }, timeoutMs)
      let data = null
      try {
        data = await res.json()
      } catch {
        throw new Error(res.status === 404 ? L('接口不存在：DSH 运行期间装的新版本要重启才生效', 'Not found. A version installed while DSH is running needs a restart') : `HTTP ${res.status}`)
      }
      if (!data?.ok) throw new Error([data?.error, data?.hint].filter(Boolean).join('。') || `HTTP ${res.status}`)
      return data
    }

    // —— 播放器：同时只响一个 ——
    const player = { audio: null, key: '', url: '', loading: false, listeners: new Set(), ended: [] }
    const notify = () => player.listeners.forEach((fn) => fn())

    function stopPlayer() {
      try {
        player.audio?.pause()
      } catch {
        // 没开始播放
      }
      if (player.url) URL.revokeObjectURL(player.url)
      player.audio = null
      player.url = ''
      player.key = ''
      player.loading = false
      for (const done of player.ended.splice(0)) done()
      notify()
    }

    /** 开始播放。返回这次实际扣了多少字、音频多长 */
    async function play(key, body) {
      if (player.key === key) {
        stopPlayer()
        return null
      }
      stopPlayer()
      player.key = key
      player.loading = true
      notify()
      try {
        const res = await post(AUDIO_API, body, 180000) // 本机 Ming 第一次要加载模型
        const type = res.headers.get('content-type') ?? ''
        if (!type.startsWith('audio/')) {
          const data = await res.json().catch(() => ({}))
          throw new Error([data.error, data.hint].filter(Boolean).join('。') || `HTTP ${res.status}`)
        }
        if (player.key !== key) return null // 等待期间用户点了别的
        player.url = URL.createObjectURL(await res.blob())
        player.audio = new Audio(player.url)
        player.audio.onended = stopPlayer
        await player.audio.play()
        player.loading = false
        notify()
        return { charged: Number(res.headers.get('x-xfyun-charged') ?? 0), durationMs: Number(res.headers.get('x-xfyun-duration-ms') ?? 0) || null }
      } catch (error) {
        if (player.key === key) stopPlayer()
        throw error
      }
    }

    /** 等当前这一段放完，连续试听用 */
    const untilStopped = () => new Promise((done) => {
      if (!player.key) done()
      else player.ended.push(done)
    })

    function usePlayer() {
      const [, force] = useState(0)
      useEffect(() => {
        const fn = () => force((n) => n + 1)
        player.listeners.add(fn)
        return () => player.listeners.delete(fn)
      }, [])
      return player
    }

    // —— 发回对话：同 dsh-vps-manager 的「让 AI 看看这个文件」——
    let composerOf = null
    function composerFor(sessionId) {
      try {
        return (sessionId && composerOf?.(sessionId)) || null
      } catch {
        return null
      }
    }
    const draftOf = (input) => {
      try {
        return String(input.snapshot?.draft ?? input.state?.get?.()?.draft ?? '').trim()
      } catch {
        return ''
      }
    }
    /** @returns 'sent' 发出去了；'draft' 输入框里有没发的话；'none' 拿不到输入框 */
    async function sendToChat(sessionId, text) {
      const input = composerFor(sessionId)
      if (!input) return 'none'
      if (draftOf(input)) return 'draft'
      input.setDraft(text)
      for (let i = 0; i < 20 && !draftOf(input); i += 1) await new Promise((r) => setTimeout(r, 25))
      if (!draftOf(input)) return 'none'
      await input.submit('queue')
      return 'sent'
    }

    const STATUS = {
      ok: () => ({ label: L('可用', 'Ready'), color: T.ok }),
      denied: () => ({ label: L('未授权', 'Not licensed'), color: T.danger }),
      unknown: () => ({ label: L('未试过', 'Untested'), color: T.tertiary }),
      unavailable: () => ({ label: L('用不了', 'Unavailable'), color: T.tertiary }),
    }
    const MAX_COMPARE = 5
    const TRY_TEXT = () => L('你好，这是我的声音。', 'Hello, this is my voice.')
    const LANGS = { zh: ['中文', 'Chinese'], en: ['英语', 'English'], yue: ['粤语', 'Cantonese'], ja: ['日语', 'Japanese'], ko: ['韩语', 'Korean'], fr: ['法语', 'French'], de: ['德语', 'German'], ru: ['俄语', 'Russian'], es: ['西班牙语', 'Spanish'], pt: ['葡萄牙语', 'Portuguese'], it: ['意大利语', 'Italian'], vi: ['越南语', 'Vietnamese'], th: ['泰语', 'Thai'], id: ['印尼语', 'Indonesian'], ms: ['马来语', 'Malay'], ar: ['阿拉伯语', 'Arabic'], hi: ['印地语', 'Hindi'], ug: ['维吾尔语', 'Uyghur'], bo: ['藏语', 'Tibetan'], ur: ['乌尔都语', 'Urdu'], el: ['希腊语', 'Greek'], nl: ['荷兰语', 'Dutch'], fa: ['波斯语', 'Persian'], pl: ['波兰语', 'Polish'] }
    const USE_CHIPS = () => [L('旁白', 'Narration'), L('新闻', 'News'), L('广告', 'Ads'), L('客服', 'Support'), L('角色', 'Character'), L('童声', 'Child')]
    const voiceMeta = (voice) => [voice.gender === 'male' ? L('男', 'M') : voice.gender === 'female' ? L('女', 'F') : voice.gender === 'child' ? L('童', 'Kid') : '', voice.dialect, voice.scene, voice.style].filter(Boolean).join(' · ')

    /** 听之前就说清楚花不花钱 */
    function costLabel({ voice, text, cost, heard }) {
      if (voice.free) return { text: heard ? L('听过，不扣钱', 'Free, cached') : voice.engine === 'ming' ? L('免费 · 本机合成', 'Free · on this Mac') : L('免费 · 联网合成', 'Free · online'), color: T.ok }
      if (!text && voice.hasSample) return { text: L('免费样音', 'Free sample'), color: T.ok }
      if (heard || cost?.cached) return { text: L('听过，不扣字', 'Cached, free'), color: T.ok }
      if (cost?.chars) return { text: L(`试听约扣 ${cost.chars} 字`, `About ${cost.chars} characters`), color: T.secondary }
      return { text: L('试听要合成，会扣字', 'Trial uses characters'), color: T.secondary }
    }

    /** 一行音色。text 是试听文字；没有文字时，有样音就放样音，没有就合成一句默认的 */
    function VoiceRow({ voice, text, cost, isDefault, onPick, pickLabel, compared, onCompare, onChanged, compact }) {
      const p = usePlayer()
      const [error, setError] = useState('')
      const [heard, setHeard] = useState(false)
      const [used, setUsed] = useState(null)
      const trial = text || (voice.hasSample ? '' : voice.trialText || TRY_TEXT())
      const key = `${voice.code}:${trial}`
      useEffect(() => {
        setHeard(false)
        setUsed(null)
      }, [trial])
      const onPlay = () => {
        setError('')
        play(key, trial ? { code: voice.code, text: trial } : { code: voice.code })
          .then((r) => {
            if (!r) return
            setUsed(r)
            if (trial) setHeard(true)
          })
          .catch((e) => {
            setError(e.message)
            onChanged?.()
          })
      }
      const playing = p.key === key
      const status = (STATUS[voice.status] ?? STATUS.unknown)()
      const price = costLabel({ voice, text: trial, cost: cost ?? voice.trial, heard })
      return h('div', { 'data-voice-voice': voice.code, style: { padding: '8px 0', borderBottom: `0.5px solid ${T.border}` } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('button', { type: 'button', onClick: onPlay, disabled: voice.status === 'unavailable', 'aria-label': playing ? L('停止', 'Stop') : L('试听', 'Listen'), title: voice.status === 'unavailable' ? L('这个引擎现在用不了，看上面的说明', 'This engine is unavailable; see the note above') : price.text, style: { ...S.button, width: 30, padding: 0, flex: '0 0 auto', ...(voice.status === 'unavailable' ? { opacity: 0.4, cursor: 'default' } : {}) } }, playing ? (p.loading ? '…' : '■') : '▶'),
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { style: { fontSize: 13, fontWeight: 500, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              voice.name,
              isDefault ? h('span', { style: { marginLeft: 6, fontSize: 11, fontWeight: 400, color: T.accent } }, L('默认', 'Default')) : null,
              h('span', { style: { marginLeft: 6, fontSize: 11, fontWeight: 400, color: status.color } }, status.label)),
            compact ? null : h('div', { style: { fontSize: 11.5, color: T.secondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, voiceMeta(voice) || voice.code),
            h('div', { style: { fontSize: 11, color: price.color } },
              used ? [used.durationMs ? L(`${(used.durationMs / 1000).toFixed(1)} 秒 · `, `${(used.durationMs / 1000).toFixed(1)}s · `) : '', used.charged ? L(`刚扣 ${used.charged} 字`, `Used ${used.charged} characters`) : L('未扣字', 'Free')].join('') : price.text)),
          onCompare ? h('button', { type: 'button', onClick: () => onCompare(voice), 'aria-pressed': Boolean(compared), style: { ...S.button, flex: '0 0 auto', padding: '0 8px', ...(compared ? { borderColor: T.accent, color: T.accent } : {}) } }, compared ? L('已加入', 'Added') : L('对比', 'Compare')) : null,
          onPick ? h('button', { type: 'button', onClick: () => onPick(voice), style: { ...S.button, flex: '0 0 auto', padding: '0 8px' } }, pickLabel ?? L('选用', 'Use')) : null),
        error ? h('div', { style: { fontSize: 12, color: T.danger, marginTop: 4, lineHeight: 1.5 } }, error) : null)
    }

    /** 同一句话听几个音色。文字可改，花多少字先算好写在按钮上，点了才花 */
    function CompareList({ voices, initialText, isDefault, onPick, pickLabel, onRemove, onChanged }) {
      usePlayer()
      const [text, setText] = useState(initialText ?? '')
      const [plan, setPlan] = useState(null)
      const [error, setError] = useState('')
      const [running, setRunning] = useState(false)
      const cancel = useRef(false)
      const clean = text.trim()
      const codes = voices.map((v) => v.code).join()
      const refresh = useCallback(() => {
        if (!clean) {
          setPlan(null)
          setError('')
          return undefined
        }
        return api('trialPlan', { codes: voices.map((v) => v.code), text: clean }).then((r) => {
          setPlan(r)
          setError('')
        }).catch((e) => setError(e.message))
      }, [clean, codes])
      useEffect(() => {
        const timer = setTimeout(refresh, 300)
        return () => clearTimeout(timer)
      }, [refresh])
      const costOf = (code) => plan?.voices?.find((v) => v.code === code)
      const needText = !clean && voices.some((v) => !v.hasSample)
      const playable = voices.filter((v) => clean || v.hasSample)
      const playAll = async () => {
        setError('')
        setRunning(true)
        cancel.current = false
        try {
          for (const voice of playable) {
            if (cancel.current) break
            const r = await play(`${voice.code}:${clean}`, clean ? { code: voice.code, text: clean } : { code: voice.code })
            if (r === null) break
            await untilStopped()
          }
        } catch (e) {
          setError(`${e.message}`)
          onChanged?.()
        } finally {
          setRunning(false)
          refresh()
        }
      }
      const stopAll = () => {
        cancel.current = true
        stopPlayer()
      }
      const charge = plan?.charge ?? 0
      return h('div', { 'data-voice-compare': '' },
        h('textarea', { value: text, rows: 2, onChange: (e) => setText(e.target.value), placeholder: L('写一句你的文案，用它来对比。不写就放免费样音', 'Type a line to compare with. Leave empty to play free samples'), style: { ...S.input, height: 'auto', padding: '6px 8px', resize: 'vertical', lineHeight: 1.5 } }),
        voices.map((voice) => h('div', { key: voice.code, style: { display: 'flex', alignItems: 'center', gap: 6 } },
          h('div', { style: { flex: 1, minWidth: 0 } }, h(VoiceRow, { voice, text: clean, cost: costOf(voice.code), isDefault: isDefault?.(voice), onPick, pickLabel, onChanged, compact: Boolean(onRemove) })),
          onRemove ? h('button', { type: 'button', 'aria-label': L('移出对比', 'Remove'), onClick: () => onRemove(voice), style: { ...S.button, flex: '0 0 auto', width: 26, padding: 0 } }, '×') : null)),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
          running
            ? h('button', { type: 'button', onClick: stopAll, style: S.button }, L('停止', 'Stop'))
            : h('button', { type: 'button', onClick: playAll, disabled: !playable.length || Boolean(error), style: { ...S.primary, ...(!playable.length || error ? { opacity: 0.45, cursor: 'default' } : {}) } },
                clean ? (charge ? L(`连续试听（约扣 ${charge} 字）`, `Play all (about ${charge} characters)`) : L('连续试听（不扣字）', 'Play all (free)')) : L('连续放样音（免费）', 'Play samples (free)')),
          needText ? h('span', { style: S.muted }, L('没有样音的音色要写一句才能听', 'Voices without a sample need text')) : null,
          null),
        error ? h('div', { style: { fontSize: 12, color: T.danger, marginTop: 6, lineHeight: 1.5 } }, error) : null)
    }

    const pickText = (voice) => L(`我选 ${voice.name}（${voice.code}）`, `I choose ${voice.name} (${voice.code})`)
    const SEND_ERROR = {
      draft: () => L('输入框里有没发的话，先发出去或清空，再点一次', 'The input box has unsent text. Send or clear it, then try again'),
      none: () => L('没能写入对话，请手动告诉 AI 你的选择', 'Could not write to the conversation. Tell the AI your choice directly'),
    }

    // —— 打开音色库：/voice-list 和模型都能触发，界面轮询时取走 ——
    let openSidebar = null
    const library = { query: null, listeners: new Set() }
    function openLibrary(request) {
      try {
        openSidebar?.()
      } catch (error) {
        console.warn('[dsh-voice-engine] 打不开右侧栏', error)
      }
      if (request?.query !== undefined) {
        library.query = request.query
        library.listeners.forEach((fn) => fn())
      }
    }

    // —— 输入框下方：模型请用户选音色时才出现 ——
    function PickerDock(props) {
      const sessionId = props?.sessionId ? String(props.sessionId) : ''
      const [pending, setPending] = useState(null)
      const [error, setError] = useState('')
      useEffect(() => {
        if (!sessionId) return undefined
        let alive = true
        const poll = () => {
          if (document.hidden) return
          api('picker', { sessionId }, 8000).then((r) => {
            if (!alive) return
            setPending((old) => (old?.id === r.pending?.id ? old : r.pending))
            if (r.openLibrary) openLibrary(r.openLibrary)
          }).catch(() => {})
        }
        poll()
        const timer = setInterval(poll, 2500)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [sessionId])
      if (!pending) return null
      const close = () => {
        stopPlayer()
        setPending(null)
        setError('')
        api('pickerClear', { sessionId }).catch(() => {})
      }
      const onPick = async (voice) => {
        const outcome = await sendToChat(sessionId, pickText(voice))
        if (outcome === 'sent') return close()
        return setError((SEND_ERROR[outcome] ?? SEND_ERROR.none)())
      }
      return h('div', { 'data-voice-picker': '', style: { width: '100%', boxSizing: 'border-box', border: `0.5px solid ${T.border}`, borderRadius: 10, padding: '10px 12px', margin: '6px 0', background: T.layer, order: 1 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
          h('div', { style: { flex: 1, fontSize: 13, fontWeight: 600, color: T.text } }, pending.question || L('选一个音色，可以先听听', 'Choose a voice. You can listen first')),
          h('button', { type: 'button', onClick: close, style: { ...S.button, height: 24 } }, L('关闭', 'Close'))),
        h(CompareList, { key: pending.id, voices: pending.voices, initialText: pending.sampleText, onPick, pickLabel: L('选这个', 'Choose') }),
        error ? h('div', { style: { fontSize: 12, color: T.danger, marginTop: 6 } }, error) : null)
    }

    // —— 右侧栏：音色库。三家分栏，讯飞那栏很长，可以折叠 ——
    const PAGE = 60
    const SECTIONS_KEY = 'dsh-voice-engine.sections'
    const loadOpen = () => {
      try {
        return { xfyun: false, edge: true, ming: true, ...JSON.parse(window.localStorage.getItem(SECTIONS_KEY) ?? '{}') }
      } catch {
        return { xfyun: false, edge: true, ming: true }
      }
    }
    const ENGINE_TAG = {
      xfyun: () => ({ text: L('扣讯飞额度 · 超拟人能查读音', 'Uses iFLYTEK quota · hyper voices report pronunciation'), color: T.secondary }),
      edge: () => ({ text: L('免费 · 联网（微软）', 'Free · online (Microsoft)'), color: T.ok }),
      ming: () => ({ text: L('免费 · 本机合成', 'Free · on this Mac'), color: T.ok }),
    }

    function Section({ id, title, count, open, onToggle, children }) {
      const tag = ENGINE_TAG[id]()
      return h('div', { 'data-voice-section': id, style: { borderTop: `0.5px solid ${T.border}`, marginTop: 10 } },
        h('button', { type: 'button', onClick: () => onToggle(id), 'aria-expanded': open, style: { display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '9px 0', border: 'none', background: 'transparent', color: T.text, cursor: 'pointer', textAlign: 'left' } },
          h('span', { style: { width: 12, color: T.secondary } }, open ? '▾' : '▸'),
          h('span', { style: { fontSize: 13.5, fontWeight: 600 } }, title),
          h('span', { style: { fontSize: 12, color: T.secondary } }, count === null ? '' : L(`${count} 个`, `${count}`)),
          h('span', { style: { marginLeft: 'auto', fontSize: 11, color: tag.color } }, tag.text)),
        open ? h('div', null, children) : null)
    }

    /** Edge、Ming 不可用时说明原因；Edge 可以一键装 */
    function EngineNote({ engine, status, onInstalled }) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      if (!status || status.ready) return null
      const install = async () => {
        setBusy(true)
        setError('')
        try {
          await api('installEdge', {}, 600000)
          onInstalled()
        } catch (e) {
          setError(e.message)
        } finally {
          setBusy(false)
        }
      }
      return h('div', { style: { ...S.muted, padding: '6px 8px', borderRadius: 7, background: T.layer, marginBottom: 6 } },
        status.reason, status.fix ? `。${status.fix}` : '',
        engine === 'edge' ? h('button', { type: 'button', onClick: install, disabled: busy, style: { ...S.button, height: 22, padding: '0 7px', fontSize: 11.5, marginLeft: 4 } }, busy ? L('安装中…', 'Installing…') : L('安装', 'Install')) : null,
        error ? h('div', { style: { color: T.danger } }, error) : null)
    }

    /** 日常用：输入文字，用默认音色读出来，可以存成文件 */
    function ReadAloud({ voice }) {
      usePlayer()
      const [text, setText] = useState('')
      const [error, setError] = useState('')
      const [done, setDone] = useState(null)
      const clean = text.trim()
      const key = `read:${voice?.code}:${clean}`
      const paid = voice?.engine === 'xfyun'
      const chars = [...clean].filter((c) => !/\s/.test(c)).length
      useEffect(() => setDone(null), [clean, voice?.code])
      const speak = () => {
        setError('')
        play(key, { code: voice.code, text: clean }).then((r) => { if (r) setDone(r) }).catch((e) => setError(e.message))
      }
      const save = async () => {
        setError('')
        try {
          // 刚读过，服务端有缓存，再取一次不重复扣字
          const res = await post(AUDIO_API, { code: voice.code, text: clean }, 180000)
          if (!String(res.headers.get('content-type') ?? '').startsWith('audio/')) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
          const blob = await res.blob()
          const link = document.createElement('a')
          link.href = URL.createObjectURL(blob)
          link.download = `${[...clean.replace(/[^\p{L}\p{N}]+/gu, '')].slice(0, 12).join('') || 'voice'}.${blob.type.includes('wav') ? 'wav' : 'mp3'}`
          link.click()
          setTimeout(() => URL.revokeObjectURL(link.href), 5000)
        } catch (e) {
          setError(e.message)
        }
      }
      if (!voice) return null
      const playing = player.key === key
      return h('div', { 'data-voice-read': '', style: { ...S.card, padding: 10, margin: '0 0 8px' } },
        h('textarea', { value: text, rows: 2, onChange: (e) => setText(e.target.value), placeholder: L(`输入文字，用默认音色（${voice.name}）读出来`, `Type text to read with the default voice (${voice.name})`), style: { ...S.input, height: 'auto', padding: '6px 8px', resize: 'vertical', lineHeight: 1.5 } }),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' } },
          h('button', { type: 'button', onClick: speak, disabled: !clean, style: { ...S.primary, ...(!clean ? { opacity: 0.45, cursor: 'default' } : {}) } }, playing ? (player.loading ? L('合成中…', 'Working…') : L('停止', 'Stop')) : L('朗读', 'Read aloud')),
          h('button', { type: 'button', onClick: save, disabled: !done, title: done ? '' : L('先朗读一次', 'Read it first'), style: { ...S.button, ...(!done ? { opacity: 0.45, cursor: 'default' } : {}) } }, L('存成文件', 'Save as file')),
          h('span', { style: { fontSize: 11.5, color: paid ? T.secondary : T.ok } },
            done ? [done.durationMs ? L(`${(done.durationMs / 1000).toFixed(1)} 秒 · `, `${(done.durationMs / 1000).toFixed(1)}s · `) : '', done.charged ? L(`扣了 ${done.charged} 字`, `used ${done.charged} characters`) : L('没扣字', 'free')].join('')
              : clean ? (paid ? L(`讯飞，约扣 ${chars} 字`, `iFLYTEK, about ${chars} characters`) : L('免费', 'Free')) : '')),
        error ? h('div', { style: { fontSize: 12, color: T.danger, marginTop: 6 } }, error) : null)
    }

    function VoiceLibrary(props) {
      const sessionId = props?.sessionId ? String(props.sessionId) : ''
      const [query, setQuery] = useState('')
      const [gender, setGender] = useState('')
      const [status, setStatus] = useState('')
      const [place, setPlace] = useState('')
      const [freeOnly, setFreeOnly] = useState(false)
      const [limit, setLimit] = useState(PAGE)
      const [result, setResult] = useState(null)
      const [others, setOthers] = useState({ edge: null, ming: null })
      const [meta, setMeta] = useState(null)
      const [open, setOpen] = useState(loadOpen)
      const [compare, setCompare] = useState([])
      const [error, setError] = useState('')
      const [listError, setListError] = useState('')
      const [notice, setNotice] = useState(null)
      const [scanning, setScanning] = useState(false)
      const [version, setVersion] = useState(0)
      const seq = useRef(0)
      const refresh = useCallback(() => setVersion((n) => n + 1), [])

      useEffect(() => {
        const apply = () => {
          if (library.query !== null) {
            setQuery(library.query)
            library.query = null
          }
        }
        apply()
        library.listeners.add(apply)
        return () => library.listeners.delete(apply)
      }, [])
      useEffect(() => {
        api('voiceMeta').then(setMeta).catch((e) => setError(e.message))
      }, [version])
      useEffect(() => {
        const mine = ++seq.current
        const [kind, value] = place.split(':')
        const timer = setTimeout(() => {
          api('voices', { query, gender, status, sample: freeOnly, limit, trialText: TRY_TEXT(), ...(kind === 'lang' ? { lang: value } : kind === 'dialect' ? { dialect: value } : {}) }).then((r) => {
            if (seq.current !== mine) return
            setResult(r)
            setListError('') // 只清列表自己的错误，别的请求报的错不能被它清掉
          }).catch((e) => {
            if (seq.current === mine) setListError(e.message)
          })
          Promise.all(['edge', 'ming'].map((engine) => api('voices', { engine, query, gender }).catch(() => null))).then(([edge, ming]) => {
            if (seq.current === mine) setOthers({ edge, ming })
          })
        }, 200)
        return () => clearTimeout(timer)
      }, [query, gender, status, place, freeOnly, limit, version])
      useEffect(() => setLimit(PAGE), [query, gender, status, place, freeOnly])

      const toggle = (id) => setOpen((old) => {
        const next = { ...old, [id]: !old[id] }
        try {
          window.localStorage.setItem(SECTIONS_KEY, JSON.stringify(next))
        } catch {
          // 存不了就只在这次有效
        }
        return next
      })
      const isDefault = (voice) => meta?.default?.code === voice.code
      const onUse = async (voice) => {
        try {
          const r = await api('setDefault', { code: voice.code })
          setMeta((old) => ({ ...old, default: r.default }))
          setNotice({ voice })
        } catch (e) {
          setError(e.message)
        }
      }
      const tellAi = async (voice) => {
        const outcome = await sendToChat(sessionId, pickText(voice))
        setNotice(outcome === 'sent' ? { text: L(`已告诉 AI：选 ${voice.name}`, `Told the AI: ${voice.name}`) } : { error: (SEND_ERROR[outcome] ?? SEND_ERROR.none)() })
      }
      const toggleCompare = (voice) => {
        setCompare((old) => {
          if (old.some((v) => v.code === voice.code)) return old.filter((v) => v.code !== voice.code)
          if (old.length >= MAX_COMPARE) {
            setError(L(`最多对比 ${MAX_COMPARE} 个`, `Compare up to ${MAX_COMPARE}`))
            return old
          }
          setError('')
          return [...old, voice]
        })
      }
      const scan = async () => {
        setScanning(true)
        setError('')
        try {
          const r = await api('scan', {}, 300000)
          setNotice({ text: L(`找到 ${r.scan.ok.length} 个能用的音色`, `Found ${r.scan.ok.length} ready voices`) })
          setStatus('ok')
          refresh()
        } catch (e) {
          setError(e.message)
        } finally {
          setScanning(false)
        }
      }
      const untested = meta ? meta.total - meta.readyCount - meta.deniedCount : 0
      const placeLabel = (code) => (LANGS[code] ? L(LANGS[code][0], LANGS[code][1]) : code)
      const row = (voice) => h(VoiceRow, { key: voice.code, voice, isDefault: isDefault(voice), onPick: onUse, compared: compare.some((v) => v.code === voice.code), onCompare: toggleCompare, onChanged: refresh })
      const small = { ...S.button, height: 22, padding: '0 7px', fontSize: 11.5 }

      return h('div', { 'data-voice-library': '', style: { height: '100%', overflowY: 'auto', padding: '12px 14px', boxSizing: 'border-box', color: T.text, fontSize: 13 } },
        meta ? h('div', { style: { fontSize: 12.5, marginBottom: 8 } },
          L('默认音色：', 'Default voice: '),
          h('strong', null, meta.default.name),
          meta.default.engine && meta.default.engine !== 'xfyun' ? h('span', { style: { color: T.secondary } }, ` · ${meta.default.engine === 'edge' ? 'Edge' : 'Ming'}`) : null,
          meta.default.chosen ? null : h('span', { style: { color: T.secondary } }, L('（自动选择）', ' (automatic)'))) : null,
        meta ? h(ReadAloud, { voice: meta.default }) : null,
        h('input', { value: query, onChange: (e) => setQuery(e.target.value), placeholder: L('名字、拼音、用途…', 'Name, pinyin, use…'), style: S.input }),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6, alignItems: 'center' } },
          USE_CHIPS().map((chip) => h('button', { key: chip, type: 'button', onClick: () => setQuery(query === chip ? '' : chip), style: { ...small, ...(query === chip ? { borderColor: T.accent, color: T.accent } : {}) } }, chip)),
          h('select', { 'aria-label': L('声线', 'Voice type'), value: gender, onChange: (e) => setGender(e.target.value), style: { ...S.input, width: 'auto', height: 22, fontSize: 11.5, marginLeft: 'auto' } },
            h('option', { value: '' }, L('全部声线', 'All voices')),
            h('option', { value: 'female' }, L('女声', 'Female')),
            h('option', { value: 'male' }, L('男声', 'Male')),
            h('option', { value: 'child' }, L('童声', 'Child')))),
        notice?.voice ? h('div', { style: { ...S.muted, color: T.ok, marginTop: 6 } },
          L(`已设为默认音色：${notice.voice.name}，之后不指定音色时都用它。`, `${notice.voice.name} is now the default voice.`),
          sessionId ? h('button', { type: 'button', onClick: () => tellAi(notice.voice), style: { ...small, marginLeft: 4 } }, L('也告诉当前对话', 'Tell this conversation')) : null) : null,
        notice?.text ? h('div', { style: { ...S.muted, color: T.ok, marginTop: 6 } }, notice.text) : null,
        notice?.error ? h('div', { style: { ...S.muted, color: T.danger, marginTop: 6 } }, notice.error) : null,
        error || listError ? h('div', { style: { ...S.muted, color: T.danger, marginTop: 6 } }, error || listError) : null,
        compare.length ? h('div', { style: { ...S.card, padding: 10, margin: '8px 0 0' } },
          h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: 6 } },
            h('div', { style: { ...S.title, flex: 1, marginBottom: 0 } }, L(`对比 ${compare.length} 个音色`, `Comparing ${compare.length}`)),
            h('button', { type: 'button', onClick: () => { stopPlayer(); setCompare([]) }, style: small }, L('清空', 'Clear'))),
          h(CompareList, { voices: compare, isDefault, onPick: onUse, onRemove: toggleCompare, onChanged: refresh })) : null,

        h(Section, { id: 'xfyun', title: L('讯飞', 'iFLYTEK'), count: result?.total ?? null, open: open.xfyun, onToggle: toggle },
          h('div', { style: { display: 'flex', gap: 6 } },
            h('select', { 'aria-label': L('语种和方言', 'Language and dialect'), value: place, onChange: (e) => setPlace(e.target.value), style: { ...S.input, flex: 1, minWidth: 0 } },
              h('option', { value: '' }, L('全部语种', 'All languages')),
              (meta?.facets.langs ?? []).map((f) => h('option', { key: f.value, value: `lang:${f.value}` }, `${placeLabel(f.value)} ${f.count}`)),
              (meta?.facets.dialects ?? []).map((f) => h('option', { key: f.value, value: `dialect:${f.value}` }, `${f.value}${L('话', '')} ${f.count}`))),
            h('select', { 'aria-label': L('状态', 'Status'), value: status, onChange: (e) => setStatus(e.target.value), style: { ...S.input, flex: 1, minWidth: 0 } },
              h('option', { value: '' }, L('全部状态', 'Any status')),
              h('option', { value: 'ok' }, L('可用', 'Ready')),
              h('option', { value: 'unknown' }, L('未试过', 'Untested')),
              h('option', { value: 'denied' }, L('未授权', 'Not licensed')))),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 12, color: T.secondary, cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: freeOnly, onChange: (e) => setFreeOnly(e.target.checked) }),
            L('只看有免费样音的', 'Only voices with a free sample')),
          meta?.configured && untested > 0 ? h('div', { style: { ...S.muted, marginTop: 6, padding: '6px 8px', borderRadius: 7, background: T.layer } },
            L(`已确认能用 ${meta.readyCount} 个，还有 ${untested} 个没试过。`, `${meta.readyCount} confirmed ready, ${untested} untested. `),
            h('button', { type: 'button', onClick: scan, disabled: scanning, style: { ...small, marginLeft: 4 } }, scanning ? L('查找中，约一分钟…', 'Scanning…') : L('找出能用的', 'Find ready voices')),
            h('div', { style: { fontSize: 11 } }, L(`只查超拟人音色：未授权的不扣字，能用的每个扣 2 字，最多约 ${meta.hyperTotal * 2} 字。`, `Hyper voices only. Unlicensed are free, ready ones use 2 characters each, about ${meta.hyperTotal * 2} at most.`))) : null,
          !meta?.configured && meta ? h('div', { style: { ...S.muted, marginTop: 6 } }, L('免费样音可以直接听。要合成试听，先到「设置 → 声音引擎」填写凭据。', 'Free samples play right away. To synthesize, add credentials in Settings → Voice Engine.')) : null,
          result && !result.total ? h('div', { style: { ...S.muted, padding: '12px 0' } }, L('没有匹配的音色。放宽条件试试。', 'No matching voices. Try fewer filters.')) : null,
          (result?.voices ?? []).map(row),
          result && result.total > result.voices.length ? h('button', { type: 'button', onClick: () => setLimit((n) => n + PAGE), style: { ...S.button, width: '100%', marginTop: 8 } }, L(`再显示一些（还有 ${result.total - result.voices.length} 个）`, `Show more (${result.total - result.voices.length} left)`)) : null),

        ['edge', 'ming'].map((engine) => h(Section, { key: engine, id: engine, title: engine === 'edge' ? 'Edge' : 'Ming', count: others[engine]?.total ?? null, open: open[engine], onToggle: toggle },
          h(EngineNote, { engine, status: meta?.engines?.[engine], onInstalled: refresh }),
          others[engine] && !others[engine].total ? h('div', { style: { ...S.muted, padding: '8px 0' } }, L('没有匹配的音色。', 'No matching voices.')) : null,
          (others[engine]?.voices ?? []).map(row))))
    }

    // —— 设置页 ——
    function DoctorResult({ report }) {
      if (!report) return null
      return h('div', { style: { marginTop: 10 } },
        report.steps.map((step) => h('div', { key: step.id, style: { fontSize: 12.5, lineHeight: 1.6, marginBottom: 4 } },
          h('span', { style: { color: step.ok ? T.ok : T.danger, marginRight: 6 } }, step.ok ? '✓' : '✗'),
          `${step.title}：${step.detail}`,
          step.fix ? h('div', { style: { ...S.muted, marginLeft: 18 } }, step.fix) : null)))
    }

    /** 声音引擎接口：别的产品怎么用、开没开、讯飞是否对外 */
    function EngineCard() {
      const [info, setInfo] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      useEffect(() => {
        api('engineInfo').then(setInfo).catch((e) => setError(e.message))
      }, [])
      const change = async (patch) => {
        setBusy(true)
        setError('')
        try {
          setInfo(await api('engineSettings', patch))
        } catch (e) {
          setError(e.message)
        } finally {
          setBusy(false)
        }
      }
      if (!info) return error ? h('div', { style: S.card }, h('div', { style: { ...S.muted, color: T.danger } }, error)) : null
      const engines = info.engines ?? {}
      const line = (id, label) => {
        const e = engines[id] ?? {}
        return h('div', { key: id, style: { fontSize: 12.5, lineHeight: 1.7 } },
          h('span', { style: { color: e.ready ? T.ok : T.tertiary, marginRight: 6 } }, e.ready ? '✓' : '·'),
          `${label}：`, e.ready ? e.note : `${e.reason ?? L('用不了', 'Unavailable')}${e.fix ? `。${e.fix}` : ''}`)
      }
      return h('div', { style: S.card },
        h('div', { style: S.title }, L('声音引擎接口', 'Voice engine API')),
        h('div', { style: { ...S.muted, marginBottom: 8 } }, L('别的插件和产品可以通过本机接口用这里的声音：讯飞、Edge、Ming 一个接口全有。说明在插件目录的 docs/声音引擎接口.md。', 'Other plugins and apps can use these voices through a local API: iFLYTEK, Edge and Ming behind one interface. See docs/声音引擎接口.md in the plugin folder.')),
        line('xfyun', L('讯飞', 'iFLYTEK')), line('edge', 'Edge'), line('ming', 'Ming'),
        h('label', { style: { display: 'flex', gap: 8, alignItems: 'flex-start', margin: '10px 0 6px', cursor: 'pointer' } },
          h('input', { type: 'checkbox', checked: info.enabled, disabled: busy, onChange: (e) => change({ engineApi: e.target.checked }), style: { marginTop: 3 } }),
          h('span', null,
            h('div', null, L('打开接口', 'Enable the API')),
            h('div', { style: S.muted }, info.running ? L(`正在运行：${info.url}。只有本机能连，要带令牌。地址和令牌在 ${info.file}`, `Running at ${info.url}. Local only, token required. Address and token are in ${info.file}`) : L('没有运行', 'Not running')))),
        h('label', { style: { display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' } },
          h('input', { type: 'checkbox', checked: info.allowXfyun, disabled: busy || !info.enabled, onChange: (e) => change({ engineAllowXfyun: e.target.checked }), style: { marginTop: 3 } }),
          h('span', null,
            h('div', null, L('允许别的产品用讯飞', 'Let other apps use iFLYTEK')),
            h('div', { style: S.muted }, L('会扣你的讯飞额度，一次最多按上面的确认阈值。不打开时，别的产品只能用免费的 Edge 和 Ming。', 'This uses your iFLYTEK quota, capped per request by the threshold above. When off, other apps can only use the free Edge and Ming voices.')))),
        error ? h('div', { style: { ...S.muted, color: T.danger, marginTop: 8 } }, error) : null)
    }

    function SettingsSection() {
      const [status, setStatus] = useState(null)
      const [form, setForm] = useState({ appId: '', apiSecret: '', apiKey: '' })
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [report, setReport] = useState(null)
      const [notice, setNotice] = useState('')

      const refresh = useCallback(() => api('status').then(setStatus).catch((e) => setError(e.message)), [])
      useEffect(() => {
        refresh()
      }, [refresh])

      const run = async (name, fn) => {
        setBusy(name)
        setError('')
        setNotice('')
        try {
          await fn()
        } catch (e) {
          setError(e.message)
        } finally {
          setBusy('')
        }
      }
      const save = () => run('save', async () => {
        const r = await api('saveCredentials', form, 60000)
        setForm({ appId: '', apiSecret: '', apiKey: '' })
        setStatus(r.status)
        setReport(r.doctor)
        if (r.swapped) setNotice(L('APIKey 和 APISecret 填反了，已自动调回', 'APIKey and APISecret were swapped. Fixed automatically'))
      })
      const check = () => run('check', async () => {
        const r = await api('doctor', {}, 60000)
        setReport(r.doctor)
        await refresh()
      })
      const scan = () => run('scan', async () => {
        const r = await api('scan', {}, 300000)
        setStatus(r.status)
        setNotice(L(`试了 ${r.scan.total} 个超拟人音色，${r.scan.ok.length} 个可用`, `Tried ${r.scan.total} hyper voices, ${r.scan.ok.length} ready`))
      })
      const clear = () => run('clear', async () => {
        const r = await api('clearCredentials')
        setStatus(r.status)
        setReport(null)
      })
      const setSetting = (patch) => run('settings', async () => {
        await api('settings', patch)
        await refresh()
      })

      const configured = status?.credentials?.configured
      const field = (key, label, type) => h('label', { key, style: { display: 'block', marginBottom: 8 } },
        h('div', { style: { fontSize: 12, color: T.secondary, marginBottom: 3 } }, label),
        h('input', { type, autoComplete: 'off', spellCheck: false, value: form[key], onChange: (e) => setForm({ ...form, [key]: e.target.value }), style: S.input }))
      const ready = (status?.scenes ?? []).filter((s) => s.status === 'available')

      return h('div', { style: { color: T.text, fontSize: 13, maxWidth: 620 } },
        h('div', { style: S.card },
          h('div', { style: S.title }, L('讯飞凭据', 'iFLYTEK credentials')),
          configured
            ? h('div', { style: { ...S.muted, marginBottom: 10 } },
                L(`已配置（AppID 尾号 ${status.credentials.appIdTail}）${status.credentials.source === 'env' ? '，来自环境变量' : ''}。今天本机合成 ${status.today.chars} 字。`, `Configured (AppID ends in ${status.credentials.appIdTail})${status.credentials.source === 'env' ? ' from environment variables' : ''}. ${status.today.chars} characters synthesized here today.`))
            : h('div', { style: { ...S.muted, marginBottom: 10 } },
                L('在讯飞控制台的语音服务页右上角复制这三项，密钥只保存在本机。', 'Copy these three from the speech service page in the iFLYTEK console. They stay on this computer.'),
                status?.credentials?.problem ? h('div', { style: { color: T.danger } }, status.credentials.problem) : null),
          field('appId', 'APPID', 'text'),
          field('apiSecret', 'APISecret', 'password'),
          field('apiKey', 'APIKey', 'password'),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
            h('button', { type: 'button', onClick: save, disabled: Boolean(busy) || !form.appId || !form.apiKey || !form.apiSecret, style: { ...S.primary, ...(!form.appId || !form.apiKey || !form.apiSecret ? { opacity: 0.45, cursor: 'default' } : {}) } }, busy === 'save' ? L('检测中…', 'Checking…') : L('保存并检测', 'Save and check')),
            h('button', { type: 'button', onClick: check, disabled: Boolean(busy), style: S.button }, busy === 'check' ? L('检测中…', 'Checking…') : L('检测', 'Check')),
            configured ? h('button', { type: 'button', onClick: scan, disabled: Boolean(busy), style: S.button, title: L('未授权的音色不扣量，可用的每个合成两个字', 'Unlicensed voices are free to test. Ready ones use two characters each') }, busy === 'scan' ? L('扫描中，约一分钟…', 'Scanning, about a minute…') : L('找出能用的音色', 'Find ready voices')) : null,
            configured && status.credentials.source !== 'env' ? h('button', { type: 'button', onClick: clear, disabled: Boolean(busy), style: S.button }, L('清除凭据', 'Clear credentials')) : null),
          notice ? h('div', { style: { ...S.muted, color: T.ok, marginTop: 8 } }, notice) : null,
          error ? h('div', { style: { ...S.muted, color: T.danger, marginTop: 8 } }, error) : null,
          h(DoctorResult, { report })),

        status ? h('div', { style: S.card },
          h('div', { style: S.title }, L('使用', 'Usage')),
          h('div', { style: { ...S.muted, marginBottom: 10 } }, L(`默认音色：${status.default.name}${status.default.chosen ? '' : '（自动选择）'}。在对话页右侧栏的「声音引擎」里试听、对比、更换，或发 /voice-list 打开。`, `Default voice: ${status.default.name}${status.default.chosen ? '' : ' (automatic)'}. Listen, compare, and change it under Voice Engine in the right sidebar of a conversation, or send /voice-list.`)),
          h('label', { style: { display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 10, cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: status.settings.guard, disabled: Boolean(busy), onChange: (e) => setSetting({ guard: e.target.checked }), style: { marginTop: 3 } }),
            h('span', null,
              h('div', null, L('语音需求优先用讯飞', 'Use iFLYTEK first for speech')),
              h('div', { style: S.muted }, L('AI 不去网上找别的产品，也不运行 edge-tts 等语音工具。其他插件自己的功能不受影响。单个对话要放行，发 /voice-allow <名字>。', 'The AI will not look for other products or run tools like edge-tts. Other plugins keep working. To allow one in a conversation, send /voice-allow <name>.')))),
          h('label', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h('span', null, L('一次合成超过多少字先问我', 'Ask before synthesizing more than')),
            h('input', {
              type: 'number',
              min: 100,
              defaultValue: status.settings.confirmChars,
              onBlur: (e) => {
                const value = Number(e.target.value)
                if (Number.isInteger(value) && value >= 100 && value !== status.settings.confirmChars) setSetting({ confirmChars: value })
              },
              style: { ...S.input, width: 90 },
            }))) : null,

        status ? h(EngineCard) : null,

        status ? h('div', { style: S.card },
          h('div', { style: S.title }, L(`场景（${ready.length} / ${status.scenes.length} 可用）`, `Scenes (${ready.length} of ${status.scenes.length} ready)`)),
          h('div', { style: S.muted }, L('直接在对话里说需求就行，比如：', 'Just say what you need in a conversation, for example:')),
          ready.map((scene) => h('div', { key: scene.id, style: { fontSize: 12.5, lineHeight: 1.7 } }, `${scene.name}：「${scene.say}」`)),
          h('div', { style: { ...S.muted, marginTop: 8 } }, L('命令清单发 /voice-help，音色库在对话页右侧栏。', 'For commands send /voice-help. The voice library is in the right sidebar of a conversation.'))) : null)
    }

    // —— 挂载 ——
    const name = 'dsh-voice-engine-client'
    const inject = ['slots']
    const SIDEBAR_TAB_ID = 'dsh-voice-engine/voices'
    const SIDEBAR_KIND = 'dsh-voice-engine-voices'
    const GuideIcon = () => h('span', { style: { fontSize: 20 } }, '🎙')

    function apply(ctx) {
      try {
        ctx.inject?.(['locale'], (scope) => {
          const svc = scope.locale ?? scope.get?.('locale')
          if (svc) localeSvc = svc
        })
      } catch (error) {
        console.warn('[dsh-voice-engine] 拿不到语言服务，按网页语言显示', error)
      }
      try {
        ctx.inject?.(['sessions', 'conversation'], (scope) => {
          const sessions = scope.get?.('sessions') ?? scope.sessions
          const reader = (sessionId) => {
            const actx = sessions?.scope?.(sessionId)
            const input = actx?.get?.('conversation')?.input?.for?.(actx)
            return input && typeof input.setDraft === 'function' && typeof input.submit === 'function' ? input : null
          }
          composerOf = reader
          scope.effect?.(() => () => {
            if (composerOf === reader) composerOf = null
          }, 'dsh-voice-engine: composer')
        })
      } catch (error) {
        console.warn('[dsh-voice-engine] 拿不到对话输入框', error)
      }
      try {
        ctx.inject?.(['sidebarRight', 'sidebarRightTabs'], (scope) => {
          const right = scope.get?.('sidebarRight') ?? scope.sidebarRight
          const tabs = scope.get?.('sidebarRightTabs') ?? scope.sidebarRightTabs
          if (!right?.openTab || !tabs?.register) return
          openSidebar = () => right.openTab(SIDEBAR_KIND)
          const effect = (fn, label) => (scope.effect ? scope.effect(fn, label) : fn())
          effect(() => tabs.register({
            id: SIDEBAR_TAB_ID,
            kind: SIDEBAR_KIND,
            priority: 'extension',
            keepMounted: true,
            title: () => L('声音引擎', 'Voice Engine'),
            guide: [{
              id: 'xfyun-voices',
              order: 70,
              title: () => L('声音引擎', 'Voice Engine'),
              description: () => L('找音色、试听、对比，选一个当默认', 'Find, listen, compare, and pick a default voice'),
              icon: GuideIcon,
            }],
          }), 'dsh-voice-engine: sidebar type')
          const slots = scope.slots ?? ctx.slots
          const body = () => slots.register({ name: 'sidebar.right.pane.tab', key: SIDEBAR_TAB_ID }, VoiceLibrary)
          effect(() => (slots.inject ? slots.inject('sidebar.right.pane.tab', body) : body()), 'dsh-voice-engine: sidebar body')
        })
      } catch (error) {
        console.warn('[dsh-voice-engine] 拿不到右侧栏', error)
      }
      try {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({ name: 'conversation.composer.dock', id: 'dsh-voice-engine', order: 45 }, PickerDock))
      } catch (error) {
        console.warn('[dsh-voice-engine] 音色候选条注册失败', error)
      }
      try {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: 'dsh-voice-engine', order: 40, label: () => L('声音引擎', 'Voice Engine') }, SettingsSection))
      } catch (error) {
        console.warn('[dsh-voice-engine] 设置页注册失败', error)
      }
    }

    module.exports = { name, inject, apply, __test: { L, sendToChat } }
    return module.exports
  },
})
