// 演出完播评价条:自然完播后浮现"这集怎么样?",👍/👎/★ 一键完成,不追问原因;
// 附话题轻操作(继续聊这个/换个切口/不想再听这类),直接驱动下一集的行动意图。
// 穿透窗口约束:每个按钮必须各自注册热区(与 ControlBar 同款),悬停高亮走
// onHoverChange(CSS :hover 在合成指针下不可靠)。弹出/撤下时机由 App 决定,
// 这里只负责 10s 无操作自动收起与提交后的短暂致谢。
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { registerHitRegion, onHoverChange } from '../input/pointerManager'
import { ThumbsUpIcon, ThumbsDownIcon } from '../stage/icons'
import type { TopicPlan } from '../topic/types'

/** 一次评价邀请:自然完播的那一集(eid 是评价/收藏的主键);plan 供话题轻操作定位 */
export interface RatingAsk {
  eid: string
  mode: string
  topic: string
  /** 产出本集的话题计划(动态话题系统;回放/旧集没有) */
  plan?: TopicPlan
}

interface Props {
  ask: RatingAsk | null
  /** 位置:App 按工具栏现位置锚定(工具栏正上方),与 ChoicePanel 同思路 */
  style?: CSSProperties
  onRate: (rating: 'up' | 'down') => void
  onFav: () => void
  /** 话题轻操作:继续聊这个 / 换个切口(都触发新一集演出);不想再听这类(负反馈收起) */
  onContinueTopic: () => void
  onChangeAngle: () => void
  onBanTopic: () => void
  onDismiss: () => void
}

const AUTO_DISMISS_MS = 10_000
const THANKS_MS = 1400

/** 话题轻操作按钮表:统一注册热区 id 与悬停高亮,防漂移(文件内常量,热区测试按源码断言) */
const TOPIC_ACTION_IDS = ['rate-continue', 'rate-angle', 'rate-ban'] as const

export function RatingChip({ ask, style, onRate, onFav, onContinueTopic, onChangeAngle, onBanTopic, onDismiss }: Props) {
  const [hovered, setHovered] = useState<string | null>(null)
  // 致谢态按 eid 派生而非独立 state:新一轮邀请(eid 变化)自动回到提问态,免重置副作用
  const [thankedEid, setThankedEid] = useState<string | null>(null)
  const thanks = ask !== null && thankedEid === ask.eid
  const btnUp = useRef<HTMLButtonElement>(null)
  const btnDown = useRef<HTMLButtonElement>(null)
  const btnFav = useRef<HTMLButtonElement>(null)
  const btnContinue = useRef<HTMLButtonElement>(null)
  const btnAngle = useRef<HTMLButtonElement>(null)
  const btnBan = useRef<HTMLButtonElement>(null)

  // 悬停高亮:关心本条内全部按钮
  useEffect(() => {
    return onHoverChange((id) => {
      setHovered(
        id !== null &&
          (id === 'rate-up' || id === 'rate-down' || id === 'rate-fav' || (TOPIC_ACTION_IDS as readonly string[]).includes(id))
          ? id
          : null,
      )
    })
  }, [])

  // 命中区注册:穿透架构下未注册区域收不到任何鼠标事件。
  // 致谢态按钮卸载,getRect 回空矩形,热区自然失活
  useEffect(() => {
    if (!ask) return
    const empty = () => new DOMRect(0, 0, 0, 0)
    const unsubs = [
      registerHitRegion('rate-up', {
        getRect: () => btnUp.current?.getBoundingClientRect() ?? empty(),
        nativePointerTarget: () => btnUp.current,
      }),
      registerHitRegion('rate-down', {
        getRect: () => btnDown.current?.getBoundingClientRect() ?? empty(),
        nativePointerTarget: () => btnDown.current,
      }),
      registerHitRegion('rate-fav', {
        getRect: () => btnFav.current?.getBoundingClientRect() ?? empty(),
        nativePointerTarget: () => btnFav.current,
      }),
      registerHitRegion('rate-continue', {
        getRect: () => btnContinue.current?.getBoundingClientRect() ?? empty(),
        nativePointerTarget: () => btnContinue.current,
      }),
      registerHitRegion('rate-angle', {
        getRect: () => btnAngle.current?.getBoundingClientRect() ?? empty(),
        nativePointerTarget: () => btnAngle.current,
      }),
      registerHitRegion('rate-ban', {
        getRect: () => btnBan.current?.getBoundingClientRect() ?? empty(),
        nativePointerTarget: () => btnBan.current,
      }),
    ]
    return () => unsubs.forEach((u) => u())
  }, [ask])

  // 自动收起:询问态 10s 放弃(不打扰),致谢态短停留即走
  useEffect(() => {
    if (!ask) return
    const timer = window.setTimeout(onDismiss, thanks ? THANKS_MS : AUTO_DISMISS_MS)
    return () => window.clearTimeout(timer)
  }, [ask, thanks, onDismiss])

  if (!ask) return null

  const markThanks = () => setThankedEid(ask.eid)

  return (
    <div className={`rate-chip${thanks ? ' thanks' : ''}`} style={style}>
      {thanks ? (
        <span className="rate-chip-note">谢谢反馈，下次演得更对味</span>
      ) : (
        <>
          <span className="rate-chip-q">这集怎么样？</span>
          <button
            ref={btnUp}
            className={`rate-btn${hovered === 'rate-up' ? ' hot' : ''}`}
            title="赞（以后多演这类）"
            onClick={() => {
              markThanks()
              onRate('up')
            }}
          >
            <ThumbsUpIcon />
          </button>
          <button
            ref={btnDown}
            className={`rate-btn${hovered === 'rate-down' ? ' hot' : ''}`}
            title="踩（以后少来这套）"
            onClick={() => {
              markThanks()
              onRate('down')
            }}
          >
            <ThumbsDownIcon />
          </button>
          <button
            ref={btnFav}
            className={`rate-btn star${hovered === 'rate-fav' ? ' hot' : ''}`}
            title="收藏这集（不会被清理，重放权重更高）"
            onClick={() => {
              markThanks()
              onFav()
            }}
          >
            ★
          </button>
          <span className="rate-chip-sep" aria-hidden />
          <button
            ref={btnContinue}
            className={`rate-btn text${hovered === 'rate-continue' ? ' hot' : ''}`}
            title="同一话题接着演一集"
            onClick={() => {
              markThanks()
              onContinueTopic()
            }}
          >
            继续聊
          </button>
          <button
            ref={btnAngle}
            className={`rate-btn text${hovered === 'rate-angle' ? ' hot' : ''}`}
            title="还是这个话题,换个切口"
            onClick={() => {
              markThanks()
              onChangeAngle()
            }}
          >
            换切口
          </button>
          <button
            ref={btnBan}
            className={`rate-btn text${hovered === 'rate-ban' ? ' hot' : ''}`}
            title="不想再听这类（当踩处理）"
            onClick={() => {
              markThanks()
              onBanTopic()
            }}
          >
            不想听
          </button>
        </>
      )}
    </div>
  )
}
