// 常驻角色 C 的渲染:双 <video> 交叉淡入 + 精确身体命中框 + 头顶气泡 + 生命感。
// 与 CharacterSprite(PNG 立绘)刻意隔离:不改旧组件,等 A/B 也上视频时再抽象统一的演员 seam。
// 播放竞态防线:代际计数器——新切换请求让在途的 loadeddata 回调全部失效;
// 旧前台视频在淡出完成后才停播并摘掉 onended,防止片段末尾回调把新动作拉回旧动作。
// 素材缺失静默降级:候选片段加载失败回退 idle,idle 也缺失则整身不渲染。
// 生命感(随机待机链/点击回应/漫游)全部经 residentMachine 仲裁:
// 说话与剧情动作永远优先,随机行为只在"真空闲"时发生,不会被高频请求顶掉正式演出。
import { useEffect, useRef, useState } from 'react'
import type { Ref } from 'react'
import { Bubble } from '../Bubble'
import { residentSrc } from './residentManifest'
import {
  AMBIENT_CLIPS,
  AMBIENT_HOLD_MS,
  AMBIENT_MAX_MS,
  AMBIENT_MIN_MS,
  POKE_CLIPS,
  POKE_HOLD_MS,
  ROAM_PAUSE_MAX_MS,
  ROAM_PAUSE_MIN_MS,
  resolveResidentClip,
  shouldFlip,
} from './residentMachine'
import { nextRoamTarget, ROAM_SPEED_PCT_PER_SEC } from './residentMotion'
import type { ResidentClipId } from './residentTypes'

export interface ResidentActorProps {
  /** 呈现层动作(词表动作或 C 内部动作);经状态机仲裁后落地 */
  action: string
  /** 头顶台词气泡;null 隐藏 */
  bubble: string | null
  /** 气泡加大加粗(远距离喊话) */
  loud?: boolean
  /** TTS 正在说话(优先级高于剧情反应:说话中的动作始终是 talk) */
  speaking: boolean
  /** 拖拽进行中(最高可见优先级,并暂停漫游) */
  dragging: boolean
  /** 勿扰/全屏等静息态:冻结随机链与漫游,保持静态待机 */
  calm: boolean
  /** 生命感总开关(角色可见且启用);false 时只保留待机与说话 */
  active: boolean
  /** 整身隐藏(charactersHidden 或设置里禁用) */
  hidden: boolean
  /** 视频舞台宽度(px);素材 640×360,高度按 16:9 自推 */
  width?: number
  /** 角色贴近窗口顶部:气泡翻到角色下方 */
  below?: boolean
  /** 当前横向位置(屏宽百分比),漫游起步与步进读它 */
  xPct?: number
  /** 漫游位置回调(步进推进);不传则不漫游 */
  onMove?(xPct: number): void
  /** 光标命中热区(窗口已恢复交互,名牌随悬停显示) */
  hot: boolean
  /** 名牌显示名 */
  name?: string
  /** 身体命中框:App 据此注册原生热区,也接收原生指针合成的点击 */
  hitBoxRef: Ref<HTMLDivElement>
  /** 原地点一下身体的额外回调(戳一戳台词链路由 App 负责,这里只负责反应动画) */
  onPoke?(): void
}

/** 片段加载超时:本地资源超时视为缺失(回退),不无限等 */
const LOAD_TIMEOUT_MS = 3000
/** 交叉淡入时长,与 CSS .resident-video 过渡一致 */
const FADE_MS = 200
/** 漫游步进间隔:按步推进位置,热区矩形随每步同步(指针管理器轮询即取最新矩形) */
const ROAM_STEP_MS = 400

const pickOf = <T,>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]

