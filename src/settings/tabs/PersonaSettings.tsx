// 角色人设:角色库统一管理(名字/性别/人设)、A/B/C 槽位绑定与酒馆角色卡导入。
// 内置甲/乙/丙入库为内置条目:persona 留空跟随内置模板,编辑人设即固化(custom)。
import { useEffect, useState, useSyncExternalStore } from 'react'
import { defaultPersonaText } from '../../engine/persona'
import { quantizeMood, type MoodTable } from '../../engine/moodState'
import { getMoods, resetMoods } from '../../storage/moodStore'
import type { Speaker } from '../../performer/dialogSchema'
import { getConfig, useConfigSnapshot } from '../../storage/configStore'
import { importCharacterCard } from '../../cardImport'
import {
  deleteCharacter,
  ensureSeeded,
  listCharacters,
  saveCharacter,
  subscribeCharacters,
  charactersVersion,
  type CharacterDef,
} from '../../storage/charactersStore'
import { buildBindingPatch, occupiedByElse, slotsBoundTo, type SlotKey } from '../../characters/bind'
import { useSettings } from '../useSettingsSession'
import { SettingsCard, SetField, SetLine, SetSwitch } from '../SettingsPrimitives'


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
 *  导入只入库不绑定槽位——是否登场由用户在角色管理卡手动绑定决定 */
function ImportCardCard() {
  const { form, flashCard } = useSettings()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [localizeOn, setLocalizeOn] = useState(true)
  const [pending, setPending] = useState<{ personaText: string; name: string; fullName: string; warnings: string[]; localized: boolean; card: { spec: string; creator?: string; characterVersion?: string } } | null>(null)

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
      const preview = await importCharacterCard(input, 'a', form.userProfile?.userName ?? '', { localize: localizeOn })
      if (!preview.ok) {
        setError(preview.error ?? '解析失败')
        return
      }
      setPending({ personaText: preview.personaText!, name: preview.name!, fullName: preview.fullName!, warnings: preview.warnings ?? [], localized: preview.localized === true, card: preview.card! })
    } catch (e) {
      setError(`读取文件失败:${String((e as Error)?.message ?? e).slice(0, 100)}`)
    } finally {
      setBusy(false)
    }
  }

  async function confirmImport() {
    if (!pending) return
    setPending(null)
    try {
      // 导入 = 纯入库:只进角色库,不碰槽位配置;想让它上场,到上方
      // 「角色管理」的槽位下拉手动绑定(绑定才投影为人设)。
      // 同名卡重导 = 更新原条目(本地化偶发失败后重导即可补中文,不产生重复角色)
      const existing = (await listCharacters()).find(
        (c) => c.source === 'card' && c.name === pending.name,
      )
      const ch = await saveCharacter({
        id: existing?.id,
        name: pending.name,
        gender: existing?.gender ?? '女', // 卡规格无性别字段,默认女;重导保留已改性别
        persona: pending.personaText,
        source: 'card',
        card: pending.card,
      })
      const localizedNote = pending.localized ? ';非中文内容已本地化为中文' : ''
      setNote(`「${ch.name}」已入库(${ch.persona.length} 字人设${localizedNote})。到上方角色管理的槽位下拉绑定后才会登场;性别默认女,可在编辑里调整`)
    } catch (e) {
      setError(`入库失败:${String((e as Error)?.message ?? e).slice(0, 100)}`)
    }
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
      <SetLine
        title="非中文内容自动本地化为中文"
        hint="检测到外语卡时调用主模型做语义本地化(设定/开场白/对话示例/世界书正文,世界书关键词保留原文+中文别名);关闭则按原文导入"
      >
        <SetSwitch
          checked={localizeOn}
          label="非中文内容自动本地化为中文"
          onChange={(v) => {
            setLocalizeOn(v)
          }}
        />
      </SetLine>
      {busy && <div className="set-note">解析中…(若包含外语内容,本地化可能需要数十秒)</div>}
      {pending && (
        <>
          <SetLine title={`解析成功:${pending.fullName}`} hint={`烘焙后人设 ${pending.personaText.length} 字${pending.localized ? ';已本地化为中文' : ''}`}>
            <span className="set-note">{pending.warnings.length ? pending.warnings.join(';') : '无截断,全部字段装入'}</span>
          </SetLine>
          <div className="set-actions">
            <button className="panel-btn" disabled={busy} onClick={() => void confirmImport()}>
              确认导入
            </button>
          </div>
          <div className="set-note">
            描述/性格/场景→核心人设;对话示例(前 3 组)与开场白→表达风格参考;世界书仅常驻条目→长期背景设定;
            其余数据(关键词条目/开场白备选/原始卡)已留档备用,不进入对话。导入仅入库不自动上场——
            到上方「角色管理」把角色绑定到 A/B/C 槽位才会登场;C 槽固定小管家台词仍在,请知悉。
          </div>
        </>
      )}
      {error && <div className="set-note">{error}</div>}
      {note && <div className="set-note">{note}</div>}
    </SettingsCard>
  )
}

