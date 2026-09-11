// 控制栏:演出簇常驻(模式+生成/停止) + 工具/聊天/勿扰/设置四入口。
// 自带原生命中区注册与悬停高亮；WebView 保持穿透，点击由指针管理器合成，
// 拖动移动经 onPosChange 回 App 落盘。
// 新功能不再往栏上加按钮——注册进命令面板(features/commands)。
import { useEffect, useRef, useState } from 'react'
import { PlayIcon, StopIcon, GearIcon, PokeballIcon, ChatIcon, GridIcon, BellOffIcon } from '../stage/icons'
import { registerHitRegion, onHoverChange } from '../input/pointerManager'
import { useAllModes, type Mode } from '../performer/modes'
import type { CtrlBarPos } from '../storage/configStore'

interface Props {
  pos: CtrlBarPos
  /** 拖动产生的位置更新;persist 由组件按拖动状态给('no' 过程 | 'now' 落盘) */
  onPosChange: (next: CtrlBarPos, persist: 'now' | 'no') => void
  mode: Mode
  onModeChange: (m: Mode) => void
  busy: boolean
  canStop: boolean
  onGenerate: () => void
  onStop: () => void
  toolsOpen: boolean
  onTools: () => void
  chatOpen: boolean
  onChat: () => void
  dnd: boolean
  onDnd: () => void
  settingsOpen: boolean
  onSettings: () => void
}

const BAR_IDS = ['grip', 'modes', 'gen', 'stop', 'tools', 'chat', 'dnd', 'settings']

