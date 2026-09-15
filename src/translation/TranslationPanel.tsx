// 翻译面板:手动输入/Ctrl+V/剪贴板建议/OCR 填入 → LLM 翻译 → 复制/朗读。
// 正文翻译保持专业;角色只在外围互动(App 的 onTranslated 回调)。
// 请求可取消(重复点翻译/停止/清空即中断上一次);结果只在内存,不落盘不入历史。
//
// 固定(📌):固定后点面板外部与 Esc 都不再收起,只能点 ✕ 关闭;
// 固定态存在 App(runtime overlays 的收起方在那边),会话内记住偏好。
//
// 剪贴板:打开面板时读一次剪贴板文字(clipboard_read_text;无文本/失败静默)——
// translation.autoClipboard 开 = 直接填入并翻译;关 = 只出提示条「检测到剪贴板内容
// [翻译剪贴板]」,由用户点一下才动手。OCR 注入链路优先,两者不同时发生。
import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { DEFAULT_CONFIG, getConfig, saveConfig, type CtrlBarPos, type TranslationConfig } from '../storage/configStore'
import { describeLlmError } from '../engine/llmClient'
import { speak, stopSpeaking } from '../engine/tts'
import { translate, MAX_INPUT_CHARS } from './translator'
import { LANGUAGES, STYLE_LABEL, langLabel, type TranslationResult, type TranslationStyle } from './types'
import { PANEL_ANCHOR } from '../ui/dockLayout'

/** OCR 链路塞进来的原文:auto=true 时填入后立即翻译(截图翻译入口) */
export interface TranslationInject {
  text: string
  nonce: number
  auto: boolean
}

interface Props {
  /** 命中区域锚点(穿透窗口里面板可点的前提) */
  innerRef: React.RefObject<HTMLDivElement | null>
  pos: CtrlBarPos
  inject: TranslationInject | null
  /** 固定态:点外部/Esc 不收起(App 的收起方读它);会话内记住 */
  pinned: boolean
  onPinChange: (pinned: boolean) => void
  onClose: () => void
  /** 框选屏幕区域 → OCR → 自动填入并翻译(截图链路由 App 编排) */
  onScreenshotTranslate: () => void
  /** 翻译成功回调(角色吐槽等外围互动) */
  onTranslated?: () => void
  /** 翻译状态回调(App 的道具桥据此切换角色旁的工具卡道具):
   *  running=开始翻译,done=真正完成,error=失败,idle=被用户取消。
   *  为什么:截图翻译的 utility 任务在 OCR 完成时就 done 了,但翻译才刚开始,
   *  道具的 success 必须等这里说了算 */
  onState?: (s: 'running' | 'done' | 'error' | 'idle') => void
}

