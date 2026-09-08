/** 台词气泡：挂在角色头顶,由调用方控制显示时长。
 *  below = 角色贴近屏幕顶部时气泡翻到下方,箭头朝上 */
export function Bubble({ text, below }: { text: string; below?: boolean }) {
  return (
    <div className={`bubble${below ? ' below' : ''}`}>
      <span>{text}</span>
    </div>
  )
}