export function ControlBar({
  pos,
  onPosChange,
  mode,
  onModeChange,
  busy,
  canStop,
  onGenerate,
  onStop,
  toolsOpen,
  onTools,
  chatOpen,
  onChat,
  dnd,
  onDnd,
  settingsOpen,
  onSettings,
}: Props) {
  // 内置+自定义模式(模式工坊增删时重渲染,分段控件与滑块随之伸缩)
  const modeList = useAllModes()
  const [hovered, setHovered] = useState<string | null>(null)
  const gripRef = useRef<HTMLSpanElement>(null)
  const segCtl = useRef<HTMLDivElement>(null)
  const btnGen = useRef<HTMLButtonElement>(null)
  const btnStop = useRef<HTMLButtonElement>(null)
  const btnTools = useRef<HTMLButtonElement>(null)
  const btnChat = useRef<HTMLButtonElement>(null)
  const btnDnd = useRef<HTMLButtonElement>(null)
  const btnGear = useRef<HTMLButtonElement>(null)
  const dragRef = useRef<{ startX: number; startY: number; orig: CtrlBarPos; moved: boolean } | null>(null)

  // 悬停高亮:只关心栏内区域(角色/面板的悬停归 App 管)
  useEffect(() => {
    return onHoverChange((id) => {
      setHovered((prev) => {
        if (id !== null && (BAR_IDS as string[]).includes(id)) return id
        return prev !== null && (BAR_IDS as string[]).includes(prev) ? null : prev
      })
    })
  }, [])

  // 命中区注册:穿透架构下未注册区域收不到任何鼠标事件
  useEffect(() => {
    const unsubs = [
      registerHitRegion('grip', {
        getRect: () => gripRef.current!.getBoundingClientRect(),
        nativePointerTarget: () => gripRef.current,
      }),
      registerHitRegion('modes', {
        getRect: () => segCtl.current!.getBoundingClientRect(),
        nativePointerTarget: () => segCtl.current,
      }),
      registerHitRegion('gen', {
        getRect: () => btnGen.current!.getBoundingClientRect(),
        nativePointerTarget: () => btnGen.current,
      }),
      registerHitRegion('stop', {
        getRect: () => btnStop.current!.getBoundingClientRect(),
        nativePointerTarget: () => btnStop.current,
      }),
      registerHitRegion('tools', {
        getRect: () => btnTools.current!.getBoundingClientRect(),
        nativePointerTarget: () => btnTools.current,
      }),
      registerHitRegion('chat', {
        getRect: () => btnChat.current!.getBoundingClientRect(),
        nativePointerTarget: () => btnChat.current,
      }),
      registerHitRegion('dnd', {
        getRect: () => btnDnd.current!.getBoundingClientRect(),
        nativePointerTarget: () => btnDnd.current,
      }),
      registerHitRegion('settings', {
        getRect: () => btnGear.current!.getBoundingClientRect(),
        nativePointerTarget: () => btnGear.current,
      }),
    ]
    return () => unsubs.forEach((u) => u())
  }, [])

  function onBarPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    // 只响应把手及内部图标(图标已 pointer-events:none),按钮/分段控件不受影响
    if (!(e.target instanceof Node) || !e.currentTarget.contains(e.target)) return
    dragRef.current = { startX: e.clientX, startY: e.clientY, orig: { ...pos }, moved: false }
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      // 无活动指针可捕获时忽略
    }
  }

  function onBarPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 6) return // 小位移视为点击,留给收起/展开
      d.moved = true
    }
    onPosChange(
      {
        ...d.orig,
        xPct: Math.min(98, Math.max(2, d.orig.xPct + (dx / window.innerWidth) * 100)),
        top: Math.min(Math.max(0, window.innerHeight - 60), Math.max(0, d.orig.top + dy)),
      },
      'no',
    )
  }

  function onBarPointerUp() {
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    if (d.moved) onPosChange(pos, 'now')
    else onPosChange({ ...pos, collapsed: !pos.collapsed }, 'now') // 纯点击:收起/展开
  }

  return (
    <div className={`ctrl-bar${pos.collapsed ? ' collapsed' : ''}`} style={{ left: `${pos.xPct}%`, top: pos.top }}>
      <span
        ref={gripRef}
        className={`bar-grip${hovered === 'grip' ? ' hot' : ''}`}
        title={pos.collapsed ? '展开工具栏(点击)/拖动移动' : '收起工具栏(点击)/拖动移动'}
        onPointerDown={onBarPointerDown}
        onPointerMove={onBarPointerMove}
        onPointerUp={onBarPointerUp}
      >
        <PokeballIcon />
      </span>
      <div ref={segCtl} className={`seg${hovered === 'modes' ? ' hot' : ''}`}>
        <div
          className="seg-thumb"
          style={{
            width: `calc(${100 / modeList.length}% - 3px)`,
            transform: `translateX(${modeList.findIndex((m) => m.id === mode) * 100}%)`,
          }}
        />
        {modeList.map((m) => (
          <button key={m.id} className={`seg-btn${mode === m.id ? ' on' : ''}`} onClick={() => onModeChange(m.id)}>
            {m.label}
          </button>
        ))}
      </div>
      <span className="bar-sep" aria-hidden="true" />

      <button
        ref={btnGen}
        className={`ctrl-btn icon${hovered === 'gen' ? ' hot' : ''}${busy ? ' loading' : ''}`}
        disabled={busy}
        title={mode === 'live' ? '开播(直播弹幕互动)' : '生成'}
        onClick={onGenerate}
      >
        <PlayIcon />
      </button>

      <button
        ref={btnStop}
        className={`ctrl-btn icon${hovered === 'stop' ? ' hot' : ''}${canStop ? ' danger' : ''}`}
        disabled={!canStop}
        title="停止"
        onClick={onStop}
      >
        <StopIcon />
      </button>
      <span className="bar-sep" aria-hidden="true" />

      <button
        ref={btnTools}
        className={`ctrl-btn icon${hovered === 'tools' ? ' hot' : ''}${toolsOpen ? ' on' : ''}`}
        title="工具(翻译/截屏/提醒…搜命令或直接说)"
        onClick={onTools}
      >
        <GridIcon />
      </button>

      <button
        ref={btnChat}
        className={`ctrl-btn icon${hovered === 'chat' ? ' hot' : ''}${chatOpen ? ' on' : ''}`}
        title="和角色说话(@甲/@乙 指定谁回)"
        onClick={onChat}
      >
        <ChatIcon />
      </button>

      <button
        ref={btnDnd}
        className={`ctrl-btn icon${hovered === 'dnd' ? ' hot' : ''}${dnd ? ' on' : ''}`}
        title={dnd ? '勿扰中:点击恢复声音与主动搭话' : '勿扰:静音并暂停主动搭话(提醒卡片照弹)'}
        onClick={onDnd}
      >
        <BellOffIcon />
      </button>

      <button
        ref={btnGear}
        className={`ctrl-btn icon${hovered === 'settings' ? ' hot' : ''}${settingsOpen ? ' on' : ''}`}
        title="设置"
        onClick={onSettings}
      >
        <GearIcon />
      </button>
    </div>
  )
}
