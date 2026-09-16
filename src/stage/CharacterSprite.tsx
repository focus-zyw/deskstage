import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, Ref } from 'react'
import { spriteFileSrc, subscribeSpriteOverrides, spriteOverridesVersion, type SpriteSet } from './spriteSets'
import { SWITCH_MS, motionForAction, type TransitionMode } from './spriteMotion'
import { IdleDirector } from './idleDirector'
import { immediateSpriteVariants, SpriteVariantPicker } from './spriteVariants'

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
        }, 4400)
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

/** decode 门控:确认新图已取回并完成解码才发起切换——期间旧图持续显示,
 *  不存在"旧图已退、新图未解"的空窗(此前 dev 下每次重挂 img 都要走一次网络往返)。
 *  超时放行:极端慢载下乐观切换,退化为旧行为,不会更差。 */
async function decodeImage(src: string, timeoutMs = 2000): Promise<void> {
  const img = new Image()
  img.src = src
  await Promise.race([
    img.decode().then(() => undefined),
    new Promise<void>((r) => window.setTimeout(r, timeoutMs)),
  ])
}

/** 立绘精灵:双槽常驻 <img>(元素永不重建,无 key 重挂)。
 *  切换 = decode 门控 → 新图写入后台槽 → 透明度经 CSS transition 对调,
 *  过渡期两图互补淡化;旧槽保留上一张图兜底。素材缺失时回退胶囊占位体。 */
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
  // 角色工坊覆盖变更(预载完成/上传/还原)触发重绘;decode 门控让换图走交叉淡入
  useSyncExternalStore(subscribeSpriteOverrides, spriteOverridesVersion)
  // shake/jump 等无独立贴图的动作复用 idle 图，表现由 CSS 动画承担
  const artAction = sprite.actions.includes(action) ? action : 'idle'
  const baseFile = `${artAction}.png`
  const idleCycleActive =
    action === artAction &&
    artAction === 'idle' &&
    !hot &&
    !reacting &&
    !dragging &&
    !dropped &&
    !listening &&
    !pulsing
  // 可待机状态也进入 key：交互打断时渲染期立即回基础图，不留一帧旧姿势。
  const variantKey = `${sprite.dir}:${action}:${idleCycleActive ? 'idle-ready' : 'busy'}`
  const configuredVariants = action === artAction ? sprite.variants?.[artAction] : undefined
  const immediateCandidates = immediateSpriteVariants(configuredVariants)
  const [variantPicker] = useState(() => new SpriteVariantPicker())
  const [idleDirector] = useState(() => new IdleDirector())
  const [variant, setVariant] = useState(() => ({
    key: variantKey,
    file: variantPicker.pick(action, baseFile, immediateCandidates),
  }))
  if (variant.key !== variantKey) {
    // 回退动作(shake 等)只复用基础 idle 图，避免把普通待机变体误当成语义动作。
    setVariant({
      key: variantKey,
      file: variantPicker.pick(action, baseFile, immediateCandidates),
    })
  }
  useEffect(() => {
    if (!idleCycleActive) {
      idleDirector.stop()
      return
    }

    idleDirector.start({
      baseFile,
      variants: configuredVariants,
      onFrame: ({ file }) => {
        setVariant((current) =>
          current.key === variantKey && current.file !== file
            ? { ...current, file }
            : current,
        )
      },
    })
    return () => idleDirector.stop()
  }, [action, artAction, baseFile, configuredVariants, idleCycleActive, idleDirector, variantKey])
  const src = spriteFileSrc(sprite, variant.file)

  // —— 双槽切换引擎 ——
  // front 槽当前显示;另一槽持有上一张图兜底(opacity 0,不卸载)。
  // 切换流程:decode(src) → src 写入后台槽(隐藏) → 下一帧对调 show 标记,
  // 两个槽的透明度经 --switch-dur 时长的 transition 同步互补淡化。
  const [slots, setSlots] = useState<{
    front: 0 | 1
    srcs: [string | null, string | null]
  }>(() => ({ front: 0, srcs: [src, null] }))
  const [broken, setBroken] = useState(false)
  const [motionOff, setMotionOff] = useState(false)
  const genRef = useRef(0)

  const defaultMotion = motionForAction(action)
  const variantMotion = sprite.variants?.[artAction]?.find(
    (candidate) => candidate.file === variant.file,
  )?.transitionMode
  // 防重影记忆:上一拍是 dip(大轮廓姿势)切入的图,离开它也用 dip,
  // 避免交错的手臂在新图边缘露出(与旧引擎 prevTransitionMode 语义一致)
  const lastModeRef = useRef<TransitionMode>('crossfade')
  const mode: TransitionMode =
    lastModeRef.current === 'dip' ? 'dip' : (variantMotion ?? defaultMotion.mode)
  const motionStyle = defaultMotion.style

  // 胶囊态不跨切换延续:src 变化即重试(渲染层状态机在 src 变化时重建的同语义)
  useEffect(() => {
    setBroken(false)
  }, [src])

  useEffect(() => {
    if (broken) return
    if (src === slots.srcs[slots.front]) return
    const gen = ++genRef.current
    let cancelled = false
    const back: 0 | 1 = slots.front === 0 ? 1 : 0
    void (async () => {
      try {
        await decodeImage(src)
      } catch {
        // 加载/解码失败:落胶囊兜底(与旧 onError 行为一致)
        if (!cancelled) setBroken(true)
        return
      }
      if (cancelled || gen !== genRef.current) return
      lastModeRef.current = mode
      // 第一步:新图进后台槽(opacity 0)。新插入的元素不参与过渡,
      // 先落一个已渲染帧,第二步翻转 show 才能走出淡入动画。
      setSlots((s) => {
        const nextSrcs: [string | null, string | null] = [s.srcs[0], s.srcs[1]]
        nextSrcs[back] = src
        return { ...s, srcs: nextSrcs }
      })
      window.requestAnimationFrame(() => {
        if (cancelled || gen !== genRef.current) return
        // 第二步:show 对调,两槽透明度按 --switch-dur 同步过渡(impact 为 0ms 硬切)
        setSlots((s) => ({ ...s, front: back }))
      })
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, broken])

  // 起势动画重启:外壳常驻后 CSS 动画不会因重建而重播,
  // 交替挂/摘 motion-off(animation-name:none)让同名动画每次切换都从头播
  useEffect(() => {
    setMotionOff(true)
    const t = window.setTimeout(() => setMotionOff(false), 34)
    return () => window.clearTimeout(t)
  }, [src, action])

  const fidget = useIdleFidget(idleCycleActive && !idleSpecial(configuredVariants, variant.file))

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
        className={`char-transition-shell transition-${mode} motion-${motionStyle}${motionOff ? ' motion-off' : ''}`}
        style={{ '--switch-dur': `${SWITCH_MS[mode]}ms` } as CSSProperties}
      >
        <div className={`char-body${fidget ? ` ${fidget}` : ''}`}>
          {/* 双槽常驻:lead 在流撑起尺寸,hold 绝对居中覆盖;show 标记谁可见 */}
          <img
            className={`char-img lead${slots.front === 0 ? ' show' : ''}`}
            src={slots.srcs[0] ?? undefined}
            alt=""
            draggable={false}
            onError={() => setBroken(true)}
          />
          <img
            className={`char-img hold${slots.front === 1 ? ' show' : ''}`}
            src={slots.srcs[1] ?? undefined}
            alt={nameOverride ?? sprite.name}
            draggable={false}
            onError={() => setBroken(true)}
          />
        </div>
      </div>
      <div className="char-name">{nameOverride ?? sprite.name}</div>
    </div>
  )
}

/** 待机特插帧标记:当前变体带激活延迟时,呼吸/歪头等次级动画退位 */
function idleSpecial(
  variants: readonly { file: string; activationDelayMs?: number }[] | undefined,
  file: string,
): boolean {
  return Boolean(variants?.some((v) => v.file === file && (v.activationDelayMs ?? 0) > 0))
}
