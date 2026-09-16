// 角色人设:角色名字(名牌与台词称呼)、性别(代词事实源)、酒馆角色卡导入与人设全文编辑
import { useEffect, useState } from 'react'
import { defaultPersonaText } from '../../engine/persona'
import type { AppConfig } from '../../storage/configStore'
import { quantizeMood, type MoodTable } from '../../engine/moodState'
import { getMoods, resetMoods } from '../../storage/moodStore'
import type { Speaker } from '../../performer/dialogSchema'
import { useConfigSnapshot } from '../../storage/configStore'
import { importCharacterCard } from '../../cardImport'
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

/** 酒馆角色卡导入卡:选 PNG/JSON → 解析预览 → 选槽位 → 分区烘焙写入人设。
 *  映射:描述/性格/场景 → 核心人设;mes_example 前 3 组 + first_mes → 表达风格参考;
 *  世界书仅常驻条目 → 长期背景设定;其余(非 constant lore/开场白备选/原始 JSON)留档不进 prompt。
 *  C 槽不支持导入:小管家有写死的人格与固定台词,导入卡会互相打架 */
function ImportCardCard() {
  const { form, setForm, saveField, flashCard } = useSettings()
  const names = useConfigSnapshot().names
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState<{ slot: 'a' | 'b'; personaText: string; name: string; fullName: string; warnings: string[] } | null>(null)

  async function onPickFile(file: File | null) {
    setError('')
    setNote('')
    setPending(null)
    if (!file) return
    setBusy(true)
    try {
      const isJson = /\.json$/i.test(file.name)
      const input = isJson
        ? { jsonText: await file.text() }
        : { bytes: new Uint8Array(await file.arrayBuffer()) }
      const preview = await importCharacterCard(input, 'a', form.userProfile?.userName ?? '')
      if (!preview.ok) {
        setError(preview.error ?? '解析失败')
        return
      }
      setPending({ slot: 'a', personaText: preview.personaText!, name: preview.name!, fullName: preview.fullName!, warnings: preview.warnings ?? [] })
    } catch (e) {
      setError(`读取文件失败:${String((e as Error)?.message ?? e).slice(0, 100)}`)
    } finally {
      setBusy(false)
    }
  }

  function confirmImport() {
    if (!pending) return
    const persona = { ...form.persona, [pending.slot]: pending.personaText }
    const personaSource: AppConfig['personaSource'] = { ...form.personaSource, [pending.slot]: 'custom' }
    const names2 = { ...form.names, [pending.slot]: pending.name }
    setForm({ ...form, persona, personaSource, names: names2 })
    saveField({ persona, personaSource, names: names2 }, true)
    setNote(`已导入「${pending.fullName}」到角色${pending.slot.toUpperCase()}:人设分区烘焙完成,性别请在上方自行设置`)
    setPending(null)
  }

  return (
    <SettingsCard card="导入角色卡" flash={flashCard} title="导入角色卡" desc="支持酒馆 SillyTavern 角色卡(PNG/JSON,V1/V2/V3)">
      <SetField label="角色卡文件" htmlFor="cfg-card-file">
        <input
          id="cfg-card-file"
          type="file"
          accept=".png,.json"
          disabled={busy}
          onChange={(e) => {
            void onPickFile(e.target.files?.[0] ?? null)
            e.target.value = ''
          }}
        />
      </SetField>
      {pending && (
        <>
          <SetLine title={`解析成功:${pending.fullName}`} hint={`烘焙后人设 ${pending.personaText.length} 字`}>
            <span className="set-note">{pending.warnings.length ? pending.warnings.join(';') : '无截断,全部字段装入'}</span>
          </SetLine>
          <SetField label="导入到哪个角色" htmlFor="cfg-card-slot">
            <select
              id="cfg-card-slot"
              value={pending.slot}
              onChange={(e) => setPending({ ...pending, slot: e.target.value as 'a' | 'b' })}
            >
              <option value="a">角色A({names.a})</option>
              <option value="b">角色B({names.b})</option>
            </select>
          </SetField>
          <div className="set-actions">
            <button className="panel-btn" onClick={confirmImport}>
              确认导入
            </button>
          </div>
          <div className="set-note">
            描述/性格/场景→核心人设;对话示例(前 3 组)与开场白→表达风格参考;世界书仅常驻条目→长期背景设定;
            其余数据(关键词条目/开场白备选/原始卡)已留档备用,不进入对话。导入后请到「AI 模型」页确认该角色的模型绑定。
          </div>
        </>
      )}
      {error && <div className="set-note">{error}</div>}
      {note && <div className="set-note">{note}</div>}
    </SettingsCard>
  )
}

export function PersonaSettings() {
  const { form, setForm, saveField, flashCard } = useSettings()

  /** 保存单槽位人设:非空文本 = custom;清空 = 恢复内置默认(default)。
   *  来源是结构化事实,与文本一起原子保存(话题包门控按来源判断) */
  function savePersona(slot: 'a' | 'b' | 'c', value: string) {
    const persona = { ...form.persona, [slot]: value }
    const personaSource: AppConfig['personaSource'] = {
      ...form.personaSource,
      [slot]: value.trim() ? 'custom' : 'default',
    }
    setForm({ ...form, persona, personaSource })
    saveField({ persona, personaSource })
  }
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
      <ImportCardCard />
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
            maxLength={8000}
            value={form.persona.a || defaultPersonaText('A')}
            onChange={(e) => savePersona('a', e.target.value)}
          />
        </SetField>
        <SetField label={`${names.b} 的人设`} htmlFor="cfg-persona-b">
          <textarea
            id="cfg-persona-b"
            rows={4}
            maxLength={8000}
            value={form.persona.b || defaultPersonaText('B')}
            onChange={(e) => savePersona('b', e.target.value)}
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
            maxLength={8000}
            value={form.persona.c || defaultPersonaText('C')}
            onChange={(e) => savePersona('c', e.target.value)}
          />
        </SetField>
        <div className="set-actions">
          <span className="set-note">清空输入框 = 恢复该角色的内置人设</span>
          <button
            className="panel-btn"
            onClick={() => {
              const persona = { a: '', b: '', c: '' }
              const personaSource: AppConfig['personaSource'] = { a: 'default', b: 'default', c: 'default' }
              setForm({ ...form, persona, personaSource })
              saveField({ persona, personaSource }, true)
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
