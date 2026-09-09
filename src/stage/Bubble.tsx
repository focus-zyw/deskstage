/** 台词气泡：挂在角色头顶,由调用方控制显示时长。
 *  below = 角色贴近屏幕顶部时气泡翻到下方,箭头朝上;loud = 远距离喊话的加大加粗样式 */
export function Bubble({ text, below, loud }: { text: string; below?: boolean; loud?: boolean }) {
  return (
    <div className={`bubble${below ? ' below' : ''}${loud ? ' loud' : ''}`}>
      <span>{text}</span>
    </div>
  )
}
