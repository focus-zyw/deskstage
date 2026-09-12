// 统一运行状态机:全应用唯一的"现在能干什么"事实源。
// 为什么:此前 phase + 十来个布尔(面板/忙碌/截图)散在 App.tsx,6+ 处 effect
// 重复同一守卫组合,新功能互相踩;调度器/TTS 仲裁/命令面板都需要同一个闸门。
// 设计:mode = 单槽演出态(同时只做一件事, capturing/recording 进出带恢复);
// overlays = 面板层(不占演出态,但纳入 capability 计算)。
// React 侧用 useSyncExternalStore 订阅;非 React 侧(调度器/命令)直接读函数。
import { useSyncExternalStore } from 'react'

export type RuntimeMode =
  | { type: 'idle' }
  | { type: 'generating' } // LLM 生成中(点播等待)
  | { type: 'performing'; episodeId: number } // 演出中(含短聊/回放)
  | { type: 'streaming' } // 主播模式:直播弹幕互动中(独占,弹幕即互动源)
  | { type: 'choosing'; choiceId: string } // 中途选边等待
  | { type: 'capturing' } // 框选截图中(动作由松手后的工具条决定)
  | { type: 'recording' } // 音色克隆录音中

export type OverlayId =
  | 'settings'
  | 'topic'
  | 'chat'
  | 'tools'
  | 'translation'
  | 'mode-menu' // Dock 的模式选择下拉(轻交互,无输入框,不激活窗口)

interface RuntimeState {
  mode: RuntimeMode
  /** 打开顺序即栈:最后打开的在末尾,Esc 只关它 */
  overlays: OverlayId[]
  dnd: boolean
  charHidden: boolean
}

let state: RuntimeState = {
  mode: { type: 'idle' },
  overlays: [],
  dnd: false,
  charHidden: false,
}

const listeners = new Set<() => void>()

/** caps 缓存:getSnapshot 必须返回稳定引用,否则 useSyncExternalStore 死循环 */
let capsCache: RuntimeCaps

function sameMode(a: RuntimeMode, b: RuntimeMode): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function computeCaps(): RuntimeCaps {
  const s = state
  const idle = s.mode.type === 'idle'
  const overlaysOpen = s.overlays.length > 0
  return {
    modeType: s.mode.type,
    idle,
    performing: s.mode.type === 'performing',
    // 主播模式占演出态:生成/聊天/点播全不可用,弹幕回复是唯一互动源
    streaming: s.mode.type === 'streaming',
    capturing: s.mode.type === 'capturing',
    recording: s.mode.type === 'recording',
    canStartPerformance: idle,
    canChat: idle,
    // 演出中被戳走 interrupt 分支,其余演出态(choosing)不接戳
    canPoke: idle || s.mode.type === 'performing',
    proactiveAllowed: idle && !overlaysOpen && !s.dnd,
    overlaysOpen,
    escapeTarget: s.overlays[s.overlays.length - 1] ?? null,
    dnd: s.dnd,
    charHidden: s.charHidden,
  }
}

function emit() {
  capsCache = computeCaps()
  listeners.forEach((l) => l())
}

function set(patch: Partial<RuntimeState>) {
  const next = { ...state, ...patch }
  if (sameMode(next.mode, state.mode) && next.overlays === state.overlays && next.dnd === state.dnd && next.charHidden === state.charHidden) return
  state = next
  emit()
}

export function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function getRuntime(): RuntimeState {
  return state
}

export function getCaps(): RuntimeCaps {
  return capsCache
}

export interface RuntimeCaps {
  modeType: RuntimeMode['type']
  idle: boolean
  performing: boolean
  streaming: boolean
  capturing: boolean
  recording: boolean
  canStartPerformance: boolean
  canChat: boolean
  canPoke: boolean
  /** 主动行为(闲聊/重放/久坐)的总闸门;备忘提醒不走此门(用户定的事必须说) */
  proactiveAllowed: boolean
  overlaysOpen: boolean
  /** Esc 应关闭的面板(最后打开的);null = 无 */
  escapeTarget: OverlayId | null
  dnd: boolean
  charHidden: boolean
}

// ---------- mode ----------

export function setMode(mode: RuntimeMode): void {
  set({ mode })
}

let restoreMode: RuntimeMode | null = null
let episodeSeq = 0

/** 开始演出:episodeId 仅作身份标识(事件记账/调试用) */
export function beginPerforming(): void {
  episodeSeq += 1
  set({ mode: { type: 'performing', episodeId: episodeSeq } })
}

/** 进入主播模式(直播弹幕互动);下播走 setMode(idle),不做恢复语义 */
export function beginStreaming(): void {
  set({ mode: { type: 'streaming' } })
}

/** 进入框选截图:记住底下正在做的事,结束后恢复(演出在遮罩下继续播,不能丢) */
export function beginCapture(): void {
  if (state.mode.type !== 'capturing') restoreMode = state.mode
  set({ mode: { type: 'capturing' } })
}

export function endCapture(): void {
  set({ mode: restoreMode ?? { type: 'idle' } })
  restoreMode = null
}

/** 进入音色录制(设置面板下的独占态);结束恢复 */
export function beginRecording(): void {
  if (state.mode.type !== 'recording') restoreMode = state.mode
  set({ mode: { type: 'recording' } })
}

export function endRecording(): void {
  set({ mode: restoreMode ?? { type: 'idle' } })
  restoreMode = null
}

// ---------- overlays ----------

export function openOverlay(id: OverlayId): void {
  if (state.overlays.includes(id)) return
  set({ overlays: [...state.overlays, id] })
}

/** 打开唯一面板:其余全关(工具栏按钮互斥语义的统一入口),不含 toggle 语义 */
export function openOverlayExclusive(id: OverlayId): void {
  set({ overlays: [id] })
}

export function closeOverlay(id: OverlayId): void {
  if (!state.overlays.includes(id)) return
  set({ overlays: state.overlays.filter((x) => x !== id) })
}

export function closeAllOverlays(): void {
  if (state.overlays.length === 0) return
  set({ overlays: [] })
}

// ---------- flags ----------

export function setDnd(v: boolean): void {
  set({ dnd: v })
}

export function setCharHidden(v: boolean): void {
  set({ charHidden: v })
}

// ---------- React 绑定 ----------

export function useRuntime(): RuntimeState {
  return useSyncExternalStore(subscribe, getRuntime)
}

export function useCaps(): RuntimeCaps {
  return useSyncExternalStore(subscribe, getCaps)
}

capsCache = computeCaps()
