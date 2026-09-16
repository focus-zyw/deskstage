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
import { SettingsCard, SetField, SetLine, SetSwitch } from '../SettingsPrimitives'
import {
  ensureColdStarts,
  generateForSlot,
  getShape,
  mutateShape,
  onQuirkAcquired,
  removeQuirk,
  setQuirkLocked,
  LOCK_CAP_PER_VALENCE,
  type ActorSlot,
  type QuirkBook,
  type QuirkEntry,
} from '../../quirks'

const CAUSE_TYPE_LABELS: Record<QuirkEntry['causeType'], string> = {
  memory: '来自经历',
  interaction: '与你的互动',
  inferred: '人设推导',
}

/** 招牌怪癖管理卡:红/蓝各 5 条配额、每色锁定 ≤3、清除与手动补一条。
 *  常驻显示(可发现性):未启用时卡内直接给启用开关,不必去 工具与隐私 页找 */
function QuirkCard() {
  const names = useConfigSnapshot().names
  const { form, setForm, saveField } = useSettings()
  const enabled = form.quirkSystem === true
  const [book, setBook] = useState<QuirkBook | null>(null)
  const [busy, setBusy] = useState('')

  useEffect(() => {
    void getShape().then((s) => setBook(s.quirks))
    return onQuirkAcquired(() => void getShape().then((s) => setBook(s.quirks)))
  }, [])

  function setEnabled(v: boolean) {
    setForm({ ...form, quirkSystem: v })
    saveField({ quirkSystem: v }, true)
    if (v) void ensureColdStarts()
  }

  const slotName = (who: ActorSlot): string => names[who.toLowerCase() as 'a' | 'b' | 'c']

  async function toggleLock(who: ActorSlot, q: QuirkEntry) {
    await mutateShape((s) => {
      const r = setQuirkLocked(s.quirks, who, q.id, !q.locked)
      if (!r.ok) setBusy(`该色锁定已达上限(每色 ${LOCK_CAP_PER_VALENCE} 条)`)
      return r.ok ? { ...s, quirks: r.book } : s
    })
    void getShape().then((s) => setBook(s.quirks))
  }

  async function remove(who: ActorSlot, id: string) {
    await mutateShape((s) => ({ ...s, quirks: removeQuirk(s.quirks, who, id) }))
    void getShape().then((s) => setBook(s.quirks))
  }

  async function addOne(who: ActorSlot) {
    setBusy(`正在为${slotName(who)}生成怪癖…`)
    const r = await generateForSlot(who, 'cold', { force: true })
    setBusy(r === 'ok' ? '' : r === 'fail' ? '生成失败(检查 API 配置后再试)' : '没有可用空位(该色已满且全部锁定)')
    void getShape().then((s) => setBook(s.quirks))
  }

  return (
    <SettingsCard
      card="招牌怪癖"
      title="招牌怪癖"
      desc={enabled ? '模型生成 · 用户锁定/清除;红5/蓝5,每色可锁3' : '实验功能,默认关'}
    >
      <SetLine
        title="启用招牌怪癖"
        hint="为每个角色生成并保持至多 10 条(红5/蓝5)招牌怪癖,注入演出作为背景素材;生成走 API 通道,失败静默"
      >
        <SetSwitch checked={enabled} label="启用招牌怪癖" onChange={setEnabled} />
      </SetLine>
      {enabled && (
        <div style={{ display: 'grid', gap: 14 }}>
          {(['A', 'B', 'C'] as const).map((who) => {
            const list = book?.[who] ?? []
            const count = {
              red: list.filter((q) => q.valence === 'red').length,
              blue: list.filter((q) => q.valence === 'blue').length,
            }
            return (
              <div key={who} style={{ borderTop: '1px solid var(--sw-border-soft)', paddingTop: 10 }}>
                <div className="set-line">
                  <div className="set-copy">
                    <span className="set-label">
                      {slotName(who)}({count.red}红/{count.blue}蓝)
                    </span>
                    {list.length === 0 && <span className="set-hint">暂无怪癖</span>}
                  </div>
                  <div className="set-control">
                    <button className="panel-btn" disabled={busy.startsWith('正在')} onClick={() => void addOne(who)}>
                      补一条怪癖
                    </button>
                  </div>
                </div>
                <div style={{ display: 'grid', gap: 6, marginTop: 4 }}>
                  {list.map((q) => (
                    <div
                      key={q.id}
                      className="set-note"
                      title={q.cause ? `因果:${q.cause}` : undefined}
                      style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}
                    >
                      <span style={{ color: q.valence === 'red' ? '#e05252' : '#5b8def', flex: 'none' }}>●</span>
                      <span style={{ color: 'var(--sw-text-2)' }}>
                        {q.trigger} → {q.behavior}
                      </span>
                      <span>
                        {q.type}·{CAUSE_TYPE_LABELS[q.causeType]}
                        {q.locked ? '·已锁定' : ''}
                      </span>
                      <button className="panel-btn" style={{ flex: 'none' }} onClick={() => void toggleLock(who, q)}>
                        {q.locked ? '解锁' : '锁定'}
                      </button>
                      <button className="panel-btn" style={{ flex: 'none' }} onClick={() => void remove(who, q.id)}>
                        清除
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
          <div className="set-actions">
            <span className="set-note">
              怪癖是背景素材,偶尔自然出现,不是每集任务;红=怪/执拗(冲突向),蓝=温柔/仪式(陪伴向);新怪癖获得时会在群聊里公示一条;悬停可看因果。
            </span>
          </div>
          {busy && <div className="set-note">{busy}</div>}
        </div>
      )}
    </SettingsCard>
  )
}

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
      <QuirkCard />
      <MoodCard />
    </>
  )
}
