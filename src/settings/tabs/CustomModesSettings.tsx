// 模式工坊:用自然语言让 AI 生成新的演出模式(与日常/相声平级),存本机、即时生效。
// 模式是纯数据:生成后可改名字/风格/节奏/触发词/兜底剧本;工具栏分段按钮与"来一段XX"
// 点播自动感知,无需重启。自定义只覆盖"风格/剧本"型模式;直播等需要代码能力的走源码。
import { useRef, useState } from 'react'
import { useSettings } from '../useSettingsSession'
import { SettingsCard, SetField, SetLine } from '../SettingsPrimitives'
import { modeList } from '../../performer/modes'
import {
  CUSTOM_MODE_LIMIT,
  removeCustomMode,
  saveCustomMode,
  useCustomModes,
  type CustomMode,
} from '../../storage/customModesStore'
import { generateCustomMode } from '../../engine/modeGenerator'
import type { DialogLine, Speaker } from '../../performer/player'

/** 兜底剧本 ↔ 文本框互转:一行一句,"A: 台词"前缀指定说话人,缺省甲乙交替(动作统一 talk) */
function scriptToText(script: DialogLine[]): string {
  return script.map((l) => `${l.speaker}: ${l.text}`).join('\n')
}

function textToScript(text: string): DialogLine[] {
  let next: Speaker = 'A'
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((line) => {
      const m = line.match(/^([ABC])[:：]\s*(.+)$/)
      const speaker = (m ? m[1] : next) as Speaker
      const body = m ? m[2] : line
      next = speaker === 'A' ? 'B' : 'A'
      return { speaker, text: body, action: 'talk' }
    })
}

/** 空白草稿:AI 不可用时的手填起点 */
function blankDraft(): CustomMode {
  return {
    id: `custom_${Date.now().toString(36)}`,
    label: '',
    accent: '#7c6cf0',
    gap: 400,
    prompt: '',
    script: [],
    triggers: [],
  }
}

