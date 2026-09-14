// 记忆库:使用者画像(手填)+ 自动记忆(带元数据的事实库)+ 禁止规则 + 显示模式。
// 自动记忆的语义决策在 memoryPolicy(时效/敏感/检索),本页只做管理与确定性确认:
// "这条信息可能已经过期:[仍然有效][修改][以后不记住]"——不做角色口头的自然确认。
// 所有变更经 memoryStore 的 CAS(双窗并发安全);导出为显式动作(导入二期)。
import { useEffect, useMemo, useState } from 'react'
import { save } from '@tauri-apps/plugin-dialog'
import { writeTextFile } from '@tauri-apps/plugin-fs'
import {
  addRule,
  clearAutoMemory,
  confirmFact,
  deleteFact,
  editFact,
  exportMemory,
  getMemory,
  MAX_PINNED_SOFT,
  removeRule,
  resetAllMemory,
  togglePinFact,
  type MemoryFact,
  type MemoryRule,
} from '../../storage/memoryStore'
import { effectiveStatus, scoreFact, type MemorySensitivity } from '../../storage/memoryPolicy'
import { getBond, getStory, removeArc, removeStoryItem, type StoryData } from '../../storage/storyStore'
import { bondTierOf } from '../../engine/interactionRules'
import { useSettings } from '../useSettingsSession'
import { SettingsCard, SetField } from '../SettingsPrimitives'

/** 记忆事实分类的中文标签 */
const MEM_CAT_LABEL: Record<string, string> = {
  identity: '身份',
  preference: '喜好',
  habit: '习惯',
  people: '身边人',
  event: '事件',
  other: '其他',
}

const SENS_LABEL: Record<MemorySensitivity, string> = { normal: '普通', private: '私密', restricted: '高敏' }
const RULE_SCOPE_LABEL: Record<MemoryRule['scope'], string> = {
  slot: '指定事项',
  category: '整类记忆',
  sensitivity: '某敏感级',
  phrase: '包含关键词',
}

