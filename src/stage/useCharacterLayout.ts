// 角色舞台布局:位置拖动(各自独立)/滚轮缩放(全局一致)/落盘防抖/最近交互置顶,
// 以及拖拽结束后的"搬家回应"(被拖角色自己一句轻反馈,不做任何关系/账本记录)。
// 布局只管几何与手势;台词呈现(present)与戳一戳(onPoke)由调用方注入,
// 这样本模块不依赖气泡/说话状态,可独立测试。
import { useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react'
import {
  saveConfig,
  DEFAULT_CONFIG,
  type CharactersConfig,
  type CharPos,
  type CtrlBarPos,
} from '../storage/configStore'
import { distanceBands, dragDropLine, dragDropLineC } from '../engine/interactionRules'
import type { Speaker } from '../performer/player'

export interface CharacterLayoutDeps {
  /** 距离演出仅在空闲时触发 */
  isIdle(): boolean
  /** 角色插话呈现(气泡+动作+计时回收) */
  present(who: Speaker, line: string, action: string, ms?: number, loud?: boolean): void
  /** 原地点一下(位移 < 6px)= 戳一戳 */
  onPoke(who: Speaker): void
  /** 按住不动(600ms,位移 < 6px)= 摸头长按;长按后继续拖动仍是拖拽 */
  onLongPress?(who: Speaker): void
}

/** 长按判定时长:短于此松手是戳一戳,按住不动超过它触发摸头 */
const LONG_PRESS_MS = 600

export function useCharacterLayout(deps: CharacterLayoutDeps) {
  // 角色布局(位置各自独立/缩放共享);ref 供拖动/滚轮事件读最新值
  const [charCfg, setCharCfg] = useState<CharactersConfig>(DEFAULT_CONFIG.characters)
  const charCfgRef = useRef(charCfg)
  const charSaveTimer = useRef(0)
  // 控制栏位置(可拖动)
  const [ctrlBar, setCtrlBar] = useState<CtrlBarPos>(DEFAULT_CONFIG.ctrlBar)
  const ctrlBarRef = useRef(ctrlBar)
  const ctrlBarTimer = useRef(0)
  // 最近交互的角色显示在上层(z-order)
  const [topActor, setTopActor] = useState<Speaker>('A')
  // 拎起态(轻微缩小提亮)与落地 squash 回弹
  const [dragUi, setDragUi] = useState<Speaker | null>(null)
  const [dropFor, setDropFor] = useState<Speaker | null>(null)
  const dropTimer = useRef(0)
  const dragRef = useRef<{ who: Speaker; startX: number; startY: number; orig: CharPos; moved: boolean; longFired?: boolean } | null>(null)
  // 长按(摸头)定时器:pointerdown 起表,位移超阈值或松手即撤
  const longPressTimer = useRef(0)
  // 拖动中的角色命中区膨胀为全窗口:快速拖动时光标冲出角色矩形,
  // 否则穿透窗口会立刻恢复 ignoreCursorEvents,拖拽被中断
  const draggingWho = useRef<Speaker | null>(null)

  const charA = useRef<HTMLDivElement>(null)
  const charB = useRef<HTMLDivElement>(null)

  /** 更新布局;persist='now' 立即落盘,'debounced' 防抖落盘(滚轮连续滚动只写一次) */
  function applyChars(next: CharactersConfig, persist: 'now' | 'debounced' | 'no' = 'no') {
    charCfgRef.current = next
    setCharCfg(next)
    if (persist === 'no') return
    window.clearTimeout(charSaveTimer.current)
    const write = () =>
      saveConfig({ characters: next }).catch((e) => console.warn('布局保存失败(静默)', e))
    if (persist === 'now') void write()
    else charSaveTimer.current = window.setTimeout(write, 500)
  }

  function applyCtrlBar(next: CtrlBarPos, persist: 'now' | 'debounced' | 'no' = 'no') {
    ctrlBarRef.current = next
    setCtrlBar(next)
    if (persist === 'no') return
    window.clearTimeout(ctrlBarTimer.current)
    const write = () =>
      saveConfig({ ctrlBar: next }).catch((e) => console.warn('控制栏位置保存失败(静默)', e))
    if (persist === 'now') void write()
    else ctrlBarTimer.current = window.setTimeout(write, 500)
  }

  /** 恢复默认布局(设置-基础设置入口) */
  function resetLayout() {
    applyChars(DEFAULT_CONFIG.characters, 'now')
    applyCtrlBar(DEFAULT_CONFIG.ctrlBar, 'now')
  }

  function onCharPointerDown(e: ReactPointerEvent, who: Speaker) {
    setTopActor(who) // 最近交互的角色置顶
    setDragUi(who) // 拎起态(轻微缩小提亮)
    dragRef.current = {
      who,
      startX: e.clientX,
      startY: e.clientY,
      orig: { ...charCfgRef.current[who] },
      moved: false,
    }
    // 长按起表:按住不动 600ms = 摸头;转拖拽或提前松手都会撤表
    window.clearTimeout(longPressTimer.current)
    if (deps.onLongPress) {
      longPressTimer.current = window.setTimeout(() => {
        const d = dragRef.current
        if (!d || d.who !== who || d.moved) return
        d.longFired = true
        deps.onLongPress?.(who)
      }, LONG_PRESS_MS)
    }
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      // 合成事件/指针已释放时无活动指针可捕获,忽略
    }
  }

  function onCharPointerMove(e: ReactPointerEvent, who: Speaker) {
    const d = dragRef.current
    if (!d || d.who !== who) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 6) return // 小位移视为点击,留给戳一戳
      d.moved = true
      window.clearTimeout(longPressTimer.current) // 动了就是拖拽,长按作废
      draggingWho.current = who
    }
    const cur = charCfgRef.current
    applyChars(
      {
        // 保留槽位自有字段(C 的 width/enabled):只改几何两项
        ...cur,
        [who]: {
          ...cur[who],
          xPct: Math.min(97, Math.max(3, d.orig.xPct + (dx / window.innerWidth) * 100)),
          bottom: Math.min(
            Math.max(0, window.innerHeight - 80),
            Math.max(0, d.orig.bottom - dy),
          ),
        },
      },
      'no',
    )
  }

  function onCharPointerUp(who: Speaker) {
    window.clearTimeout(longPressTimer.current)
    const d = dragRef.current
    dragRef.current = null
    setDragUi(null)
    if (!d || d.who !== who) return
    if (d.moved) {
      draggingWho.current = null
      applyChars(charCfgRef.current, 'now')
      setDropFor(who) // 落地 squash 回弹
      window.clearTimeout(dropTimer.current)
      dropTimer.current = window.setTimeout(() => setDropFor(null), 500)
      void maybeDistancePlay(who)
    } else if (!d.longFired) {
      deps.onPoke(who) // 原地点一下 = 戳一戳;长按已触发过摸头,不再叠加
    }
  }

  /** 拖拽落地的一句"搬家"式反馈:拖拽是布局操作,不是冒犯——
   *  不进负面账本、不动信任/敌对,由被拖动的角色自己回应一句(含 C);
   *  仅空闲时说话,演出/生成期间拖拽就是纯粹挪位置 */
  function maybeDistancePlay(who: Speaker) {
    if (!deps.isIdle()) return
    if (who === 'C') {
      deps.present('C', dragDropLineC(), 'happy', 2000)
      return
    }
    const bands = distanceBands(charCfg.height)
    const ax = (charCfg.A.xPct / 100) * window.innerWidth
    const bx = (charCfg.B.xPct / 100) * window.innerWidth
    const dx = Math.abs(ax - bx)

    if (dx < bands.overlap) {
      deps.present(who, dragDropLine('overlap'), 'surprise', 2000)
      // 叠一起时被拖者自己挪开 6%:纯几何防重叠,与关系无关
      const cfg = charCfgRef.current
      const other: Speaker = who === 'A' ? 'B' : 'A'
      const dir = cfg[who].xPct <= cfg[other].xPct ? -6 : 6
      applyChars({ ...cfg, [who]: { ...cfg[who], xPct: Math.min(97, Math.max(3, cfg[who].xPct + dir)) } }, 'now')
      return
    }
    if (dx < bands.close) {
      deps.present(who, dragDropLine('close'), 'happy', 2200)
      return
    }
    if (dx > window.innerWidth * 0.6) {
      deps.present(who, dragDropLine('far'), 'talk', 2200)
    }
  }

  function onCharWheel(e: ReactWheelEvent) {
    const cur = charCfgRef.current
    const maxHeight = Math.max(240, window.innerHeight - 40)
    const height = Math.min(maxHeight, Math.max(140, cur.height + (e.deltaY < 0 ? 12 : -12)))
    if (height === cur.height) return
    applyChars({ ...cur, height }, 'debounced') // 缩放全局一致:两个角色同步
  }

  /** C 的滚轮缩放:独立于 A/B 共享的 height——C 是视频宽度体系(640×360 素材等比),
   *  钳位与 sanitizeCharacters 的 160~1200 一致,防抖落盘 */
  function onResidentWheel(e: ReactWheelEvent) {
    const cur = charCfgRef.current
    const width = Math.min(1200, Math.max(160, cur.C.width + (e.deltaY < 0 ? 24 : -24)))
    if (width === cur.C.width) return
    applyChars({ ...cur, C: { ...cur.C, width } }, 'debounced')
  }

  return {
    charCfg,
    charCfgRef,
    ctrlBar,
    topActor,
    setTopActor,
    dragUi,
    dropFor,
    charA,
    charB,
    draggingWho,
    applyChars,
    applyCtrlBar,
    resetLayout,
    onCharPointerDown,
    onCharPointerMove,
    onCharPointerUp,
    onCharWheel,
    onResidentWheel,
  }
}

export type CharacterLayout = ReturnType<typeof useCharacterLayout>
