// 台词气泡:挂在角色头顶,由调用方控制显示时长。
// speaker = 角色差异化(顶部色条 + 行首名牌);text 变 null 时内部播退场动画再自行
// 卸载——调用方保持条件渲染的写法不变,只需把 Bubble 改成常驻传入。
// below = 角色贴近屏幕顶部时气泡翻到下方,尾巴朝上;loud = 远距离喊话的加大加粗;
// 超过 80 字的长句自动降字号(text-wrap/降级见 App.css .bubble.long)。
import { useEffect, useState } from 'react'
import { nameOf } from '../engine/persona'

const EXIT_MS = 160

export function Bubble({
  text,
  below,
  loud,
  speaker,
}: {
  text?: string | null
  below?: boolean
  loud?: boolean
  speaker?: 'A' | 'B' | 'C'
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
  return (
    <div
      className={`bubble${below ? ' below' : ''}${loud ? ' loud' : ''}${shown.length > 80 ? ' long' : ''}${leaving ? ' out' : ''}`}
      data-speaker={speaker ?? ''}
    >
      {name && <i className="b-name">●{name}</i>}
      <span>{shown}</span>
    </div>
  )
}
