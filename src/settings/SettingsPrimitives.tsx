// 设置窗口的小部件:卡片容器、行/字段布局、开关,以及两个自带状态的特殊控件
// (全局快捷键录入器、音色克隆行)。只管呈现与自身交互,不含配置保存逻辑。
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { readFile, remove } from '@tauri-apps/plugin-fs'
import { beginRecording, endRecording } from '../runtime/runtimeMode'
import { cloneVoice, type ClonedVoice } from '../engine/tts'

/** 卡片:同组设置项的容器;card 是搜索跳转的定位键(同页内唯一),flash 时高亮 */
export function SettingsCard(props: {
  card: string
  flash?: string | null
  title: string
  desc?: string
  action?: ReactNode
  children: ReactNode
}) {
  const { card, flash, title, desc, action, children } = props
  return (
    <section className={`set-card${flash === card ? ' flash' : ''}`} data-card={card}>
      <div className="set-card-head">
        <h2>{title}</h2>
        {desc && <span className="set-card-desc">{desc}</span>}
        {action && <span className="set-card-action">{action}</span>}
      </div>
      {children}
    </section>
  )
}

/** 一行设置:左侧标题+说明,右侧控件 */
export function SetLine(props: { title: string; hint?: string; children: ReactNode }) {
  const { title, hint, children } = props
  return (
    <div className="set-line">
      <div className="set-copy">
        <span className="set-label">{title}</span>
        {hint && <span className="set-hint">{hint}</span>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  )
}

/** 竖排字段:标签在上,控件在下(文本输入/下拉/文本域) */
export function SetField(props: { label: string; htmlFor?: string; hint?: string; children: ReactNode }) {
  const { label, htmlFor, hint, children } = props
  return (
    <div className="set-field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <span className="set-hint">{hint}</span>}
    </div>
  )
}

/** 开关:紫色仅用于开关等交互强调态 */
export function SetSwitch(props: { checked: boolean; label?: string; onChange: (v: boolean) => void }) {
  const { checked, label, onChange } = props
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      className={`set-switch${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
    />
  )
}

/** 音色克隆行:选一段 10~20 秒的清晰人声(说话内容与文本一致),上传后成为账号下的克隆音色。
 *  也支持从正在播放声音的应用直接录一段(进程环回,隔离其他软件声音)。
 *  克隆成功自动选中给角色乙(通常捧哏换个有味道的声线) */
export function CloneVoiceRow({
  apiKey,
  onCloned,
}: {
  apiKey: string
  onCloned: (v: ClonedVoice) => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const [state, setState] = useState<'idle' | 'busy' | 'ok' | 'error'>('idle')
  const [errMsg, setErrMsg] = useState('')
  // 应用声音录制:会话列表/选中项/录音状态与计时
  const [sessions, setSessions] = useState<{ pid: number; name: string; playing: boolean }[]>([])
  const [targetFilter, setTargetFilter] = useState('')
  const [target, setTarget] = useState<string>('')
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const recordingRef = useRef(false)
  const togglingRef = useRef(false) // 录音按钮防抖:命令在途时忽略重复点击
  const capturePathRef = useRef<string | null>(null) // 本次录音的 wav 落盘路径(克隆成功后清理)

  /** 删除本次录音的 wav(克隆已用完/面板中途取消) */
  function discardCapture(path: string | null) {
    if (!path) return
    capturePathRef.current = null
    void remove(path).catch(() => {})
  }

  // 计时器 + 卸载保险:面板若在此期间被关闭/卸载,自动停录并丢弃半成品,不留孤儿线程/文件
  useEffect(() => {
    if (!recording) return
    const t = window.setInterval(() => setElapsed((s) => s + 1), 1000)
    return () => {
      window.clearInterval(t)
      if (recordingRef.current) {
        void invoke<string>('stop_capture')
          .then((p) => remove(p).catch(() => {}))
          .catch(() => {})
        recordingRef.current = false
        endRecording()
      }
    }
  }, [recording])

  /** 收尾一次录音:取回文件、复位 UI。手动停止与 180s 自动停共用 */
  async function finishRecording() {
    const path = await invoke<string>('stop_capture') // 同时清掉后端 job,线程已结束时立即返回
    const bytes = await readFile(path)
    capturePathRef.current = path
    setFile(new File([bytes], path.split(/[\\/]/).pop() ?? 'capture.wav', { type: 'audio/wav' }))
    recordingRef.current = false
    setRecording(false)
    endRecording()
  }

  // 后端录音线程意外结束(设备失效/目标进程异常 → 报错;达到 180s 上限 → 自动停):
  // 把前端拉回一致状态并清后端残留 job。手动停止的正常事件由 toggleRecord 收尾,这里跳过
  useEffect(() => {
    const un = listen<{ ok: boolean; path?: string; error?: string; auto: boolean }>(
      'capture-ended',
      (e) => {
        if (!recordingRef.current) return
        if (e.payload.ok && !e.payload.auto) return
        recordingRef.current = false
        setRecording(false)
        endRecording()
        if (!e.payload.ok) {
          setErrMsg(String(e.payload.error ?? '录音意外结束').slice(0, 120))
          setState('error')
          void invoke('stop_capture').catch(() => {}) // 清残留 job,下次才能再录
          return
        }
        void finishRecording().catch(() => {
          void invoke('stop_capture').catch(() => {})
        })
      },
    )
    return () => {
      void un.then((f) => f())
    }
  }, [])

  if (!apiKey.trim()) return null

  async function refreshSessions() {
    try {
      const list = await invoke<{ pid: number; name: string; playing: boolean }[]>('list_audio_sessions')
      setSessions(list)
    } catch (e) {
      console.warn('应用声音会话列表拉取失败', e)
    }
  }

  async function toggleRecord() {
    if (togglingRef.current) return // 命令在途,防双击造成"已有录音/没有录音"误报
    togglingRef.current = true
    try {
      if (!recording) {
        try {
          await invoke('start_capture', {
            pid: target === 'system' || target === '' ? null : Number(target),
          })
          recordingRef.current = true
          setRecording(true)
          beginRecording() // 录音进统一运行态(调度器/Esc 锁定的闸门)
          setElapsed(0)
          discardCapture(capturePathRef.current) // 换新样本,旧录音不再需要
          setFile(null)
        } catch (e) {
          setErrMsg(String(e).slice(0, 120))
          setState('error')
        }
        return
      }
      try {
        await finishRecording()
      } catch (e) {
        recordingRef.current = false
        setRecording(false)
        endRecording()
        setErrMsg(String(e).slice(0, 120))
        setState('error')
      }
    } finally {
      togglingRef.current = false
    }
  }

  async function submit() {
    if (!file || !name.trim() || !text.trim()) return
    setState('busy')
    try {
      const v = await cloneVoice(apiKey, file, file.name, name.trim(), text.trim())
      discardCapture(capturePathRef.current) // 克隆成功,参考录音完成使命
      setState('ok')
      onCloned(v)
    } catch (e) {
      setState('error')
      setErrMsg((e as Error).message.slice(0, 120))
    }
  }

  return (
    <div className="settings-row clone-row" title="用一段真人录音克隆专属音色:内容需与文本一致,清晰无背景音乐">
      <label htmlFor="cfg-clone-file">克隆音色(选人声样本,或从应用录一段)</label>
      <div className="clone-fields">
        <input
          id="cfg-clone-file"
          type="file"
          accept="audio/*"
          onChange={(e) => {
            discardCapture(capturePathRef.current) // 改选手动文件,之前录的不再需要
            setFile(e.target.files?.[0] ?? null)
          }}
        />
        <div className="capture-fields">
          <input
            type="text"
            placeholder="过滤应用名…"
            value={targetFilter}
            onChange={(e) => setTargetFilter(e.target.value)}
          />
          <button
            className="panel-btn"
            title="重新拉取应用列表"
            onClick={() => void refreshSessions()}
          >
            ↻
          </button>
        </div>
        <div className="capture-fields">
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            onFocus={() => void refreshSessions()}
          >
            <option value="system">整个系统的声音</option>
            {sessions
              .filter((s) => s.name.toLowerCase().includes(targetFilter.toLowerCase()))
              .map((s) => (
                <option key={s.pid} value={String(s.pid)}>
                  {s.playing ? '🔊 ' : ''}
                  {s.name}
                </option>
              ))}
          </select>
          <button
            className="panel-btn"
            disabled={state === 'busy'}
            onClick={() => void toggleRecord()}
          >
            {recording ? `停止录制 (${elapsed}s)` : target === 'system' ? '录制系统' : '录制该应用'}
          </button>
        </div>
        {recording && (
          <span className="clone-tip warn">录音中:去目标应用播放声音即可;面板已锁定,点停止后恢复正常</span>
        )}
        {file && (
          <span className="clone-tip ok">
            样本:{file.name}({Math.round(file.size / 1024)}KB)
            {file.size < 100_000 && ' · 偏小:确认目标应用真的在发声、录满 10~20 秒再停'}
          </span>
        )}
        <input
          type="text"
          placeholder="音色名(如:up主小张)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          type="text"
          placeholder="录音里说的那句话(逐字)"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          className="panel-btn"
          disabled={!file || !name.trim() || !text.trim() || state === 'busy'}
          onClick={() => void submit()}
        >
          {state === 'busy' ? '上传中…' : '克隆'}
        </button>
      </div>
      {state === 'ok' && <span className="clone-tip ok">✓ 克隆成功,已选给角色乙</span>}
      {state === 'error' && <span className="clone-tip err">{errMsg}</span>}
    </div>
  )
}

/** 全局快捷键录入器:点击进入录入态,按下带修饰键的组合键即完成,Esc 取消。
 *  输出为 global-shortcut 接受的格式(Ctrl+Alt+A 这类)。无修饰键只收 F1~F12 单键:
 *  全局热键会吞键,字母/数字单键会让任何应用里打不出这个字符,常用功能键(Esc/Tab/F5)同理;
 *  F 键不用于文字输入,是单键绑定的唯一安全区(截图/录屏工具惯例) */
export function HotkeyRecorder({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [listening, setListening] = useState(false)
  // 无效按键的规则提示:无声退出会让人以为没反应,2.5s 后自动消失
  const [hint, setHint] = useState('')
  const hintTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(hintTimer.current), [])
  useEffect(() => {
    if (!listening) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setListening(false)
        return
      }
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return // 等主键
      const mods: string[] = []
      if (e.ctrlKey) mods.push('Ctrl')
      if (e.altKey) mods.push('Alt')
      if (e.shiftKey) mods.push('Shift')
      if (e.metaKey) mods.push('Super')
      if (mods.length === 0 && !/^F([1-9]|1[0-2])$/.test(e.key)) {
        setListening(false)
        setHint('需搭配 Ctrl/Alt/Shift;单键仅支持 F1~F12')
        window.clearTimeout(hintTimer.current)
        hintTimer.current = window.setTimeout(() => setHint(''), 2500)
        return
      }
      const main = e.key.length === 1 ? e.key.toUpperCase() : e.key
      onChange(mods.length === 0 ? main : `${mods.join('+')}+${main}`)
      setListening(false)
    }
    // 捕获阶段拦下,避免 Escape 冒泡把设置面板关掉
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [listening, onChange])
  return (
    <>
      <button className="panel-btn" onClick={() => { setHint(''); setListening(true) }}>
        {listening ? '按下组合键…(Esc 取消)' : value || '未设置'}
      </button>
      {hint && <span className="hotkey-hint">{hint}</span>}
    </>
  )
}
