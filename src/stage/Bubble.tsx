/** 台词气泡：挂在角色头顶，由调用方控制显示时长 */
export function Bubble({ text }: { text: string }) {
  return (
    <div className="bubble">
      <span>{text}</span>
    </div>
  )
}
