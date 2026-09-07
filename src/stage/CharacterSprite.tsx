import { useState } from 'react'
import type { CSSProperties, Ref } from 'react'
import { spriteSrc, type SpriteSet } from './spriteSets'

export interface CharacterSpriteProps {
  /** 立绘配置(素材目录、强调色、显示高、基线微调) */
  sprite: SpriteSet
  /** 当前动作（idle|talk|happy|angry|sad|surprise|shake|jump），映射到 act-* 动画类 */
  action?: string
  /** 光标命中热区（窗口已恢复交互） */
  hot: boolean
  /** 点击反应动画进行中 */
  reacting: boolean
  onClick: () => void
  ref?: Ref<HTMLDivElement>
}

/** 贴图精灵：按动作切换立绘图（双 img 交叉淡入）+ act-* CSS 动画。缺图时回退胶囊占位体 */
export function CharacterSprite({
  sprite,
  action = 'idle',
  hot,
  reacting,
  onClick,
  ref,
}: CharacterSpriteProps) {
  // shake/jump 等无独立贴图的动作复用 idle 图，表现由 CSS 动画承担
  const artAction = sprite.actions.includes(action) ? action : 'idle'
  const src = spriteSrc(sprite, artAction)

  // 渲染期检测动作切换：旧图挪到下层兜底，新图重新走加载→淡入流程
  const [fade, setFade] = useState({
    prev: null as string | null,
    curr: src,
    ready: false,
    broken: false,
  })
  if (src !== fade.curr) {
    setFade({ prev: fade.curr, curr: src, ready: false, broken: false })
  }
  const { prev, curr, ready, broken } = fade

  const cls = ['char', `act-${action}`, hot ? 'hot' : '', reacting ? 'reacting' : '']
    .filter(Boolean)
    .join(' ')
  const style = {
    '--char-color': sprite.accent,
    '--char-h': `${sprite.height}px`,
    '--char-shift-x': `${sprite.offsetX ?? 0}px`,
    '--char-shift-y': `${sprite.offsetY ?? 0}px`,
  } as CSSProperties

  if (broken) {
    // 兜底：素材缺失时渲染原占位胶囊，演出不中断
    return (
      <div ref={ref} className={cls} style={style} onClick={onClick}>
        <div className="char-capsule">
          <div className="char-face">
            <div className="char-eyes">
              <i />
              <i />
            </div>
            <div className="char-mouth" />
          </div>
        </div>
        <div className="char-name">{sprite.name}</div>
      </div>
    )
  }

  return (
    <div ref={ref} className={cls} style={style} onClick={onClick}>
      {prev && <img className="char-img under" src={prev} alt="" />}
      <img
        key={curr}
        className={`char-img main${ready ? ' ready' : ''}`}
        src={curr}
        alt={sprite.name}
        draggable={false}
        onLoad={() => setFade((f) => ({ ...f, ready: true }))}
        onError={() => setFade((f) => ({ ...f, broken: true }))}
      />
      <div className="char-name">{sprite.name}</div>
    </div>
  )
}