/** 角色管理卡:角色库(新增/编辑/删除)+ A/B/C 槽位手动绑定。
 *  角色库是事实源,绑定 = 把角色字段投影进槽位配置(bind.ts),解绑 = 投影空值
 *  (空名回甲/乙/丙、空人设回内置、personaSource='default'),生成管线零改动 */
function CharacterManagerCard() {
  const { form, setForm, saveField, flashCard } = useSettings()
  const names = useConfigSnapshot().names
  const [roster, setRoster] = useState<CharacterDef[]>([])
  const [editing, setEditing] = useState<{ id?: string; name: string; gender: '女' | '男'; persona: string } | null>(null)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function refresh() {
    setRoster(await listCharacters())
  }

  // 角色库版本变化(导入卡入库/编辑/删除等任何写入)自动重拉列表——
  // 导入卡与角色管理是两个组件,靠 store 版本广播保持同页同步
  const charVersion = useSyncExternalStore(subscribeCharacters, charactersVersion)

  // 打开本页:种内置角色(甲/乙/丙入库,老用户自定义无损固化)+ 绑定指针补种
  // (三槽都空 = 尚未初始化,一次 saveField 把三槽投影到各自内置条目;
  //  种库/投影会 bump 版本触发上方重拉,bind 补种有 null 守卫不会重复写)
  useEffect(() => {
    void (async () => {
      const cfg = await getConfig()
      await ensureSeeded(cfg)
      const rosterNow = await listCharacters()
      setRoster(rosterNow)
      const cur = await getConfig()
      if (cur.slotBindings.a || cur.slotBindings.b || cur.slotBindings.c) return
      const builtins = rosterNow.filter((c) => c.builtin)
      if (builtins.length < 3) return
      let names = { ...cur.names }
      let genders = { ...cur.genders }
      let persona = { ...cur.persona }
      let personaSource = { ...cur.personaSource }
      let sb = { ...cur.slotBindings }
      for (const s of ['a', 'b', 'c'] as const) {
        const char = builtins.find((c) => c.builtin === s)!
        const patch = buildBindingPatch(s, { id: char.id, name: char.name, gender: char.gender, persona: char.persona }, {
          names, genders, persona, personaSource, slotBindings: sb,
        })
        names = patch.names!
        genders = patch.genders!
        persona = patch.persona!
        personaSource = patch.personaSource!
        sb = patch.slotBindings!
      }
      const finalPatch = { names, genders, persona, personaSource, slotBindings: sb }
      setForm((f) => ({ ...f, ...finalPatch }))
      saveField(finalPatch, true)
      // 打开页只执行一次:session 的 setForm/saveField 身份稳定,依赖数组保持 []
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [charVersion])

  /** 绑定/解绑某槽:投影五字段原子保存 */
  function applyBinding(slot: SlotKey, char: { id: string; name: string; gender: '女' | '男'; persona: string } | null) {
    const patch = buildBindingPatch(slot, char, {
      names: form.names,
      genders: form.genders,
      persona: form.persona,
      personaSource: form.personaSource,
      slotBindings: form.slotBindings,
    })
    setForm({ ...form, ...patch })
    saveField(patch, true)
  }

  /** 已绑定角色的所有槽重投影(编辑保存后调用) */
  function reproject(id: string, char: { id: string; name: string; gender: '女' | '男'; persona: string }) {
    const slots = slotsBoundTo(form.slotBindings, id)
    if (slots.length === 0) return
    const merged: Record<string, unknown> = {}
    for (const s of slots) {
      const patch = buildBindingPatch(s, char, {
        names: form.names,
        genders: form.genders,
        persona: form.persona,
        personaSource: form.personaSource,
        slotBindings: form.slotBindings,
      })
      for (const [k, v] of Object.entries(patch)) merged[k] = { ...(merged[k] as object ?? {}), ...(v as object) }
    }
    setForm({ ...form, ...merged } as typeof form)
    saveField(merged as Parameters<typeof saveField>[0], true)
  }

  async function onSaveCharacter() {
    if (!editing) return
    setBusy(true)
    setError('')
    try {
      const saved = await saveCharacter({ ...editing })
      reproject(saved.id, { id: saved.id, name: saved.name, gender: saved.gender, persona: saved.persona })
      setNote(`角色「${saved.name}」已保存${slotsBoundTo(form.slotBindings, saved.id).length > 0 ? ',绑定槽位同步更新' : ''}`)
      setEditing(null)
      await refresh()
    } catch (e) {
      setError(String((e as Error)?.message ?? e).slice(0, 120))
    } finally {
      setBusy(false)
    }
  }

  async function onDelete(id: string) {
    const char = roster.find((c) => c.id === id)
    if (!char) return
    const bound = slotsBoundTo(form.slotBindings, id)
    if (!window.confirm(`删除角色「${char.name}」?${bound.length > 0 ? `其绑定的槽位(${bound.map((s) => s.toUpperCase()).join('/')})将还原默认角色。` : ''}`)) return
    setBusy(true)
    setError('')
    try {
      for (const s of bound) applyBinding(s, null) // 先解绑(投影空值还原默认)
      await deleteCharacter(id)
      setNote(`角色「${char.name}」已删除`)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const slotRow = (slot: SlotKey) => {
    const boundId = form.slotBindings?.[slot] ?? null
    const builtinName = slot === 'a' ? '甲' : slot === 'b' ? '乙' : '丙'
    return (
      <SetField
        label={`角色${slot.toUpperCase()}(${names[slot]})绑定`}
        htmlFor={`cfg-bind-${slot}`}
        hint={slot === 'c' ? 'C 有固定小管家台词与动作,绑定后仅人设/称呼生效' : undefined}
      >
        <select
          id={`cfg-bind-${slot}`}
          value={boundId ?? ''}
          onChange={(e) => {
            const id = e.target.value || null
            const char = id ? roster.find((c) => c.id === id) : null
            applyBinding(slot, char ? { id: char.id, name: char.name, gender: char.gender, persona: char.persona } : null)
          }}
        >
          <option value="">内置默认({builtinName})</option>
          {roster.map((c) => {
            const occ = occupiedByElse(form.slotBindings, c.id, slot)
            return (
              <option key={c.id} value={c.id}>
                {c.name}
                {occ ? `(已绑定${occ.toUpperCase()})` : ''}
              </option>
            )
          })}
        </select>
      </SetField>
    )
  }

  const boundLabel = (id: string): string => {
    const slots = slotsBoundTo(form.slotBindings, id)
    return slots.length > 0 ? `绑定:${slots.map((s) => s.toUpperCase()).join('/')}` : '未绑定'
  }

  return (
    <SettingsCard card="角色管理" flash={flashCard} title="角色管理" desc="角色库与 A/B/C 槽位绑定;绑定即投影为人设,解绑还原默认">
      {slotRow('a')}
      {slotRow('b')}
      {slotRow('c')}
      <div className="set-actions">
        <span className="set-note">
          库中 {roster.length} 个角色;酒馆卡导入会自动入库。绑定生效 = 名字/性别/人设投影到槽位,
          语音、立绘(工坊)、怪癖仍按槽位独立配置。
        </span>
        <button className="panel-btn" onClick={() => setEditing({ name: '', gender: '女', persona: '' })}>
          新增角色
        </button>
      </div>
      {note && <div className="set-note">{note}</div>}
      {error && <div className="set-note">{error}</div>}
      {roster.map((c) => (
        <div className="mem-fact" key={c.id}>
          <span className="mem-cat">{c.builtin ? '内置' : c.source === 'card' ? '角色卡' : '手动'}</span>
          <span className="mem-content">
            {c.name}({boundLabel(c.id)}
            {c.card ? `;来源:${c.card.spec}` : ''})
          </span>
          <button className="mem-btn" onClick={() => setEditing({ id: c.id, name: c.name, gender: c.gender, persona: c.persona })}>
            编辑
          </button>
          {!c.builtin && (
            <button className="mem-btn" disabled={busy} onClick={() => void onDelete(c.id)}>
              删除
            </button>
          )}
        </div>
      ))}
      {editing && (
        <div className="mem-fact" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
          <SetField label="角色名(≤12 字)" htmlFor="cfg-char-name">
            <input
              id="cfg-char-name"
              value={editing.name}
              maxLength={12}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
          </SetField>
          <SetLine title="性别">
            <div className="seg-group">
              {(['女', '男'] as const).map((g) => (
                <button key={g} className={`seg-btn${editing.gender === g ? ' on' : ''}`} onClick={() => setEditing({ ...editing, gender: g })}>
                  {g}
                </button>
              ))}
            </div>
          </SetLine>
          <SetField
            label="人设"
            htmlFor="cfg-char-persona"
            hint={
              editing.id && roster.find((c) => c.id === editing.id)?.builtin
                ? '内置角色:留空 = 跟随内置模板(改名自动同步);输入内容即固化为自定义'
                : undefined
            }
          >
            <textarea
              id="cfg-char-persona"
              rows={4}
              maxLength={8000}
              placeholder={
                editing.id && roster.find((c) => c.id === editing.id)?.builtin
                  ? defaultPersonaText((roster.find((c) => c.id === editing.id)!.builtin!.toUpperCase()) as 'A' | 'B' | 'C')
                  : undefined
              }
              value={editing.persona}
              onChange={(e) => setEditing({ ...editing, persona: e.target.value })}
            />
          </SetField>
          <div className="set-actions">
            <button className="panel-btn" disabled={busy || !editing.name.trim()} onClick={() => void onSaveCharacter()}>
              保存
            </button>
            <button className="panel-btn" onClick={() => setEditing(null)}>
              取消
            </button>
            <span className="set-note">若该角色已绑定槽位,保存后绑定槽的人设/称呼同步更新</span>
          </div>
        </div>
      )}
    </SettingsCard>
  )
}

export function PersonaSettings() {
  return (
    <>
      <CharacterManagerCard />
      <ImportCardCard />
      <MoodCard />
    </>
  )
}