export function TranslationPanel({
  innerRef,
  pos,
  inject,
  pinned,
  onPinChange,
  onClose,
  onScreenshotTranslate,
  onTranslated,
  onState,
}: Props) {
  const [cfg, setCfg] = useState<TranslationConfig>(DEFAULT_CONFIG.translation)
  const [input, setInput] = useState('')
  const [result, setResult] = useState<TranslationResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [speakOn, setSpeakOn] = useState(false)
  const [copied, setCopied] = useState(false)
  /** 打开时检测到的剪贴板文字(null = 没检测到/已消费);autoClipboard 开时不进提示条 */
  const [clipText, setClipText] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const injectedNonce = useRef(0)
  /** 剪贴板检测只做一次(面板每次打开重新挂载=重新检测);OCR 注入优先 */
  const clipChecked = useRef(false)
  // 卸载时只停面板自己发起的朗读,别掐掉演出正播的语音
  const speakOnRef = useRef(false)
  // 配置就绪前不跑剪贴板检测(autoClipboard 要读配置);run 走 ref 拿最新闭包
  const [cfgReady, setCfgReady] = useState(false)
  const runRef = useRef<(text?: string) => Promise<void>>(async () => {})

  useEffect(() => {
    let live = true
    void getConfig().then((c) => {
      if (live) {
        setCfg(c.translation)
        setCfgReady(true)
      }
    })
    return () => {
      live = false
      abortRef.current?.abort()
      if (speakOnRef.current) stopSpeaking()
    }
  }, [])

  /** 语言/风格/剪贴板开关改动即存盘;切换后不自动重发,由用户再点翻译 */
  function updateCfg(p: Partial<TranslationConfig>) {
    const next = { ...cfg, ...p }
    setCfg(next)
    void saveConfig({ translation: next }).catch((e) => console.warn('翻译配置保存失败(静默)', e))
  }

  function stopSpeak() {
    stopSpeaking()
    setSpeakOn(false)
    speakOnRef.current = false
  }

  async function run(textArg?: string) {
    const text = (textArg ?? input).trim()
    if (!text || busy) return
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setBusy(true)
    setErr('')
    setResult(null)
    stopSpeak()
    onState?.('running')
    // 被顶替(有新运行)时不动状态;被取消时撤掉常驻的翻译卡道具
    const abandoned = () => {
      if (abortRef.current !== ctrl) return true
      if (ctrl.signal.aborted) {
        onState?.('idle')
        return true
      }
      return false
    }
    try {
      const r = await translate(
        {
          text: text.slice(0, MAX_INPUT_CHARS),
          sourceLanguage: cfg.sourceLanguage,
          targetLanguage: cfg.targetLanguage,
          style: cfg.style,
        },
        ctrl.signal,
      )
      if (abandoned()) return
      setResult(r)
      onState?.('done')
      onTranslated?.()
      const live = await getConfig()
      if (live.translation.autoSpeak) {
        speak('A', r.translation, undefined, 'utility')
        setSpeakOn(true)
        speakOnRef.current = true
      }
    } catch (e) {
      if (abandoned()) return
      setErr(await describeLlmError(e))
      onState?.('error')
    } finally {
      if (abortRef.current === ctrl) setBusy(false)
    }
  }
  runRef.current = run

  // OCR 链路注入:填入原文;截图翻译入口自动开翻
  useEffect(() => {
    if (!inject || inject.nonce === injectedNonce.current) return
    injectedNonce.current = inject.nonce
    clipChecked.current = true // OCR 注入优先,同一次打开不再检测剪贴板
    setClipText(null)
    setInput(inject.text)
    setErr('')
    if (inject.auto) void run(inject.text)
    // run 是内联闭包,行为恒定;只跟注入事件走
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inject?.nonce])

  // 打开面板检测剪贴板(面板条件渲染,挂载即打开):有文字且与输入不同才提示;
  // autoClipboard 开 = 直接填入翻译,不提示
  useEffect(() => {
    if (!cfgReady || clipChecked.current) return
    clipChecked.current = true
    void (async () => {
      const raw = await invoke<string>('clipboard_read_text').catch(() => '')
      const text = raw.trim()
      if (!text) return
      if (cfg.autoClipboard) {
        setInput(text)
        void runRef.current(text)
      } else if (text !== input.trim()) {
        setClipText(text)
      }
    })()
    // 打开时检测一次;input 只是当时的比较基准,不参与重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfgReady])

  function consumeClipboard() {
    if (!clipText) return
    const text = clipText
    setClipText(null)
    setInput(text)
    void runRef.current(text)
  }

  function swapLangs() {
    const nextSrc = cfg.targetLanguage
    // 源是自动检测时,交换目标用上次识别结果;没识别过按中英互斥兜底
    const nextDst =
      cfg.sourceLanguage === 'auto'
        ? result?.detectedLanguage && result.detectedLanguage !== cfg.targetLanguage
          ? result.detectedLanguage
          : cfg.targetLanguage === 'zh-CN'
            ? 'en'
            : 'zh-CN'
        : cfg.sourceLanguage
    updateCfg({ sourceLanguage: nextSrc, targetLanguage: nextDst })
  }

  function clearAll() {
    abortRef.current?.abort()
    stopSpeak()
    setInput('')
    setResult(null)
    setErr('')
    setBusy(false)
  }

  async function copyResult() {
    if (!result?.translation) return
    try {
      await navigator.clipboard.writeText(result.translation)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setErr('复制失败:剪贴板被占用')
    }
  }

  function toggleSpeak() {
    if (speakOn) {
      stopSpeak()
      return
    }
    if (!result?.translation) return
    speak('A', result.translation, undefined, 'utility')
    setSpeakOn(true)
    speakOnRef.current = true
  }

  const srcOptions = [{ code: 'auto', label: '自动检测' }, ...LANGUAGES]

  return (
    <div
      ref={innerRef}
      className="tr-panel"
      style={{ left: `${pos.xPct}%`, top: pos.top + PANEL_ANCHOR }}
    >
      <div className="tr-head">
        <span className="tr-title">翻译</span>
        <button
          className={`tr-pin${pinned ? ' on' : ''}`}
          title={pinned ? '取消固定(点外部/Esc 会收起)' : '固定面板(点外部/Esc 不收起)'}
          onClick={() => onPinChange(!pinned)}
        >
          📌
        </button>
        <button className="tr-close" title="关闭" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="tr-langs">
        <select
          aria-label="源语言"
          value={cfg.sourceLanguage}
          onChange={(e) => updateCfg({ sourceLanguage: e.target.value })}
        >
          {srcOptions.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
        <button className="tr-swap" title="交换语言" onClick={swapLangs}>
          ⇄
        </button>
        <select
          aria-label="目标语言"
          value={cfg.targetLanguage}
          onChange={(e) => updateCfg({ targetLanguage: e.target.value })}
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </div>
      <div className="tr-styles">
        {(Object.keys(STYLE_LABEL) as TranslationStyle[]).map((s) => (
          <button
            key={s}
            className={`tr-style-btn${cfg.style === s ? ' on' : ''}`}
            onClick={() => updateCfg({ style: s })}
          >
            {STYLE_LABEL[s]}
          </button>
        ))}
      </div>
      {clipText && (
        <div className="tr-clip-hint">
          <span className="tr-clip-text">检测到剪贴板内容({clipText.length} 字)</span>
          <button className="panel-btn primary" onClick={consumeClipboard}>
            翻译剪贴板
          </button>
          <button
            className="tr-clip-dismiss"
            title="忽略"
            onClick={() => setClipText(null)}
          >
            ✕
          </button>
        </div>
      )}
      <div className="tr-label">原文</div>
      <textarea
        className="tr-input"
        rows={4}
        maxLength={MAX_INPUT_CHARS}
        placeholder="在这里输入或粘贴…(Ctrl+V,最多 6000 字)"
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />
      <div className="tr-actions">
        {busy ? (
          <button className="panel-btn" onClick={() => abortRef.current?.abort()}>
            停止
          </button>
        ) : (
          <button
            className="panel-btn primary"
            disabled={!input.trim()}
            onClick={() => void run()}
          >
            翻译
          </button>
        )}
        <button
          className="panel-btn"
          disabled={busy}
          title="框选屏幕区域,识别文字后自动翻译"
          onClick={onScreenshotTranslate}
        >
          截图翻译
        </button>
        {(input || result) && (
          <button className="panel-btn tr-clear" onClick={clearAll}>
            清空
          </button>
        )}
      </div>
      {err && <div className="tr-err">{err}</div>}
      {result && (
        <div className="tr-result-wrap">
          <div className="tr-result-head">
            <span className="tr-label">译文{result.detectedLanguage && (
              <span className="tr-detected" title="识别出的源语言">
                ({langLabel(result.detectedLanguage)})
              </span>
            )}</span>
            <div className="tr-actions">
              <button className="panel-btn" disabled={busy} onClick={() => void copyResult()}>
                {copied ? '已复制 ✓' : '复制'}
              </button>
              <button
                className="panel-btn"
                disabled={busy || !result.translation}
                title={speakOn ? '停止朗读' : '朗读译文'}
                onClick={toggleSpeak}
              >
                {speakOn ? '⏹' : '🔊'}
              </button>
            </div>
          </div>
          <div className="tr-result">{result.translation}</div>
          {result.alternatives.length > 0 && (
            <div className="tr-alt">
              <span className="tr-alt-tag">其他译法</span>
              {result.alternatives.map((a, i) => (
                <div key={i}>{a}</div>
              ))}
            </div>
          )}
          {result.notes.length > 0 && (
            <div className="tr-notes">
              {result.notes.map((n, i) => (
                <div key={i}>· {n}</div>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="tr-foot">
        <label className="tr-clip-auto">
          <input
            type="checkbox"
            checked={cfg.autoClipboard}
            onChange={(e) => updateCfg({ autoClipboard: e.target.checked })}
          />
          打开翻译时自动读取剪贴板
        </label>
        <span className="tr-privacy">文本会发送给当前配置的模型厂商;勿翻译密码密钥</span>
      </div>
    </div>
  )
}