export function ResidentActor({
  action,
  bubble,
  loud,
  speaking,
  dragging,
  calm,
  active,
  hidden,
  width,
  below,
  xPct,
  onMove,
  hot,
  name,
  hitBoxRef,
  onPoke,
}: ResidentActorProps) {
  const [missing, setMissing] = useState<ResidentClipId[]>([])
  const [broken, setBroken] = useState(false)
  const [ambient, setAmbient] = useState<ResidentClipId | null>(null)
  const [pokeClip, setPokeClip] = useState<ResidentClipId | null>(null)
  const [roaming, setRoaming] = useState(false)
  const [roamDir, setRoamDir] = useState(0)
  const videoA = useRef<HTMLVideoElement | null>(null)
  const videoB = useRef<HTMLVideoElement | null>(null)
  const frontIdx = useRef(0)
  const currentClip = useRef<ResidentClipId | null>(null)
  const genRef = useRef(0)
  const pokeTimer = useRef(0)

  // "真空闲":没有说话/拖拽/点击回应/剧情动作——随机链与漫游只在这种时候起步
  const idleLike =
    !speaking && !dragging && !pokeClip && (!action || action === 'idle')
  const idleRef = useRef(idleLike)
  const xRef = useRef(xPct)
  useEffect(() => {
    idleRef.current = idleLike
    xRef.current = xPct
  })

  const resolved = resolveResidentClip({
    hidden,
    dragging,
    speaking,
    scripted: action || null,
    poke: pokeClip,
    roaming,
    ambient,
  })
  // 缺失片段就地回退 idle(触发 effect 重跑);idle 也缺失 → broken,整身不渲染
  const target =
    resolved && missing.includes(resolved.clip) ? { clip: 'idle' as const, loop: true } : resolved

  useEffect(() => {
    if (!target) return
    if (target.clip === currentClip.current) return
    const gen = ++genRef.current
    const frontEl = frontIdx.current === 0 ? videoA.current : videoB.current
    const backEl = frontIdx.current === 0 ? videoB.current : videoA.current
    if (!frontEl || !backEl) return
    const clip = target.clip
    let settled = false
    let timer = 0

    const activate = () => {
      if (settled || gen !== genRef.current) return
      settled = true
      window.clearTimeout(timer)
      backEl.style.opacity = '1'
      frontEl.style.opacity = '0'
      // 淡出完成后再停旧片段:立刻 pause 会冻住淡出中间帧
      const outgoing = frontEl
      window.setTimeout(() => {
        if (gen !== genRef.current) return
        outgoing.onended = null
        outgoing.pause()
        try {
          outgoing.currentTime = 0
        } catch {
          // 未加载完成时无可重置,忽略
        }
      }, FADE_MS)
      frontIdx.current = 1 - frontIdx.current
      currentClip.current = clip
      backEl.onended = null // 单次片段播完停帧即可,状态变化会触发下一次切换
      try {
        backEl.currentTime = 0
      } catch {
        // 同上
      }
      void backEl.play().catch(() => {
        // 自动播放被拒:停在首帧,不致命
      })
    }

    const fail = () => {
      if (settled || gen !== genRef.current) return
      settled = true
      window.clearTimeout(timer)
      if (clip === 'idle') {
        setBroken(true)
      } else {
        setMissing((m) => (m.includes(clip) ? m : [...m, clip]))
      }
    }

    backEl.loop = target.loop
    backEl.src = residentSrc(clip)
    if (backEl.readyState >= 2) {
      activate()
    } else {
      backEl.onloadeddata = () => {
        backEl.onloadeddata = null
        backEl.onerror = null
        activate()
      }
      backEl.onerror = () => {
        backEl.onerror = null
        backEl.onloadeddata = null
        fail()
      }
      timer = window.setTimeout(fail, LOAD_TIMEOUT_MS)
    }
    return () => {
      settled = true
      window.clearTimeout(timer)
      backEl.onloadeddata = null
      backEl.onerror = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.clip, target?.loop, broken])

  // 隐藏时全停并作废在途切换;解除隐藏后 currentClip 已清空,强制重走切换
  useEffect(() => {
    if (!hidden) return
    genRef.current++
    for (const el of [videoA, videoB]) {
      const v = el.current
      if (!v) continue
      v.onended = null
      v.pause()
    }
    currentClip.current = null
  }, [hidden])

  const canFrolic = active && !calm && !hidden

  // 随机待机链:真空闲时每隔一段时间做一个小动作;任何打断(说话/拖拽/剧情)即停
  useEffect(() => {
    if (!canFrolic || !idleLike) return
    let hold = 0
    const timer = window.setTimeout(
      () => {
        setAmbient(pickOf(AMBIENT_CLIPS))
        hold = window.setTimeout(() => setAmbient(null), AMBIENT_HOLD_MS)
      },
      AMBIENT_MIN_MS + Math.random() * (AMBIENT_MAX_MS - AMBIENT_MIN_MS),
    )
    return () => {
      window.clearTimeout(timer)
      window.clearTimeout(hold)
      setAmbient(null)
    }
  }, [canFrolic, idleLike])

  // 漫游:真空闲时随机起步,小步幅步进推进(热区矩形随每步刷新),打断即停
  useEffect(() => {
    if (!canFrolic || !idleLike || xPct === undefined || !onMove) return
    let cancelled = false
    const timers: number[] = []
    const later = (fn: () => void, ms: number) => {
      const t = window.setTimeout(() => {
        if (!cancelled) fn()
      }, ms)
      timers.push(t)
    }
    const scheduleNext = () => {
      later(startRoam, ROAM_PAUSE_MIN_MS + Math.random() * (ROAM_PAUSE_MAX_MS - ROAM_PAUSE_MIN_MS))
    }
    const startRoam = () => {
      if (!idleRef.current) {
        scheduleNext() // 起步瞬间被打断:重新排队,不强行走
        return
      }
      const from = xRef.current
      if (from === undefined) return
      const to = nextRoamTarget(from)
      const dist = Math.abs(to - from)
      const steps = Math.max(2, Math.round(((dist / ROAM_SPEED_PCT_PER_SEC) * 1000) / ROAM_STEP_MS))
      const perStep = dist / steps
      const dir = Math.sign(to - from)
      setRoaming(true)
      setRoamDir(dir) // 行进方向参与镜像判定:与素材原生朝向相反时水平翻转视频
      let i = 0
      const step = () => {
        // 行进中被打断(说话/拖拽/演出动作):就地停,位置保留
        if (!idleRef.current) {
          setRoaming(false)
          setRoamDir(0)
          scheduleNext()
          return
        }
        i++
        if (i >= steps) {
          onMove(Number(to.toFixed(2)))
          setRoaming(false)
          setRoamDir(0)
          scheduleNext()
          return
        }
        onMove(Number((from + dir * perStep * i).toFixed(2)))
        later(step, ROAM_STEP_MS)
      }
      step()
    }
    scheduleNext()
    return () => {
      cancelled = true
      for (const t of timers) window.clearTimeout(t)
      setRoaming(false)
      setRoamDir(0)
    }
    // xPct/onMove 经 ref 读最新值,不进依赖:重渲染不重置漫游节奏
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canFrolic, idleLike])

  useEffect(() => () => window.clearTimeout(pokeTimer.current), [])

  /** 点击身体:反应动画(短持有,到期回待机)+ 外部戳一戳链路 */
  const handlePoke = () => {
    setPokeClip(pickOf(POKE_CLIPS))
    window.clearTimeout(pokeTimer.current)
    pokeTimer.current = window.setTimeout(() => setPokeClip(null), POKE_HOLD_MS)
    onPoke?.()
  }

  if (broken) return null

  // 方向性片段(走路)与实际移动方向相反时水平镜像视频,否则看起来在"倒着走";
  // 只翻 video 层,名牌与气泡在 stage 内但不受 video 选择器影响
  const flip = shouldFlip(target?.clip ?? 'idle', roamDir)

  return (
    // 舞台宽度必须显式给出:父容器(.actor)是 shrink-wrap 的 flex 列,
    // .resident-stage 的 width:100% 没有参照会塌成 0
    <div
      className={`resident${hot ? ' hot' : ''}${below ? ' below' : ''}`}
      style={width ? { width } : undefined}
    >
      {bubble && <Bubble text={bubble} below={below} loud={loud} />}
      <div className={`resident-stage${flip ? ' face-left' : ''}`}>
        {/* 初始透明度由 CSS 承担(0),前台切换经 DOM 直接改 style——
            若用 React style prop,重渲染会把 JS 设置的值重置回 0 造成黑帧 */}
        <video ref={videoA} className="resident-video" muted playsInline preload="auto" disablePictureInPicture />
        <video ref={videoB} className="resident-video" muted playsInline preload="auto" disablePictureInPicture />
        <div ref={hitBoxRef} className="resident-hitbox" title={name} onClick={handlePoke} />
        {name && <div className="resident-name">{name}</div>}
      </div>
    </div>
  )
}
