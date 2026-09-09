// 工具任务浮层卡:右下角常驻(备忘提醒同款视觉语言),running 计时/完成打勾/失败变红。
// 结果正文在面板里,卡片只给一句话状态;点"知道了"即关。
import { useUtilityTasks, removeTask } from '../runtime/utilityTasks'

const STATUS_ICON: Record<string, string> = { running: '⏳', done: '✅', error: '⚠️' }

export function UtilityCards() {
  const tasks = useUtilityTasks()
  if (tasks.length === 0) return null
  return (
    <div className="util-cards">
      {tasks.map((t) => (
        <div key={t.id} className={`util-card ${t.status}`}>
          <span className="util-tag">
            {STATUS_ICON[t.status]} {t.label}
          </span>
          <div className="util-text">{t.status === 'error' ? t.error : t.detail}</div>
          {t.status !== 'running' && (
            <button className="memo-ok" onClick={() => removeTask(t.id)}>
              知道了
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
