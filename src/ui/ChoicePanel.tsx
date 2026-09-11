import type { Ref } from 'react'
import { useConfigSnapshot } from '../storage/configStore'
import type { ChoiceOption, ChoicePoint } from '../performer/player'

export interface ChoicePanelProps {
  choice: ChoicePoint
  left: string
  top: number
  onPick: (option: ChoiceOption) => void
  innerRef?: Ref<HTMLDivElement>
}

/** 演出暂停时显示的观众站队面板；点击后由 App 恢复对应分支。 */
export function ChoicePanel({ choice, left, top, onPick, innerRef }: ChoicePanelProps) {
  // 界面主题:读已落盘配置,与设置窗口同一开关
  const theme = useConfigSnapshot().theme
  return (
    <div
      ref={innerRef}
      className={`settings-panel choice-panel${theme === 'light' ? ' light' : ''}`}
      style={{ left, top }}
      role="group"
      aria-label={choice.prompt}
    >
      <div className="choice-prompt">{choice.prompt}</div>
      <div className="choice-opts">
        {choice.options.map((option) => (
          <button
            key={option.id}
            type="button"
            className="panel-btn primary"
            onClick={() => onPick(option)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}
