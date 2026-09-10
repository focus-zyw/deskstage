// 备忘:添加(带隐私提醒)与列表管理。列表数据挂载时拉取,增删改后本地刷新
import { useEffect, useState } from 'react'
import { getMemos, addMemo, updateMemo, removeMemo, type Memo } from '../../storage/memoStore'
import { useSettings } from '../useSettingsSession'
import { SettingsCard, SetField } from '../SettingsPrimitives'

export function MemoSettings() {
  const { form, bridge, flashCard } = useSettings()
  // 备忘列表与添加草稿
  const [memos, setMemos] = useState<Memo[]>([])
  const [memoDraft, setMemoDraft] = useState<{ text: string; due: string; advance: string }>({
    text: '',
    due: '',
    advance: '',
  })

  useEffect(() => {
    void refreshMemos()
  }, [])

  async function refreshMemos() {
    setMemos(await getMemos())
  }

  /** 添加备忘:隐私气泡提醒 + 入库 + 刷新列表 */
  async function submitMemo() {
    const text = memoDraft.text.trim()
    if (!text || !memoDraft.due) return
    const dueAt = new Date(memoDraft.due).getTime()
    if (!Number.isFinite(dueAt)) return
    bridge.onPrivacyTip()
    await addMemo(text, dueAt, memoDraft.advance.trim() === '' ? null : Number(memoDraft.advance))
    setMemoDraft({ text: '', due: '', advance: '' })
    await refreshMemos()
  }

  /** 备忘列表行的时间文案 */
  function formatDue(dueAt: number): string {
    const d = new Date(dueAt)
    const pad = (x: number) => String(x).padStart(2, '0')
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  return (
    <>
      <SettingsCard card="添加备忘" flash={flashCard} title="添加备忘">
        <SetField label="要办的事" htmlFor="memo-text">
          <textarea
            id="memo-text"
            rows={2}
            placeholder="如:周三下午 3 点取快递(别写密码、验证码这类)"
            value={memoDraft.text}
            onChange={(e) => setMemoDraft({ ...memoDraft, text: e.target.value })}
          />
        </SetField>
        <div className="set-grid">
          <SetField label="截止时间" htmlFor="memo-due">
            <input
              id="memo-due"
              type="datetime-local"
              value={memoDraft.due}
              onChange={(e) => setMemoDraft({ ...memoDraft, due: e.target.value })}
            />
          </SetField>
          <SetField label="提前提醒(分钟)" htmlFor="memo-adv" hint={`留空 = 默认 ${form.memo.advanceMin}`}>
            <input
              id="memo-adv"
              type="number"
              min={1}
              value={memoDraft.advance}
              placeholder={`默认 ${form.memo.advanceMin}`}
              onChange={(e) => setMemoDraft({ ...memoDraft, advance: e.target.value })}
            />
          </SetField>
        </div>
        <div className="set-actions">
          <button className="panel-btn primary" onClick={() => void submitMemo()}>
            添加备忘
          </button>
        </div>
      </SettingsCard>
      <SettingsCard
        card="备忘列表"
        flash={flashCard}
        title={`备忘列表(${memos.length})`}
        desc="到点画外音会提醒"
        action={
          <button
            className="hist-clear"
            disabled={!memos.some((m) => m.done)}
            onClick={() => void (async () => {
              for (const m of memos.filter((x) => x.done)) await removeMemo(m.id)
              await refreshMemos()
            })()}
          >
            清已完成
          </button>
        }
      >
        {memos.length === 0 && <div className="set-note">还没有备忘 — 添加一条试试</div>}
        {memos.map((m) => (
          <div className="mem-fact" key={m.id}>
            <input
              type="checkbox"
              checked={m.done}
              title="标记完成"
              onChange={() => void (async () => { await updateMemo(m.id, { done: !m.done }); await refreshMemos() })()}
            />
            <span className="mem-content" style={m.done ? { textDecoration: 'line-through', opacity: 0.55 } : undefined}>
              {m.text}
            </span>
            <span className="memo-meta">
              {formatDue(m.dueAt)}
              {m.advanceMin !== null ? ` · 提前 ${m.advanceMin} 分` : ''}
              {m.done ? ' · 已完成' : ''}
            </span>
            <button
              className="mem-btn"
              title="删除"
              onClick={() => void (async () => { await removeMemo(m.id); await refreshMemos() })()}
            >
              ✕
            </button>
          </div>
        ))}
      </SettingsCard>
    </>
  )
}
