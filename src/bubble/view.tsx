// 台词气泡视图 V2:主题引擎在组件内 resolve,结构属性与 CSS 变量直接落在
// .bubble-shell 自身——嵌套的工坊候选预览因此天然隔离,不与全局主题串色。
// 舞台与工坊预览共用本组件(经 src/bubble/index.ts 导出),工坊所见即舞台所得。
// speaker = 角色差异化(底色/名签);text 变 null 时内部播退场动画再自行卸载。
// below = 角色贴近屏幕顶部时气泡翻到下方,尾巴朝上;loud = 远距离喊话加大加粗;
// tailSide 与立绘朝向共用同一事实源;action/delivery 只做轻量情绪装饰。
// 超过 80 字的长句自动降字号(text-wrap/降级见 App.css .bubble-shell.long)。
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { nameOf } from '../engine/persona'
import { bubbleShiftX } from './position'
import { resolveBubbleAppearance } from './resolve'
import { useBubbleTheme } from './adapter'

const EXIT_MS = 160

export type BubbleTailSide = 'left' | 'center' | 'right'
type BubbleMood = 'angry' | 'shy' | 'excited' | undefined

/** 系统"减弱动态效果"偏好:驱动 resolve 关入场动画(主题解析的唯一运行时输入) */
function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    },
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    () => false,
  )
}

function moodFor(action?: string, delivery?: string, loud?: boolean): BubbleMood {
  if (action === 'angry') return 'angry'
  if (action === 'shy') return 'shy'
  if (loud || delivery === 'excited' || action === 'surprise' || action === 'laugh') return 'excited'
  return undefined
}

export function Bubble({
  text,
  below,
  loud,
  speaker,
  tailSide = 'center',
  action,
  delivery,
  memoryCount = 0,
}: {
  text?: string | null
  below?: boolean
  loud?: boolean
  speaker?: 'A' | 'B' | 'C'
  tailSide?: BubbleTailSide
  action?: string
  delivery?: string
  /** 参考记忆条数(透明档 🧠 徽标;0/缺省不显示) */
  memoryCount?: number
}) {
  const theme = useBubbleTheme()
  // 退场期间保留最后一句文本播淡出;below/loud/speaker 始终用实时 props(拖动翻面即时生效)
  const [keptText, setKeptText] = useState<string | null>(text ?? null)
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    if (text) {
      setKeptText(text)
      setLeaving(false)
      return
    }
    if (!keptText) return
    setLeaving(true)
    const t = window.setTimeout(() => {
      setKeptText(null)
      setLeaving(false)
    }, EXIT_MS)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])
  const shown = text ?? keptText
  const name = speaker ? nameOf(speaker) : ''
  const mood = moodFor(action, delivery, loud)
  // resolve 是纯函数:主题与减弱动效不变就不重算(颜色转换/对比度循环/纸噪点拼接不随
  // 每次重渲染重复);其余运行时状态全部转成 class/data 属性,由 CSS 消费
  const reducedMotion = usePrefersReducedMotion()
  const appearance = useMemo(
    () => resolveBubbleAppearance(theme, { reducedMotion }),
    [theme, reducedMotion],
  )
  // 水平防出屏(docs/气泡防出屏设计方案.md):主体恒对中角色,贴边时被透明窗
  // 裁切——量自然位置(rect 已含已应用位移,经 ref 镜像反解),位移经相对定位
  // left 落地(shell 本就是 position:relative,精确位移且不参与 flex 布局;
  // margin 在 align-items:center 下只生效半量,不能用)。文本/翻转/喊话变宽度,
  // 窗口 resize 变视口,都要重测
  const shellRef = useRef<HTMLDivElement | null>(null)
  const shiftRef = useRef(0)
  const [shiftX, setShiftX] = useState(0)
  useLayoutEffect(() => {
    const measure = () => {
      const el = shellRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const dx = Math.round(
        bubbleShiftX(rect.left - shiftRef.current, rect.width, window.innerWidth),
      )
      shiftRef.current = dx
      setShiftX(dx)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [shown, below, loud])
  if (!shown) return null
  const inlineName = appearance.nameplateStyle === 'inline'
  const showPlate = Boolean(name) && appearance.nameplateStyle !== 'hidden' && !inlineName
  return (
    <div
      ref={shellRef}
      className={`bubble-shell${below ? ' below' : ''}${loud ? ' loud' : ''}${shown.length > 80 ? ' long' : ''}${leaving ? ' out' : ''}`}
      data-template={appearance.templateId}
      data-material={appearance.materialId}
      data-nameplate={appearance.nameplateStyle}
      data-nameplate-pos={appearance.nameplatePosition}
      data-tail={appearance.tailStyle}
      data-tail-side={tailSide}
      data-speaker={speaker ?? ''}
      data-mood={mood}
      style={{ ...(appearance.cssVars as React.CSSProperties), left: shiftX }}
      aria-label={name ? `${name}说:${shown}` : undefined}
    >
      <div className="bubble-frame">
        {showPlate && (
          <span className="b-name">
            <i />
            {name}
          </span>
        )}
        <span key={shown} className="b-text">
          {inlineName && name && <span className="b-who">{name}</span>}
          {shown}
        </span>
        {memoryCount > 0 && (
          <span className="b-mem" title="本句回答参考的自动记忆条数(聊天记录详情可查看)">
            🧠 参考了 {memoryCount} 条自动记忆
          </span>
        )}
      </div>
      <span className="bubble-tail" aria-hidden />
      <span className="bubble-deco" aria-hidden />
    </div>
  )
}
