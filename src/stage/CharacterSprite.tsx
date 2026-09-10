import { useEffect, useState } from 'react'
import type { CSSProperties, Ref } from 'react'
import { spriteFileSrc, type SpriteSet } from './spriteSets'
import { motionForAction } from './spriteMotion'
import { SpriteVariantPicker } from './spriteVariants'

export interface CharacterSpriteProps {
  /** 立绘配置(素材目录、强调色、显示高、基线微调) */
  sprite: SpriteSet
  /** 覆盖 sprite.height 的显示高(角色缩放由外部配置驱动) */
  heightOverride?: number
  /** 当前动作（idle|talk|happy|angry|sad|surprise|shake|jump），映射到 act-* 动画类 */
  action?: string
  /** 说话点头节奏(一次循环秒数);不传用默认等速 */
  talkDuration?: number
  /** 语气修饰(deadpan/excited/slow):气色与节奏差异化,配合 TTS 语速 */
  delivery?: string
  /** 名牌显示名(用户自定义角色名);缺省用 sprite.name */
  nameOverride?: string
  /** 倾听时朝对方倾斜的方向 */
  lean?: 'left' | 'right'
  /** 正在倾听(随机小点头) */
  listening?: boolean
  /** 惊讶脉冲(听到的台词带感叹/问号) */
  pulsing?: boolean
  /** 拖动落地的 squash 回弹 */
  dropped?: boolean
  /** 拖动进行中(轻微缩小+提亮) */
  dragging?: boolean
  /** 水平镜像(面向对方角色) */
  flipped?: boolean
  /** 光标命中热区（窗口已恢复交互） */
  hot: boolean
  /** 点击反应动画进行中 */
  reacting: boolean
  ref?: Ref<HTMLDivElement>
}

/** 待机小动作:每隔 8~15 秒随机做一次重心转移或微歪头,打破站桩感 */
const FIDGETS = ['fidget-shift', 'fidget-tilt'] as const

function useIdleFidget(active: boolean): string {
  const [fidget, setFidget] = useState('')
  useEffect(() => {
    if (!active) return
    let timer: number
    let clearTimer: number
    const schedule = () => {
      timer = window.setTimeout(() => {
        setFidget(FIDGETS[Math.floor(Math.random() * FIDGETS.length)])
        clearTimer = window.setTimeout(() => {
          setFidget('')
          schedule()
        }, 2200)
      }, 8000 + Math.random() * 7000)
    }
    schedule()
    return () => {
      window.clearTimeout(timer)
      window.clearTimeout(clearTimer)
      setFidget('')
    }
  }, [active])
  return fidget
}

/** 贴图精灵：按动作切换立绘图（双 img 交叉淡入）+ act-* CSS 动画 + 倾听/待机等次级动画。缺图时回退胶囊占位体 */
export function CharacterSprite({
  sprite,
  heightOverride,
  action = 'idle',
  nameOverride,
  talkDuration,
  delivery,
  lean,
  listening,
  pulsing,
  dropped,
  dragging,
  flipped,
  hot,
  reacting,
  ref,
}: CharacterSpriteProps) {
  // shake/jump 等无独立贴图的动作复用 idle 图，表现由 CSS 动画承担
  const artAction = sprite.actions.includes(action) ? action : 'idle'
  const baseFile = `${artAction}.png`
  const variantKey = `${sprite.dir}:${action}`
  const [variantPicker] = useState(() => new SpriteVariantPicker())
  const [variant, setVariant] = useState(() => ({
    key: variantKey,
    file: variantPicker.pick(
      action,
      baseFile,
      action === artAction ? sprite.variants?.[artAction] : undefined,
    ),
  }))
  if (variant.key !== variantKey) {
    // 回退动作(shake 等)只复用基础 idle 图，避免把普通待机变体误当成语义动作。
    const candidates = action === artAction ? sprite.variants?.[artAction] : undefined
    setVariant({ key: variantKey, file: variantPicker.pick(action, baseFile, candidates) })
  }
  const src = spriteFileSrc(sprite, variant.file)
  const fidget = useIdleFidget(artAction === 'idle')
  const defaultMotion = motionForAction(action)
  const variantMotion = sprite.variants?.[artAction]?.find(
    (candidate) => candidate.file === variant.file,
  )?.transitionMode

  // 渲染期检测动作切换：旧图挪到下层兜底，新图重新走加载→淡入流程；
  // 淡入结束后卸载旧图 —— 各形态姿态差异大,旧图宽出的部分会从新图边缘露出形成重影
  const [fade, setFade] = useState({
    prev: null as string | null,
    curr: src,
    ready: false,
    broken: false,
    underGone: false,
    prevTransitionMode: undefined as typeof variantMotion,
    currTransitionMode: variantMotion,
  })
  if (src !== fade.curr) {
    setFade({
      prev: fade.curr,
      curr: src,
      ready: false,
      broken: false,
      underGone: false,
      prevTransitionMode: fade.currTransitionMode,
      currTransitionMode: variantMotion,
    })
  }
  const { prev, curr, ready, broken, underGone, prevTransitionMode, currTransitionMode } = fade
  // 大轮廓姿势离场时同样使用 dip，避免它与下一张基础图交叠出多余手臂。
  const transitionMode =
    !underGone && prevTransitionMode === 'dip'
      ? 'dip'
      : (currTransitionMode ?? defaultMotion.mode)
  const motion = { ...defaultMotion, mode: transitionMode }

  const cls = [
    'char',
    `act-${action}`,
    delivery ? `delivery-${delivery}` : '',
    hot ? 'hot' : '',
    reacting ? 'reacting' : '',
    lean ? `lean-${lean}` : '',
    listening ? 'listening' : '',
    pulsing ? 'pulse' : '',
    dropped ? 'dropped' : '',
    dragging ? 'dragging' : '',
    flipped ? 'flipped' : '',
    fidget,
  ]
    .filter(Boolean)
    .join(' ')
  const style = {
    '--char-color': sprite.accent,
    '--char-h': `${heightOverride ?? sprite.height}px`,
    '--char-shift-x': `${sprite.offsetX ?? 0}px`,
    '--char-shift-y': `${sprite.offsetY ?? 0}px`,
    ...(talkDuration ? { '--talk-dur': `${talkDuration}s` } : {}),
  } as CSSProperties

  if (broken) {
    // 兜底：素材缺失时渲染原占位胶囊，演出不中断
    return (
      <div ref={ref} className={cls} style={style}>
        <div className="char-capsule">
          <div className="char-face">
            <div className="char-eyes">
              <i />
              <i />
            </div>
            <div className="char-mouth" />
          </div>
        </div>
        <div className="char-name">{nameOverride ?? sprite.name}</div>
      </div>
    )
  }

  return (
    <div ref={ref} className={cls} style={style}>
      <div
        key={`${curr}:${action}`}
        className={`char-transition-shell transition-${motion.mode} motion-${motion.style}`}
      >
        <div className={`char-body${fidget ? ` ${fidget}` : ''}`}>
          {prev && !underGone && <img className="char-img under" src={prev} alt="" />}
          <img
            className={`char-img main${ready ? ' ready' : ''}`}
            src={curr}
            alt={nameOverride ?? sprite.name}
            draggable={false}
            onLoad={() => setFade((f) => ({ ...f, ready: true }))}
            onError={() => setFade((f) => ({ ...f, broken: true }))}
            onAnimationEnd={() => setFade((f) => ({ ...f, underGone: true }))}
          />
        </div>
      </div>
      <div className="char-name">{nameOverride ?? sprite.name}</div>
    </div>
  )
}
