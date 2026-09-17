// 工具栏:统一悬浮 Dock。结构 = 精灵球把手(拖动/收起) + 模式选择(下拉菜单) +
// 主按钮(开始/停止原位切换) + 工具/聊天/勿扰/设置。
// 自带原生热区注册与悬停高亮;WebView 保持穿透,点击由指针管理器合成,
// 拖动移动经 onPosChange 回 App 落盘。新功能不再往栏上加按钮——注册进命令面板。
import { useEffect, useRef, useState } from 'react'
import {
  PlayIcon,
  StopIcon,
  GearIcon,
  PokeballIcon,
  BellOffIcon,
  ChevronDownIcon,
} from '../stage/icons'
import { registerHitRegion, onHoverChange } from '../input/pointerManager'
import { modeOf, type Mode } from '../performer/modes'
import { performanceButton, type PerformanceState } from './performButton'
import { PRIMARY_MIN_WIDTH } from './dockLayout'
import type { CtrlBarPos } from '../storage/configStore'
import { useSyncExternalStore } from 'react'
import { listen } from '@tauri-apps/api/event'
import {
  computeGroupChatUnreadFromLog,
  getGroupChatUnread,
  publishGroupChatUnread,
  subscribeGroupChatRead,
} from '../storage/groupChatReadStore'
import { subscribeChatLog } from '../storage/chatLogStore'

/** 主窗群聊入口的未读角标(方案 §2/§14):游标在设置窗推进,经
 *  'group-chat-read' 事件广播到这里;聊天日志有新写入(角色插话)时按日志+游标重算 */
function useGroupChatUnreadBadge(): number {
  const unread = useSyncExternalStore(subscribeGroupChatRead, getGroupChatUnread)
  useEffect(() => {
    let alive = true
    let lastAt = 0
    const refresh = (force = false) => {
      const now = Date.now()
      if (!force && now - lastAt < 1000) return
      lastAt = now
      void computeGroupChatUnreadFromLog().then((n) => {
        if (alive) publishGroupChatUnread(n)
      })
    }
    refresh(true)
    const unEvent = listen<{ unreadCount?: number }>('group-chat-read', (e) => {
      if (typeof e.payload?.unreadCount === 'number' && alive) {
        publishGroupChatUnread(e.payload.unreadCount)
      }
    })
    const unLog = subscribeChatLog(() => refresh())
    return () => {
      alive = false
      void unEvent.then((f) => f())
      unLog()
    }
  }, [])
  return unread
}

interface Props {
  pos: CtrlBarPos
  /** 拖动产生的位置更新;persist 由组件按拖动状态给('no' 过程 | 'now' 落盘) */
  onPosChange: (next: CtrlBarPos, persist: 'now' | 'no') => void
  mode: Mode
  /** 主按钮语义态:由 App 从 RuntimeMode + 当前模式算出,组件不做组合推断 */
  performanceState: PerformanceState
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
  /** 模式菜单开态与开关(菜单本体挂在 App 层,与各面板同锚点体系) */
  modeMenuOpen: boolean
  onModeMenuToggle: () => void
  /** Dock 内动作(开始/停止/勿扰/收起)先把模式菜单关掉,避免演出已开始菜单仍悬浮 */
  onMenuClose: () => void
}

const BAR_IDS = ['grip', 'mode', 'perform', 'tools', 'chat', 'dnd', 'settings']

