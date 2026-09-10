// 舞台道具层(复数,渲染列表):订阅 propEffects store,渲染挂在该角色上的全部道具。
// 定位基于角色中心(.actor 内 left:50%)与角色高度(App 传入),不依赖 .actor 宽度
// (宽度受气泡影响,.actor.flip 还会反转 flex 顺序);穿透层(pointer-events:none),
// 不随立绘做水平镜像(镜像只作用于 .char-img);below = 角色贴顶(flip)时道具改到头部下侧。
import { useSyncExternalStore } from 'react'
import { getPropEffects, subscribeProps } from '../runtime/propEffects'
import { PROPS, propSrc } from './props'

export function StageProps({ who, charH, below }: { who: 'A' | 'B'; charH: number; below: boolean }) {
  const effects = useSyncExternalStore(subscribeProps, getPropEffects)
  const mine = effects.filter((e) => e.who === who)
  if (mine.length === 0) return null
  return (
    <div className="stage-props" aria-hidden style={below ? { top: charH * 0.55 } : { bottom: charH + 8 }}>
      {mine.map((e) => (
        <img
          key={e.eid}
          className={`stage-prop${e.leaving ? ' leaving' : ''}`}
          src={propSrc(e.propId)}
          title={PROPS[e.propId].label}
          alt=""
          style={{
            width: PROPS[e.propId].size,
            height: PROPS[e.propId].size,
            translate: `${(e.slot - 1) * 56}px 0`,
          }}
        />
      ))}
    </div>
  )
}
