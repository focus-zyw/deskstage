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
  AMBIENT_MAX_MS,
  AMBIENT_MIN_MS,
  ACTION_FALLBACK_MS,
  ROAM_PAUSE_MAX_MS,
  ROAM_PAUSE_MIN_MS,
  ambientIntervalScale,
  pickAmbientClip,
  pokeClipsForMood,
  resolveResidentClip,
  shouldFlip,
} from './residentMachine'
import { currentTimeSlot } from '../../engine/timeAware'
import { moodOf } from '../../storage/moodStore'
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
  // 两个 video 只做离屏解码(不直接显示)——WebView2 透明窗口中媒体表面与 DOM
  // 重合成时 alpha 会被错误混合(移动其它元素/hover 都会让 C 整只变半透明),
  // 逐帧 drawImage 到 canvas 的合成路径不经过媒体表面通道,免疫该怪癖
  const videoA = useRef<HTMLVideoElement | null>(null)
  const videoB = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // 绘制状态:前台槽位/交叉淡入起点/镜像——rAF 绘制循环读,activate 更新
  const drawState = useRef({ front: 0 as 0 | 1, fadeStart: 0, flip: false })
  const frontIdx = useRef(0)
  const currentClip = useRef<ResidentClipId | null>(null)
  const genRef = useRef(0)
  const pokeTimer = useRef(0)
  // 单次片段(待机链/点击回应)播完的回收回调:双槽切换的 onended 转发到这里,
  // 由 ambient/poke 持有者注册——动作完整播完才回待机,不再被固定计时器掐断。
  // 注册/清理必须带归属校验(清理只清自己的),否则无关 effect 的 cleanup
  // 会把别人刚注册的回收处理器抹掉(曾致 pokeClip 卡 12 秒兜底)
  const endedHandlerRef = useRef<(() => void) | null>(null)
  const setEndedHandler = (handler: () => void) => {
    endedHandlerRef.current = handler
  }
  const clearEndedHandler = (handler: () => void) => {
    if (endedHandlerRef.current === handler) endedHandlerRef.current = null
  }
  const ambientRef = useRef<ResidentClipId | null>(null)
  // scripted 动作完成持有:戳一戳/插话等经 presenter 设置的表情(angry 等),
  // 会被 say 的固定回收计时提前降级回 idle——非说话状态下保持播完再切(see hold 逻辑)
  const [holdClip, setHoldClip] = useState<ResidentClipId | null>(null)
  const lastScriptedRef = useRef<ResidentClipId | null>(null)

  // "真空闲":没有说话/拖拽/点击回应/剧情动作——随机链与漫游只在这种时候起步
  const idleLike =
    !speaking && !dragging && !pokeClip && (!action || action === 'idle')
  const idleRef = useRef(idleLike)
  const xRef = useRef(xPct)
  useEffect(() => {
    idleRef.current = idleLike
    xRef.current = xPct
    ambientRef.current = ambient
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
  // scripted 命中判定(scripted 在 resolve 优先级中位于 poke/roaming/ambient 之前,
  // 此布尔成立即 target 由 scripted 提供)
  const scriptedActive = !hidden && !dragging && !speaking && !!action && action !== 'idle'
  if (scriptedActive && resolved) {
    lastScriptedRef.current = resolved.clip
    // App.poke 在设置 scripted 表情的同时,handlePoke 也会设 pokeClip(点击反应动画)
    // ——scripted 优先级更高,pokeClip 被压制后永不播放也等不到 ended,
    // 挂着会卡住下方的 hold 进入条件与 ambient 调度,就地清除
    if (pokeClip) setPokeClip(null)
  } else {
    // scripted 被 presenter 的 say 回收提前降级为 idle:非说话状态下进入持有,
    // 把刚降级的非循环表情播完(否则 angry 等约10秒的片段只播 presenter 给的2秒)
    const idleNow = !resolved || resolved.clip === 'idle'
    if (
      lastScriptedRef.current &&
      !holdClip &&
      idleNow &&
      !speaking &&
      !pokeClip &&
      !ambient &&
      !roaming
    ) {
      setHoldClip(lastScriptedRef.current)
    }
    if (!idleNow || speaking) lastScriptedRef.current = null
  }
  // 缺失片段就地回退 idle(触发 effect 重跑);idle 也缺失 → broken,整身不渲染
  let target =
    resolved && missing.includes(resolved.clip) ? { clip: 'idle' as const, loop: true } : resolved
  // hold 拦截:scripted 动作被提前降级后,继续播完它;被新意图打断时撤销持有
  if (holdClip) {
    if (target && target.clip !== 'idle') {
      setHoldClip(null)
    } else if (!speaking && !pokeClip && !ambient && !roaming) {
      target = { clip: holdClip, loop: false }
    }
  }

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
      // canvas 合成:记录前台槽位。fadeStart=0 表示"等待新片段首个有效帧",
      // 绘制循环探到有效帧后才起算交叉淡入——旧片段全程兜底显示,无空窗
      const backIdx: 0 | 1 = frontIdx.current === 0 ? 1 : 0
      drawState.current.front = backIdx
      drawState.current.fadeStart = 0
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
      // 单次片段(待机链/点击回应)播完 → 通知持有者回收回待机;
      // 循环片段不触发 ended,回调为 null 时亦安全
      backEl.onended = () => endedHandlerRef.current?.()
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

  // 随机待机链:真空闲时每隔一段时间做一个小动作;任何打断(说话/拖拽/剧情)即停。
  // 每拍调度时现读情境(节日满屏节日感/饭点吃饭/季节特色/情绪偏置/2% 稀有彩蛋),
  // 心情与时间变化不重置节奏,下一拍自然采用新池。
  // 回收由"片段播完(ended)"驱动——动作完整做完才回待机;兜底超时仅防播放异常卡死
  useEffect(() => {
    if (!canFrolic || !idleLike) return
    let fallback = 0
    let handler: () => void = () => setAmbient(null)
    const scale = ambientIntervalScale(moodOf('C'))
    const timer = window.setTimeout(
      () => {
        const now = new Date()
        setAmbient(
          pickAmbientClip({
            mood: moodOf('C'),
            slotId: currentTimeSlot().id,
            month: now.getMonth() + 1,
            day: now.getDate(),
            year: now.getFullYear(),
          }),
        )
        handler = () => setAmbient(null)
        setEndedHandler(handler)
        fallback = window.setTimeout(() => {
          clearEndedHandler(handler)
          setAmbient(null)
        }, ACTION_FALLBACK_MS)
      },
      (AMBIENT_MIN_MS + Math.random() * (AMBIENT_MAX_MS - AMBIENT_MIN_MS)) * scale,
    )
    return () => {
      window.clearTimeout(timer)
      window.clearTimeout(fallback)
      if (handler) clearEndedHandler(handler)
      setAmbient(null)
    }
  }, [canFrolic, idleLike])

  // hold(被 presenter 计时器降级的 scripted 表情)的回收注册:播完(ended)或兜底超时后撤销。
  // 声明在 ambient effect 之后:最近注册者赢,hold 期间不被 ambient 抢走
  useEffect(() => {
    if (!holdClip) return
    const handler = () => setHoldClip(null)
    setEndedHandler(handler)
    const fallback = window.setTimeout(() => {
      clearEndedHandler(handler)
      setHoldClip(null)
    }, ACTION_FALLBACK_MS)
    return () => {
      window.clearTimeout(fallback)
      clearEndedHandler(handler)
    }
  }, [holdClip])

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
      // 待机小动作在播时不起步:让动作做完再溜达(漫游优先级高于 ambient,会顶掉它)
      if (ambientRef.current) {
        scheduleNext()
        return
      }
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

  // canvas 合成绘制循环:video 只做离屏解码,每帧 drawImage 到 canvas——
  // WebView2 透明窗口中媒体表面与 DOM 重合成时 alpha 会被错误混合
  // (移动其它元素/hover 都曾让 C 整只变半透明),canvas 路径不经过媒体表面通道。
  // 仅 C 可见时运转;hidden/broken 时暂停
  useEffect(() => {
    if (hidden || broken) return
    const W = 960
    const H = 540
    // 有效帧探针(1×1):片段切换 seek/重置后解码器 readyState 已就绪但
    // 像素平面尚未呈现,drawImage 会画出全透明帧——探到有效帧前继续显示旧片段
    const probe = document.createElement('canvas')
    probe.width = 1
    probe.height = 1
    const probeCtx = probe.getContext('2d', { willReadFrequently: true })
    const hasFrame = (video: HTMLVideoElement | null): boolean => {
      if (!video || video.readyState < 2 || !probeCtx) return false
      try {
        probeCtx.clearRect(0, 0, 1, 1)
        probeCtx.drawImage(video, 0, 0, 1, 1)
        return probeCtx.getImageData(0, 0, 1, 1).data[3] > 8
      } catch {
        return false
      }
    }
    let raf = 0
    const draw = () => {
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (ctx) {
        const st = drawState.current
        const inSlot = st.front
        const outSlot: 0 | 1 = st.front === 0 ? 1 : 0
        const inVideo = inSlot === 0 ? videoA.current : videoB.current
        const outVideo = outSlot === 0 ? videoA.current : videoB.current
        const inHas = hasFrame(inVideo)
        // 新片段首个有效帧到达才起算淡入;未就绪时 t=0 → 旧片段全程兜底显示
        if (inHas && !st.fadeStart) st.fadeStart = performance.now()
        const t = st.fadeStart ? Math.min(1, (performance.now() - st.fadeStart) / FADE_MS) : 0
        ctx.clearRect(0, 0, W, H)
        ctx.save()
        if (st.flip) {
          ctx.translate(W, 0)
          ctx.scale(-1, 1)
        }
        // 交叉淡入:旧片段 (1-t) 渐隐 + 新片段 t 渐入,任一时刻合成不透明度恒为 1
        if (outVideo && t < 1 && hasFrame(outVideo)) {
          ctx.globalAlpha = 1 - t
          ctx.drawImage(outVideo, 0, 0, W, H)
        }
        if (inVideo && t > 0) {
          ctx.globalAlpha = t
          ctx.drawImage(inVideo, 0, 0, W, H)
        }
        ctx.globalAlpha = 1
        ctx.restore()
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [hidden, broken])

  /** 点击身体:反应动画完整播完(ended 驱动回收,兜底超时防卡死)后回待机 + 外部戳一戳链路;
   *  反应池随 C 的心情走 */
  const handlePoke = () => {
    setPokeClip(pickOf(pokeClipsForMood(moodOf('C'))))
    const handler = () => setPokeClip(null)
    setEndedHandler(handler)
    window.clearTimeout(pokeTimer.current)
    pokeTimer.current = window.setTimeout(() => {
      clearEndedHandler(handler)
      setPokeClip(null)
    }, ACTION_FALLBACK_MS)
    onPoke?.()
  }

  if (broken) return null

  // 方向性片段(走路)与实际移动方向相反时水平镜像——由绘制循环在 canvas 变换中执行
  const flip = shouldFlip(target?.clip ?? 'idle', roamDir)
  drawState.current.flip = flip

  return (
    // 舞台宽度必须显式给出:父容器(.actor)是 shrink-wrap 的 flex 列,
    // .resident-stage 的 width:100% 没有参照会塌成 0
    <div
      className={`resident${hot ? ' hot' : ''}${below ? ' below' : ''}`}
      style={width ? { width } : undefined}
    >
      <Bubble text={bubble} speaker="C" below={below} loud={loud} action={action} />
      <div className="resident-stage">
        {/* video 为离屏解码器(opacity 0 保持解码),canvas 是唯一可见合成面 */}
        <video ref={videoA} className="resident-decoder" muted playsInline preload="auto" disablePictureInPicture />
        <video ref={videoB} className="resident-decoder" muted playsInline preload="auto" disablePictureInPicture />
        <canvas ref={canvasRef} className="resident-canvas" width={960} height={540} />
        <div ref={hitBoxRef} className="resident-hitbox" title={name} onClick={handlePoke} />
        {name && <div className="resident-name">{name}</div>}
      </div>
    </div>
  )
}