export function ControlBar({
  pos,
  onPosChange,
  mode,
  performanceState,
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
  modeMenuOpen,
  onModeMenuToggle,
  onMenuClose,
}: Props) {
  const groupUnread = useGroupChatUnreadBadge()
  const [hovered, setHovered] = useState<string | null>(null)
  // 悬停高亮:只关心栏内区域(角色/面板的悬停归 App 管)
  const barRef = useRef<HTMLDivElement>(null)
  const gripRef = useRef<HTMLSpanElement>(null)
  const btnMode = useRef<HTMLButtonElement>(null)
  const btnPerform = useRef<HTMLButtonElement>(null)
  const btnTools = useRef<HTMLButtonElement>(null)
  const btnChat = useRef<HTMLButtonElement>(null)
  const btnDnd = useRef<HTMLButtonElement>(null)
  const btnGear = useRef<HTMLButtonElement>(null)
  const dragRef = useRef<{ startX: number; startY: number; orig: CtrlBarPos; moved: boolean } | null>(null)

  const perf = performanceButton(performanceState)
  // 非 idle 一律锁模式选择:演出中切换会让"显示模式"与"实际在播"错位
  const modeLocked = performanceState !== 'idle'

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
      registerHitRegion('mode', {
        getRect: () => btnMode.current!.getBoundingClientRect(),
        nativePointerTarget: () => btnMode.current,
      }),
      registerHitRegion('perform', {
        getRect: () => btnPerform.current!.getBoundingClientRect(),
        nativePointerTarget: () => btnPerform.current,
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
    // 只响应把手及内部图标(图标已 pointer-events:none),按钮/菜单不受影响
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
    // 边缘钳位按 Dock 实测宽度算,贴左右边也不出屏(锚点 = 把手中心左移 19px)
    const vw = window.innerWidth
    const dockW = barRef.current?.offsetWidth ?? 420
    const minX = ((6 + 19) / vw) * 100
    const maxX = ((vw - 6 - 19 - dockW) / vw) * 100
    onPosChange(
      {
        ...d.orig,
        xPct: Math.min(Math.max(minX, d.orig.xPct + (dx / vw) * 100), Math.max(minX, maxX)),
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
    else {
      onMenuClose() // 收起面板期间若模式菜单还开着,一并收掉
      onPosChange({ ...pos, collapsed: !pos.collapsed }, 'now') // 纯点击:收起/展开
    }
  }

  function onPerformClick() {
    onMenuClose()
    if (perf.kind === 'generate') onGenerate()
    else onStop()
  }

  return (
    <div
      ref={barRef}
      className={`ctrl-bar${pos.collapsed ? ' collapsed' : ''}`}
      style={{ left: `${pos.xPct}%`, top: pos.top }}
    >
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

      <button
        ref={btnMode}
        className={`dock-btn dock-mode${hovered === 'mode' ? ' hot' : ''}${modeMenuOpen ? ' on' : ''}`}
        disabled={modeLocked}
        title={modeLocked ? '演出/占用期间不可切换模式' : '切换模式'}
        onClick={onModeMenuToggle}
      >
        {modeOf(mode).label}
        <ChevronDownIcon />
      </button>

      <button
        ref={btnPerform}
        className={`dock-btn dock-primary${hovered === 'perform' ? ' hot' : ''}`}
        disabled={perf.disabled}
        title={perf.title}
        style={{ minWidth: PRIMARY_MIN_WIDTH }}
        onClick={onPerformClick}
      >
        {perf.kind === 'generate' ? <PlayIcon /> : <StopIcon />}
        <span>{perf.label}</span>
      </button>
      <span className="bar-sep" aria-hidden="true" />

      <button
        ref={btnTools}
        className={`dock-btn dock-text${hovered === 'tools' ? ' hot' : ''}${toolsOpen ? ' on' : ''}`}
        title="工具(翻译/截屏/提醒…搜命令或直接说)"
        onClick={onTools}
      >
        工具
      </button>

      <button
        ref={btnChat}
        className={`dock-btn dock-text${hovered === 'chat' ? ' hot' : ''}${chatOpen ? ' on' : ''}`}
        title="和角色说话(@甲/@乙 指定谁回)"
        onClick={onChat}
      >
        聊天
        {groupUnread > 0 && (
          <span className="dock-unread" title={`群聊有 ${groupUnread} 条未读`}>
            {groupUnread > 9 ? '9+' : groupUnread}
          </span>
        )}
      </button>

      <button
        ref={btnDnd}
        className={`dock-btn dock-icon dock-dnd${hovered === 'dnd' ? ' hot' : ''}${dnd ? ' on' : ''}`}
        title={dnd ? '勿扰中:点击恢复声音与主动搭话' : '勿扰:静音并暂停主动搭话(提醒卡片照弹)'}
        onClick={() => {
          onMenuClose()
          onDnd()
        }}
      >
        <BellOffIcon />
      </button>

      <button
        ref={btnGear}
        className={`dock-btn dock-icon${hovered === 'settings' ? ' hot' : ''}${settingsOpen ? ' on' : ''}`}
        title="设置"
        onClick={onSettings}
      >
        <GearIcon />
      </button>
    </div>
  )
}
