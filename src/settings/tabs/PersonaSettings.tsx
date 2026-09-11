// 角色人设:角色名字(名牌与台词称呼)、性别(代词事实源)与人设全文编辑
import { useEffect, useState } from 'react'
import { defaultPersonaText } from '../../engine/persona'
import { quantizeMood, type MoodTable } from '../../engine/moodState'
import { getMoods, resetMoods } from '../../storage/moodStore'
import type { Speaker } from '../../performer/dialogSchema'
import { useConfigSnapshot } from '../../storage/configStore'
import { useSettings } from '../useSettingsSession'
import { SettingsCard, SetField, SetLine } from '../SettingsPrimitives'

/** 当前心情卡:展示三位角色的情绪余波(剧情蒸馏/被戳/掐断演出驱动),支持一键复位 */
function MoodCard() {
  const names = useConfigSnapshot().names
  const [moods, setMoods] = useState<MoodTable | null>(null)
  const [resetting, setResetting] = useState(false)
  useEffect(() => {
    void getMoods().then(setMoods)
  }, [])

  const moodText = (who: Speaker): string => {
    const m = moods?.[who]
    if (!m) return '读取中…'
    const face = quantizeMood(m)
    return face.id === 'calm' ? '情绪平稳' : `${face.label}${m.cause ? `——${m.cause}` : ''}`
  }

  async function reset() {
    setResetting(true)
    try {
      await resetMoods()
      setMoods(await getMoods())
    } finally {
      setResetting(false)
    }
  }

  const slotName = (who: Speaker): string => names[who.toLowerCase() as 'a' | 'b' | 'c']
  return (
    <SettingsCard card="当前心情" title="当前心情" desc="角色现在的心情余波(只读)">
      {(['A', 'B', 'C'] as const).map((who) => (
        <SetLine key={who} title={slotName(who)} hint={who === 'C' ? '她的心情还会影响待机小动作' : undefined}>
          <span className="set-note">{moodText(who)}</span>
        </SetLine>
      ))}
      <div className="set-actions">
        <span className="set-note">来源:剧情蒸馏/被戳/掐断演出;每隔几小时自动回落,隔夜归平静</span>
        <button className="panel-btn" disabled={resetting} onClick={() => void reset()}>
          复位心情
        </button>
      </div>
    </SettingsCard>
  )
}

export function PersonaSettings() {
  const { form, setForm, saveField, flashCard } = useSettings()
  // 名字标签用已保存的生效名(提交后才换称呼),与名牌/台词一致
  const names = useConfigSnapshot().names

  /** 改某角色性别:即存,代词纪律立即生效(建议与语音音色性别一致,听感更自然) */
  function setGender(slot: 'a' | 'b' | 'c', v: '女' | '男') {
    const next = { ...form.genders, [slot]: v }
    setForm({ ...form, genders: next })
    saveField({ genders: next }, true)
  }

  const genderRow = (slot: 'a' | 'b' | 'c', label: string) => (
    <SetLine title={label} hint="台词的他/她严格按此;建议与角色语音音色的性别一致">
      <div className="seg-group">
        {(['女', '男'] as const).map((g) => (
          <button key={g} className={`seg-btn${form.genders[slot] === g ? ' on' : ''}`} onClick={() => setGender(slot, g)}>
            {g}
          </button>
        ))}
      </div>
    </SetLine>
  )

  return (
    <>
      <SettingsCard card="角色名字" flash={flashCard} title="角色名字" desc="名牌与台词称呼">
        <SetField label="角色A的名字" htmlFor="cfg-name-a">
          <input
            id="cfg-name-a"
            value={form.names.a}
            maxLength={12}
            onChange={(e) => {
              const next = { ...form.names, a: e.target.value }
              setForm({ ...form, names: next })
              saveField({ names: next })
            }}
          />
        </SetField>
        <SetField label="角色B的名字" htmlFor="cfg-name-b">
          <input
            id="cfg-name-b"
            value={form.names.b}
            maxLength={12}
            onChange={(e) => {
              const next = { ...form.names, b: e.target.value }
              setForm({ ...form, names: next })
              saveField({ names: next })
            }}
          />
        </SetField>
        <SetField label="角色C的名字" htmlFor="cfg-name-c" hint="常驻小管家的称呼">
          <input
            id="cfg-name-c"
            value={form.names.c}
            maxLength={12}
            onChange={(e) => {
              const next = { ...form.names, c: e.target.value }
              setForm({ ...form, names: next })
              saveField({ names: next })
            }}
          />
        </SetField>
      </SettingsCard>
      <SettingsCard card="角色性别" flash={flashCard} title="角色性别" desc="台词他/她的唯一依据">
        {genderRow('a', `角色A(${names.a})的性别`)}
        {genderRow('b', `角色B(${names.b})的性别`)}
        {genderRow('c', `角色C(${names.c})的性别`)}
        <div className="set-note">生成时会以这里的性别注入称呼纪律,人设文本里的性别描述不覆盖此项。</div>
      </SettingsCard>
      <SettingsCard
        card="角色人设"
        flash={flashCard}
        title="角色人设"
        desc="自由编辑,输入后自动保存并采纳"
      >
        <SetField
          label={`${names.a} 的人设`}
          htmlFor="cfg-persona-a"
          hint="性别/职业/性格/日常素材,自由发挥"
        >
          <textarea
            id="cfg-persona-a"
            rows={4}
            maxLength={2000}
            value={form.persona.a || defaultPersonaText('A')}
            onChange={(e) => {
              setForm({ ...form, persona: { ...form.persona, a: e.target.value } })
              saveField({ persona: { ...form.persona, a: e.target.value } })
            }}
          />
        </SetField>
        <SetField label={`${names.b} 的人设`} htmlFor="cfg-persona-b">
          <textarea
            id="cfg-persona-b"
            rows={4}
            maxLength={2000}
            value={form.persona.b || defaultPersonaText('B')}
            onChange={(e) => {
              setForm({ ...form, persona: { ...form.persona, b: e.target.value } })
              saveField({ persona: { ...form.persona, b: e.target.value } })
            }}
          />
        </SetField>
        <SetField
          label={`${names.c} 的人设`}
          htmlFor="cfg-persona-c"
          hint="常驻第三角色;她按字面理解并立刻执行"
        >
          <textarea
            id="cfg-persona-c"
            rows={4}
            maxLength={2000}
            value={form.persona.c || defaultPersonaText('C')}
            onChange={(e) => {
              setForm({ ...form, persona: { ...form.persona, c: e.target.value } })
              saveField({ persona: { ...form.persona, c: e.target.value } })
            }}
          />
        </SetField>
        <div className="set-actions">
          <span className="set-note">清空输入框 = 恢复该角色的内置人设</span>
          <button
            className="panel-btn"
            onClick={() => {
              const persona = {
                a: defaultPersonaText('A'),
                b: defaultPersonaText('B'),
                c: defaultPersonaText('C'),
              }
              setForm({ ...form, persona })
              saveField({ persona }, true)
            }}
          >
            还原默认人设
          </button>
        </div>
      </SettingsCard>
      <MoodCard />
    </>
  )
}