export function CustomModesSettings() {
  const { flashCard } = useSettings()
  const custom = useCustomModes()
  const [requirement, setRequirement] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [draft, setDraft] = useState<CustomMode | null>(null)
  const [label, setLabel] = useState('')
  const [prompt, setPrompt] = useState('')
  const [gap, setGap] = useState('400')
  const [triggersText, setTriggersText] = useState('')
  const [scriptText, setScriptText] = useState('')
  const [armedDelete, setArmedDelete] = useState<string | null>(null)
  const disarmTimer = useRef(0)

  function fillDraft(mode: CustomMode) {
    setDraft(mode)
    setLabel(mode.label)
    setPrompt(mode.prompt)
    setGap(String(mode.gap))
    setTriggersText((mode.triggers ?? []).join('、'))
    setScriptText(scriptToText(mode.script))
    setError(null)
    setNote(null)
  }

  async function onGenerate() {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const mode = await generateCustomMode(requirement)
      fillDraft(mode as CustomMode)
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  async function onSave() {
    if (!draft) return
    setError(null)
    if (!label.trim()) return setError('模式名不能为空')
    if (!prompt.trim()) return setError('风格说明不能为空:它决定角色怎么演这个模式')
    const script = textToScript(scriptText)
    if (script.length < 2) return setError('兜底剧本至少两句(AI 生成失败时播这段)')
    try {
      await saveCustomMode({
        ...draft,
        label: label.trim(),
        prompt: prompt.trim(),
        gap: Number(gap) || 400,
        triggers: triggersText
          .split(/[、,，\s]+/)
          .map((t) => t.trim())
          .filter(Boolean),
        script,
      })
      setDraft(null)
      setNote(`已保存「${label.trim()}」:工具栏与"来一段${label.trim()}"点播即时生效`)
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    }
  }

  async function onDelete(id: string) {
    if (armedDelete !== id) {
      // 两段确认:第一次点亮,3 秒内再点才真删(与退出程序同一交互)
      setArmedDelete(id)
      window.clearTimeout(disarmTimer.current)
      disarmTimer.current = window.setTimeout(() => setArmedDelete(null), 3000)
      return
    }
    window.clearTimeout(disarmTimer.current)
    setArmedDelete(null)
    await removeCustomMode(id)
    if (draft?.id === id) setDraft(null)
    setNote('已删除')
  }

  return (
    <>
      <SettingsCard card="AI 创建模式" flash={flashCard} title="AI 创建模式">
        <SetField
          label="想要的模式"
          htmlFor="cfg-mode-requirement"
          hint="一句话描述玩法,例如:辩论模式,正反方围绕日常小事互怼,最后不服气收尾"
        >
          <textarea
            id="cfg-mode-requirement"
            rows={3}
            value={requirement}
            onChange={(e) => setRequirement(e.target.value)}
            placeholder="描述角色关系、话语结构、怎么收尾…"
          />
        </SetField>
        <div className="shot-key-row">
          <button className="panel-btn" disabled={busy || !requirement.trim()} onClick={() => void onGenerate()}>
            {busy ? '生成中…' : 'AI 生成'}
          </button>
          <button className="panel-btn" disabled={busy} onClick={() => fillDraft(blankDraft())}>
            空白草稿
          </button>
        </div>
        <div className="set-note">
          生成后可修改再保存;也可以在下方直接手填。保存后模式出现在工具栏,并对它说"来一段{label.trim() || 'XX'}"即可点播。
          {custom.length >= CUSTOM_MODE_LIMIT ? ` 最多 ${CUSTOM_MODE_LIMIT} 个,请先删除旧的。` : ''}
        </div>
      </SettingsCard>

      {draft && (
        <SettingsCard card="编辑模式" flash={flashCard} title={draft.label ? `编辑:${draft.label}` : '新模式草稿'}>
          <SetField label="模式名" htmlFor="cfg-mode-label" hint="2~6 个字,显示在工具栏按钮上">
            <input
              id="cfg-mode-label"
              type="text"
              value={label}
              maxLength={8}
              onChange={(e) => setLabel(e.target.value)}
            />
          </SetField>
          <SetField label="风格说明(编剧指令)" htmlFor="cfg-mode-prompt" hint="角色关系/话语结构/收尾方式,拼进每一次生成的指令">
            <textarea id="cfg-mode-prompt" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </SetField>
          <SetLine title="台词间奏(毫秒)" hint="快嘴互怼 200~300,自然闲聊 400 左右">
            <input
              type="number"
              min={100}
              max={2000}
              step={50}
              value={gap}
              onChange={(e) => setGap(e.target.value)}
              style={{ width: 90 }}
            />
          </SetLine>
          <SetField label="点播触发词" htmlFor="cfg-mode-triggers" hint="顿号分隔,如:辩论、抬杠;保存后对角色说「来一段辩论」即可触发">
            <input
              id="cfg-mode-triggers"
              type="text"
              value={triggersText}
              onChange={(e) => setTriggersText(e.target.value)}
            />
          </SetField>
          <SetField
            label="兜底剧本(AI 失败时播)"
            htmlFor="cfg-mode-script"
            hint="一行一句;「A: 台词」指定谁说,缺省甲乙交替"
          >
            <textarea id="cfg-mode-script" rows={5} value={scriptText} onChange={(e) => setScriptText(e.target.value)} />
          </SetField>
          <div className="shot-key-row">
            <button className="panel-btn" onClick={() => void onSave()}>
              保存
            </button>
            <button
              className="panel-btn"
              onClick={() => {
                setDraft(null)
                setError(null)
              }}
            >
              取消
            </button>
          </div>
        </SettingsCard>
      )}

      {(error || note) && (
        <div className="set-note">
          {error ? `⚠ ${error}` : note}
        </div>
      )}

      <SettingsCard card="自定义模式" flash={flashCard} title={`自定义模式(${custom.length})`}>
        {custom.length === 0 ? (
          <div className="set-note">还没有自定义模式。用上面的"AI 创建模式"生成一个试试。</div>
        ) : (
          custom.map((m) => (
            <SetLine
              key={m.id}
              title={`${m.label}(间奏 ${m.gap}ms${(m.triggers ?? []).length ? `,点播:${(m.triggers ?? []).join('/')}` : ''})`}
              hint={m.prompt}
            >
              <div className="shot-key-row">
                <button className="panel-btn" onClick={() => fillDraft(m)}>
                  编辑
                </button>
                <button className="panel-btn" onClick={() => void onDelete(m.id)}>
                  {armedDelete === m.id ? '再点确认删除' : '删除'}
                </button>
              </div>
            </SetLine>
          ))
        )}
      </SettingsCard>

      <SettingsCard card="内置模式" flash={flashCard} title="内置模式(随版本更新)">
        {modeList.map((m) => (
          <SetLine key={m.id} title={m.label} hint={m.prompt}>
            <span className="set-note">{m.script.length} 句兜底</span>
          </SetLine>
        ))}
        <div className="set-note">
          内置模式随应用版本分发;直播模式需要弹幕源等代码能力,不在自定义范围内。
        </div>
      </SettingsCard>
    </>
  )
}
