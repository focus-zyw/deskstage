// 命令面板(工具入口):搜索过滤 + 整句话回车路由(关键词优先,LLM 兜底)。
// 提醒类路由会先给一行"待确认"表单——时间/事项都可改,确认才入库,绝不默默设错。
import { useEffect, useRef, useState } from 'react'
import type { CtrlBarPos } from '../storage/configStore'
import { filterCommands, nlRoute, type Command, type NlRoute } from '../features/commands/commands'

interface Props {
  innerRef: React.RefObject<HTMLDivElement | null>
  pos: CtrlBarPos
  commands: Command[]
  onClose: () => void
  /** 整句路由出"提醒"意图后的入库回调(App 侧带隐私气泡提醒) */
  onAddMemo: (text: string, dueAt: number) => void
  /** 整句路由出"演出"意图后的点播回调 */
  onPerform: (mode: 'daily' | 'crosstalk' | 'debate' | 'live', topic?: string) => void
}

function fmtLocal(d: Date): string {
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export function CommandPanel({ innerRef, pos, commands, onClose, onAddMemo, onPerform }: Props) {
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  const [memoDraft, setMemoDraft] = useState<{ text: string; due: string } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  async function submit() {
    const q = query.trim()
    if (!q || busy) return
    setBusy(true)
    setHint('')
    try {
      const route: NlRoute = await nlRoute(q, commands)
      if (route.kind === 'command') {
        setQuery('')
        route.command.run()
        onClose()
        return
      }
      if (route.kind === 'memo') {
        setMemoDraft({
          text: route.text,
          due: route.due ? fmtLocal(route.due) : '',
        })
        if (!route.due) setHint('没认出时间,选一个再确认')
        return
      }
      if (route.kind === 'perform') {
        setQuery('')
        onPerform(route.mode, route.topic)
        onClose()
        return
      }
      setHint('没匹配到命令,试试上面的列表')
    } finally {
      setBusy(false)
    }
  }

  const filtered = filterCommands(query, commands)

  return (
    <div
      ref={innerRef}
      className="settings-panel topic-panel cmd-panel"
      style={{ left: `${pos.xPct}%`, top: pos.top + 46 }}
    >
      <div className="panel-head">
        <span>你想让我们做什么？</span>
        <button className="panel-btn" onClick={onClose}>
          关闭
        </button>
      </div>
      <input
        ref={inputRef}
        className="topic-search"
        value={query}
        placeholder="搜索命令,或直接说:明天下午三点提醒我交报告"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit()
        }}
      />
      {memoDraft && (
        <div className="cmd-memo">
          <div className="cmd-memo-title">确认提醒(时间/内容可改)</div>
          <input
            value={memoDraft.text}
            placeholder="要办的事"
            onChange={(e) => setMemoDraft({ ...memoDraft, text: e.target.value })}
          />
          <input
            type="datetime-local"
            value={memoDraft.due}
            onChange={(e) => setMemoDraft({ ...memoDraft, due: e.target.value })}
          />
          <div className="cmd-memo-actions">
            <button
              className="panel-btn primary"
              disabled={!memoDraft.text.trim() || !memoDraft.due}
              onClick={() => {
                const dueAt = new Date(memoDraft.due).getTime()
                if (!Number.isFinite(dueAt)) return
                onAddMemo(memoDraft.text.trim(), dueAt)
                setMemoDraft(null)
                setQuery('')
                onClose()
              }}
            >
              添加提醒
            </button>
            <button className="panel-btn" onClick={() => setMemoDraft(null)}>
              取消
            </button>
          </div>
        </div>
      )}
      {hint && <div className="cmd-hint">{hint}</div>}
      <div className="topic-list">
        {filtered.length === 0 && !memoDraft && (
          <div className="topic-empty">没有匹配的命令;直接输整句话按回车也行</div>
        )}
        {filtered.map((c) => (
          <button
            key={c.id}
            className="topic-item"
            onClick={() => {
              c.run()
              onClose()
            }}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div className="tr-privacy">整句话按回车由当前模型路由到命令,会消耗一次调用</div>
    </div>
  )
}
