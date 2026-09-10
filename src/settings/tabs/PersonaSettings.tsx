// 角色人设:角色名字(名牌与台词称呼)与人设全文编辑
import { defaultPersonaText } from '../../engine/persona'
import { useConfigSnapshot } from '../../storage/configStore'
import { useSettings } from '../useSettingsSession'
import { SettingsCard, SetField } from '../SettingsPrimitives'

export function PersonaSettings() {
  const { form, setForm, saveField, flashCard } = useSettings()
  // 名字标签用已保存的生效名(提交后才换称呼),与名牌/台词一致
  const names = useConfigSnapshot().names

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
            value={form.persona.b || defaultPersonaText('B')}
            onChange={(e) => {
              setForm({ ...form, persona: { ...form.persona, b: e.target.value } })
              saveField({ persona: { ...form.persona, b: e.target.value } })
            }}
          />
        </SetField>
        <div className="set-actions">
          <span className="set-note">清空输入框 = 恢复该角色的内置人设</span>
          <button
            className="panel-btn"
            onClick={() => {
              setForm({
                ...form,
                persona: { a: defaultPersonaText('A'), b: defaultPersonaText('B') },
              })
              saveField({ persona: { a: defaultPersonaText('A'), b: defaultPersonaText('B') } }, true)
            }}
          >
            还原默认人设
          </button>
        </div>
      </SettingsCard>
    </>
  )
}
