// 台词气泡:挂在角色头顶,由调用方控制显示时长。
// speaker = 角色差异化(柔彩底色 + 独立名签);text 变 null 时内部播退场动画再自行
// 卸载——调用方保持条件渲染的写法不变,只需把 Bubble 改成常驻传入。
// below = 角色贴近屏幕顶部时气泡翻到下方,尾巴朝上;loud = 远距离喊话的加大加粗;
// tailSide 与立绘朝向共用同一事实源,尾巴会追随头部/嘴部偏向;action/delivery 只做轻量情绪装饰。
// 超过 80 字的长句自动降字号(text-wrap/降级见 App.css .bubble.long)。
import { useEffect, useState } from 'react'
import { nameOf } from '../engine/persona'

const EXIT_MS = 160

export type BubbleTailSide = 'left' | 'center' | 'right'
type BubbleMood = 'angry' | 'shy' | 'excited' | undefined

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
}: {
  text?: string | null
  below?: boolean
  loud?: boolean
  speaker?: 'A' | 'B' | 'C'
  tailSide?: BubbleTailSide
  action?: string
  delivery?: string
}) {
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
  if (!shown) return null
  const name = speaker === 'C' ? '场外' : speaker ? nameOf(speaker) : ''
  const mood = moodFor(action, delivery, loud)
  return (
    <div
      className={`bubble${below ? ' below' : ''}${loud ? ' loud' : ''}${shown.length > 80 ? ' long' : ''}${leaving ? ' out' : ''}`}
      data-speaker={speaker ?? ''}
      data-tail={tailSide}
      data-mood={mood}
    >
      {name && <span className="b-name"><i />{name}</span>}
      <span key={shown} className="b-text">{shown}</span>
    </div>
  )
}