function dayLabel(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 按"这条事实"生成结构化禁止规则:slot 优先(最精确),其次敏感级,最后整类。
 *  自动路径绝不产生 phrase 规则(避免误伤无关内容) */
function suggestRule(f: MemoryFact): { scope: MemoryRule['scope']; value: string; why: string } {
  if (f.slot) return { scope: 'slot', value: f.slot, why: `以后不自动保存"${f.slot}"这类信息` }
  if (f.sensitivity !== 'normal') return { scope: 'sensitivity', value: f.sensitivity, why: `以后不自动保存"${SENS_LABEL[f.sensitivity]}"级信息` }
  return { scope: 'category', value: f.category, why: `以后不自动保存"${MEM_CAT_LABEL[f.category]}"类信息` }
}

export function MemorySettings() {
  const { form, setForm, saveField, flashCard } = useSettings()
  // 记忆系统的机器事实列表
  const [memoryFacts, setMemoryFacts] = useState<MemoryFact[]>([])
  const [rules, setRules] = useState<MemoryRule[]>([])
  const [query, setQuery] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [clearMemArmed, setClearMemArmed] = useState(false)
  const [resetAllArmed, setResetAllArmed] = useState(false)
  const [exportNote, setExportNote] = useState('')
  // 角色世界(两人之间的老梗/未了结事件)
  const [storyData, setStoryData] = useState<StoryData | null>(null)
  // 长期关系一句话摘要
  const [bondLine, setBondLine] = useState<string | null>(null)

  useEffect(() => {
    void refreshMemoryFacts()
    void refreshStory()
  }, [])

  async function refreshMemoryFacts() {
    const mem = await getMemory()
    setMemoryFacts(mem.facts)
    setRules(mem.rules)
  }

  /** 刷新角色世界列表 + 长期关系摘要 */
  async function refreshStory() {
    setStoryData(await getStory())
    const bond = await getBond()
    const tier = bondTierOf(bond.trust, bond.rivalry)
    setBondLine(
      tier === 'warm'
        ? '怎么闹都闹不散的老搭档——嘴上互相嫌弃,底线下护着对方'
        : tier === 'strained'
          ? '见面就掐,旧账摞了一摞——但谁也没真走过'
          : bond.rivalry >= 3
            ? '最近摩擦升级,见面就较劲,谁也不服谁'
            : '平平淡淡的老搭档,偶尔斗嘴,基本和睦',
    )
  }

  const now = Date.now()
  const pinnedCount = memoryFacts.filter((f) => f.pinned).length
  // 有效状态过滤:superseded / 动态 needs_confirmation 在列表里有专门标记
  const withEff = memoryFacts.map((f) => ({ fact: f, eff: effectiveStatus(f, now) }))
  const needsConfirm = withEff.filter((x) => x.eff === 'needs_confirmation')
  // 搜索:有 query 用策略相关性排序,否则固定优先 + 最近确认/看到
  const sorted = useMemo(() => {
    const list = query.trim()
      ? withEff
          .map((x) => ({ ...x, score: scoreFact(x.fact, query, now) }))
          .sort((a, b) => b.score - a.score)
          .filter((x) => x.score > 0.25 || !query.trim())
      : [...withEff].sort(
          (a, b) =>
            Number(b.fact.pinned) - Number(a.fact.pinned) ||
            (b.fact.lastConfirmedAt ?? b.fact.lastSeen) - (a.fact.lastConfirmedAt ?? a.fact.lastSeen),
        )
    return list
  }, [withEff, query, now])

  async function doEdit(id: string) {
    await editFact(id, editDraft)
    setEditingId(null)
    setEditDraft('')
    await refreshMemoryFacts()
  }

  async function doForbid(f: MemoryFact) {
    const rule = suggestRule(f)
    await addRule(rule)
    await deleteFact(f.id)
    await refreshMemoryFacts()
  }

  async function doExport() {
    try {
      const json = await exportMemory()
      const path = await save({
        defaultPath: `memory-export-${dayLabel(Date.now())}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })
      if (!path) return
      await writeTextFile(path as string, json)
      setExportNote(`已导出到 ${path}`)
    } catch (e) {
      setExportNote(`导出失败:${String(e).slice(0, 80)}`)
    }
  }

  const renderFactRow = (f: MemoryFact, eff: string) => (
    <div className="mem-fact" key={f.id} style={eff === 'needs_confirmation' ? { opacity: 0.85 } : undefined}>
      <span className="mem-cat">{MEM_CAT_LABEL[f.category]}</span>
      {editingId === f.id ? (
        <span className="mem-content" style={{ display: 'flex', gap: 6 }}>
          <input
            value={editDraft}
            maxLength={120}
            onChange={(e) => setEditDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doEdit(f.id)
              if (e.key === 'Escape') setEditingId(null)
            }}
            style={{ flex: 1 }}
          />
          <button className="mem-btn" title="保存(视为你再次确认)" onClick={() => void doEdit(f.id)}>✓</button>
          <button className="mem-btn" title="取消" onClick={() => setEditingId(null)}>↩</button>
        </span>
      ) : (
        <span className="mem-content" title={f.content}>
          {f.content}
          {f.status === 'superseded' && ' (已被新信息替代)'}
        </span>
      )}
      <button
        className={`mem-btn${f.pinned ? ' on' : ''}`}
        title={f.pinned ? '取消固定' : `固定(不自动淘汰${pinnedCount >= MAX_PINNED_SOFT ? ';固定条数已多,建议清理' : ''})`}
        onClick={() => void (async () => { await togglePinFact(f.id); await refreshMemoryFacts() })()}
      >
        📌
      </button>
      <button
        className="mem-btn"
        title="编辑这条记忆(视为你再次确认)"
        onClick={() => {
          setEditingId(f.id)
          setEditDraft(f.content)
        }}
      >
        ✏️
      </button>
      <button
        className="mem-btn"
        title="重新确认(这条仍然有效)"
        onClick={() => void (async () => { await confirmFact(f.id); await refreshMemoryFacts() })()}
      >
        ✓
      </button>
      <button
        className="mem-btn"
        title={`删除,并${suggestRule(f).why}`}
        onClick={() => void (async () => { await doForbid(f) })()}
      >
        🚫
      </button>
      <button
        className="mem-btn"
        title="忘记这条(同类信息以后仍可能从新对话重新记住;想彻底禁止用 🚫)"
        onClick={() => void (async () => { await deleteFact(f.id); await refreshMemoryFacts() })()}
      >
        ✕
      </button>
      <div className="mem-meta">
        {dayLabel(f.createdAt)} 从聊天记下
        {f.lastConfirmedAt ? ` · 确认于 ${dayLabel(f.lastConfirmedAt)}` : ' · 尚未经你确认'}
        {eff === 'needs_confirmation' && ' · 可能已过期(暂时不用)'}
        {f.sensitivity !== 'normal' && ` · ${SENS_LABEL[f.sensitivity]}`}
        {f.sourceExcerpt && ` · 来源:"${f.sourceExcerpt.slice(0, 40)}"`}
      </div>
    </div>
  )

  return (
    <>
      <SettingsCard card="使用者画像" flash={flashCard} title="使用者画像" desc="角色据此认识你(手填,不会自动衰减)">
        <SetField label="你的称呼" htmlFor="cfg-mem-name">
          <input
            id="cfg-mem-name"
            placeholder="角色会这样叫你"
            value={form.userProfile.userName}
            onChange={(e) => {
              const next = { ...form.userProfile, userName: e.target.value }
              setForm({ ...form, userProfile: next })
              saveField({ userProfile: next })
            }}
          />
        </SetField>
        <SetField label="职业 / 身份" htmlFor="cfg-mem-occ">
          <input
            id="cfg-mem-occ"
            placeholder="如:在读研究生"
            value={form.userProfile.occupation}
            onChange={(e) => {
              const next = { ...form.userProfile, occupation: e.target.value }
              setForm({ ...form, userProfile: next })
              saveField({ userProfile: next })
            }}
          />
        </SetField>
        <div className="set-grid">
          <SetField label="喜欢(逗号分隔)" htmlFor="cfg-mem-likes">
            <input
              id="cfg-mem-likes"
              value={form.userProfile.likes}
              onChange={(e) => {
                const next = { ...form.userProfile, likes: e.target.value }
                setForm({ ...form, userProfile: next })
                saveField({ userProfile: next })
              }}
            />
          </SetField>
          <SetField label="不喜欢(逗号分隔)" htmlFor="cfg-mem-dis">
            <input
              id="cfg-mem-dis"
              value={form.userProfile.dislikes}
              onChange={(e) => {
                const next = { ...form.userProfile, dislikes: e.target.value }
                setForm({ ...form, userProfile: next })
                saveField({ userProfile: next })
              }}
            />
          </SetField>
        </div>
        <SetField label="雷区(完全不聊)" htmlFor="cfg-mem-ban">
          <input
            id="cfg-mem-ban"
            placeholder="如:考试,前任"
            value={form.userProfile.banTopics}
            onChange={(e) => {
              const next = { ...form.userProfile, banTopics: e.target.value }
              setForm({ ...form, userProfile: next })
              saveField({ userProfile: next })
            }}
          />
        </SetField>
      </SettingsCard>

      <div className="set-note">AI 话题发现与长期话题偏好已移到「演出话题」设置页。</div>

      {needsConfirm.length > 0 && (
        <SettingsCard
          card="可能过期"
          flash={flashCard}
          title={`可能已经过期(${needsConfirm.length})`}
          desc="这些信息过了一段时间没有确认,角色暂时不再主动使用;确认后恢复"
        >
          {needsConfirm.map(({ fact: f }) => (
            <div className="mem-fact" key={f.id}>
              <span className="mem-cat">待确认</span>
              <span className="mem-content">这条信息可能已经过期:"{f.content}"</span>
              <button
                className="mem-btn"
                title="仍然有效"
                onClick={() => void (async () => { await confirmFact(f.id); await refreshMemoryFacts() })()}
              >
                仍然有效
              </button>
              <button
                className="mem-btn"
                title="修改这条记忆"
                onClick={() => {
                  setEditingId(f.id)
                  setEditDraft(f.content)
                }}
              >
                修改
              </button>
              <button
                className="mem-btn"
                title={`删除,并${suggestRule(f).why}`}
                onClick={() => void (async () => { await doForbid(f) })()}
              >
                以后不记住
              </button>
            </div>
          ))}
        </SettingsCard>
      )}

      <SettingsCard
        card="记住的事"
        flash={flashCard}
        title={`记住的事(${memoryFacts.length})`}
        desc="聊天中透露的信息会被自动记住;🚫 = 删除并禁止以后再记,✕ = 仅删除本条"
        action={
          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
            <button className="mem-btn" title="导出记忆数据(显式动作,含全部事实与规则)" onClick={() => void doExport()}>
              导出
            </button>
            <button
              className={`hist-clear${clearMemArmed ? ' danger' : ''}`}
              disabled={memoryFacts.length === 0}
              onClick={() => {
                if (!clearMemArmed) {
                  setClearMemArmed(true)
                  window.setTimeout(() => setClearMemArmed(false), 3000)
                  return
                }
                void (async () => {
                  await clearAutoMemory()
                  await refreshMemoryFacts()
                  setClearMemArmed(false)
                })()
              }}
            >
              {clearMemArmed ? '确认清空记忆?' : '清空记忆'}
            </button>
            <button
              className={`hist-clear${resetAllArmed ? ' danger' : ''}`}
              onClick={() => {
                if (!resetAllArmed) {
                  setResetAllArmed(true)
                  window.setTimeout(() => setResetAllArmed(false), 3000)
                  return
                }
                void (async () => {
                  await resetAllMemory()
                  await refreshMemoryFacts()
                  setResetAllArmed(false)
                })()
              }}
            >
              {resetAllArmed ? '确认重置全部(含规则)?' : '重置记忆系统'}
            </button>
          </span>
        }
      >
        <SetField label="搜索记忆" htmlFor="cfg-mem-search" hint={`固定 ${pinnedCount} 条(建议不超过 ${MAX_PINNED_SOFT});🚫 会按这条事实建立禁止规则并删除`}>
          <input
            id="cfg-mem-search"
            placeholder="输入关键词过滤"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </SetField>
        {memoryFacts.length === 0 && (
          <div className="set-note">还没有记忆 — 聊天中透露的信息会出现在这里</div>
        )}
        {sorted.map(({ fact: f, eff }) => renderFactRow(f, eff))}
      </SettingsCard>

      <SettingsCard
        card="禁止自动保存"
        flash={flashCard}
        title={`禁止自动保存(${rules.length})`}
        desc="命中规则的信息不会再从聊天里被提取入库(规则不算在记忆条数里)"
      >
        {rules.length === 0 && <div className="set-note">还没有禁止规则 — 在上面某条记忆上点 🚫 可以按它生成</div>}
        {rules.map((r) => (
          <div className="mem-fact" key={r.id}>
            <span className="mem-cat">{RULE_SCOPE_LABEL[r.scope]}</span>
            <span className="mem-content">{r.value}</span>
            <button
              className="mem-btn"
              title="删除这条规则"
              onClick={() => void (async () => { await removeRule(r.id); await refreshMemoryFacts() })()}
            >
              ✕
            </button>
          </div>
        ))}
        <SetField label="手动添加规则" htmlFor="cfg-mem-rule-value" hint="scope=关键词 的规则会把明文关键词保存在本机禁止列表中(仅本机)">
          <input
            id="cfg-mem-rule-value"
            placeholder="包含关键词就不再记,如:花生"
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              const v = (e.target as HTMLInputElement).value
              if (!v.trim()) return
              void (async () => {
                await addRule({ scope: 'phrase', value: v })
                await refreshMemoryFacts()
                ;(e.target as HTMLInputElement).value = ''
              })()
            }}
          />
        </SetField>
      </SettingsCard>

      <SettingsCard card="记忆显示" flash={flashCard} title="记忆显示" desc="舞台气泡如何提示参考了记忆">
        <SetField label="显示模式" htmlFor="cfg-mem-display" hint="默认:气泡不显示(聊天记录详情仍可查看);透明:气泡底部显示 🧠 条数;调试:聊天详情额外显示检索分数与未注入候选">
          <select
            id="cfg-mem-display"
            value={form.memoryDisplay}
            onChange={(e) => saveField({ memoryDisplay: e.target.value as typeof form.memoryDisplay }, true)}
          >
            <option value="off">默认(不显示)</option>
            <option value="subtle">透明(气泡 🧠 徽标)</option>
            <option value="debug">调试(详情含检索明细)</option>
          </select>
        </SetField>
        {exportNote && <p className="set-note">{exportNote}</p>}
      </SettingsCard>

      <SettingsCard
        card="角色世界"
        flash={flashCard}
        title="角色世界"
        desc="两人之间的老梗/未了结事件,演出中会偶尔回收"
      >
        {(storyData?.gags.length ?? 0) === 0 && (storyData?.threads.length ?? 0) === 0 && (
          <div className="set-note">还没有角色共同记忆 — 演出几集后会自动积累</div>
        )}
        {storyData?.gags.map((g) => (
          <div className="mem-fact" key={g.id}>
            <span className="mem-cat">老梗</span>
            <span className="mem-content">{g.text}</span>
            <button
              className="mem-btn"
              title="删掉这条老梗"
              onClick={() => void (async () => { await removeStoryItem('gags', g.id); await refreshStory() })()}
            >
              ✕
            </button>
          </div>
        ))}
        {storyData?.threads.map((t) => (
          <div className="mem-fact" key={t.id}>
            <span className="mem-cat">未了结</span>
            <span className="mem-content">{t.text}</span>
            <button
              className="mem-btn"
              title="删掉这条事件线"
              onClick={() => void (async () => { await removeStoryItem('threads', t.id); await refreshStory() })()}
            >
              ✕
            </button>
          </div>
        ))}
        {bondLine && (
          <div className="mem-fact">
            <span className="mem-cat">关系</span>
            <span className="mem-content">{bondLine}</span>
          </div>
        )}
      </SettingsCard>
      <SettingsCard
        card="连续剧情"
        flash={flashCard}
        title="连续剧情"
        desc="多集推进的剧情线,约 30% 的集数会演下一拍"
      >
        {(storyData?.arcs.length ?? 0) === 0 && (
          <div className="set-note">还没有剧情线 — 演出中冒出的连续剧情会出现在这里</div>
        )}
        {storyData?.arcs.map((a) => (
          <div className="mem-fact" key={a.id}>
            <span className="mem-cat">{a.status === 'done' ? '完结' : `第${a.stage}拍`}</span>
            <span className="mem-content">
              《{a.title}》{a.status === 'done' ? `结局:${a.ending ?? '已收尾'}` : `下一拍:${a.nextHook}`}
            </span>
            <button
              className="mem-btn"
              title="删掉这条剧情线"
              onClick={() => void (async () => { await removeArc(a.id); await refreshStory() })()}
            >
              ✕
            </button>
          </div>
        ))}
      </SettingsCard>
    </>
  )
}
