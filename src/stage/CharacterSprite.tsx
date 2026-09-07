import { type CSSProperties, type Ref } from 'react'

export interface CharacterSpriteProps {
  name: string
  color: string
  /** 光标命中热区（窗口已恢复交互） */
  hot: boolean
  /** 点击反应动画进行中 */
  reacting: boolean
  onClick: () => void
  ref?: Ref<HTMLDivElement>
}

/** 占位角色：胶囊体 + 五官。M2 换贴图精灵后本组件仍负责挂图与动画类名 */
export function CharacterSprite({ name, color, hot, reacting, onClick, ref }: CharacterSpriteProps) {
  return (
    <div
      ref={ref}
      className={`char${hot ? ' hot' : ''}${reacting ? ' reacting' : ''}`}
      style={{ '--char-color': color } as CSSProperties}
      onClick={onClick}
    >
      <div className="char-face">
        <div className="char-eyes">
          <i />
          <i />
        </div>
        <div className="char-mouth" />
      </div>
      <div className="char-name">{name}</div>
    </div>
  )
}
