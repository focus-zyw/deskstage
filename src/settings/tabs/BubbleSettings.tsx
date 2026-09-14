// 气泡工坊:自建台词气泡视觉主题(配色/轮廓/尾巴/排版/材质),AI 生成或手填。
// 主题即数据:保存后写入根节点 CSS 变量即时生效,GeneralSettings 的"气泡风格"与本页共用同一配置。
// 内置「柔彩/夜色玻璃」不可改;自定义上限 10 个,坏数据在存储层拒收。
import { useEffect, useRef, useState } from 'react'
import { useSyncExternalStore } from 'react'
import { useSettings } from '../useSettingsSession'
import { SettingsCard, SetField, SetLine } from '../SettingsPrimitives'
import { subscribeConfig, getConfigSnapshot } from '../../storage/configStore'
import { nameOf } from '../../engine/persona'
import {
  BUBBLE_THEME_LIMIT,
  applyBubbleThemeTo,
  removeBubbleTheme,
  saveBubbleTheme,
  useBubbleThemes,
  type BubbleShadow,
  type BubbleShape,
  type BubbleTailStyle,
  type BubbleTheme,
} from '../../storage/bubbleThemesStore'
import { generateBubbleTheme } from '../../engine/bubbleThemeGenerator'

type ColorKey =
  | 'bg' | 'text' | 'stroke'
  | 'accA' | 'accB' | 'accC'
  | 'bgA' | 'bgB' | 'bgC'
  | 'strokeA' | 'strokeB' | 'strokeC'

type NumKey = 'bgOpacity' | 'strokeW' | 'blurPx' | 'fontSize' | 'maxWidth' | 'radius' | 'fontWeight' | 'lineHeight' | 'paddingX' | 'paddingY'

const SHAPE_OPTIONS: ReadonlyArray<{ value: BubbleShape; label: string }> = [
  { value: 'rounded', label: '柔和' }, { value: 'pill', label: '胶囊' },
  { value: 'square', label: '方角' }, { value: 'cloud', label: '云朵' },
]
const TAIL_OPTIONS: ReadonlyArray<{ value: BubbleTailStyle; label: string }> = [
  { value: 'droplet', label: '水滴' }, { value: 'sharp', label: '尖角' },
  { value: 'round', label: '圆泡' }, { value: 'none', label: '隐藏' },
]
const SHADOW_OPTIONS: ReadonlyArray<{ value: BubbleShadow; label: string }> = [
  { value: 'none', label: '无' }, { value: 'soft', label: '柔和' }, { value: 'strong', label: '明显' },
]

function labelOf<T extends string>(options: ReadonlyArray<{ value: T; label: string }>, value: T): string {
  return options.find((option) => option.value === value)?.label ?? value
}

/** saved.bubbleStyle 的轻量订阅(避免整份 config 重渲染) */
function useSavedBubbleStyle() {
  return useSyncExternalStore(subscribeConfig, getConfigSnapshot).bubbleStyle
}

/** 空白草稿:以柔彩为起点,手填或 AI 重填 */
function blankDraft(): BubbleTheme {
  return {
    id: `custom_${Date.now().toString(36)}`,
    label: '',
    bg: '#faf7f2', text: '#26232f', stroke: '#92887e',
    accA: '#e98050', accB: '#5f86da', accC: '#8572d8',
    bgA: '#fff4eb', bgB: '#edf5ff', bgC: '#f5f0ff',
    strokeA: '#dd8b62', strokeB: '#688fd5', strokeC: '#8974d0',
    bgOpacity: 0.93, strokeW: 1, blurPx: 0, fontSize: 16, maxWidth: 320, radius: 18,
    shape: 'rounded', tailStyle: 'droplet', shadow: 'soft',
    fontWeight: 650, lineHeight: 1.58, paddingX: 17, paddingY: 15,
  }
}

function ChoiceField<T extends string>(props: {
  label: string
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (value: T) => void
}) {
  return (
    <div className="bubble-option">
      <span>{props.label}</span>
      <div className="seg-group">
        {props.options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`seg-btn${props.value === option.value ? ' on' : ''}`}
            onClick={() => props.onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** 颜色小方块行:一行放同一语义的 A/B/C 三色 */
function ColorTriple(props: {
  title: string
  hint?: string
  a: ColorKey
  b: ColorKey
  c: ColorKey
  draft: BubbleTheme
  onPick: (k: ColorKey, v: string) => void
}) {
  return (
    <SetLine title={props.title} hint={props.hint}>
      <div className="bubble-color-row">
        {([props.a, props.b, props.c] as const).map((k, i) => (
          <label key={k} className="bubble-color-chip" title={[nameOf('A'), nameOf('B'), nameOf('C')][i]}>
            <input type="color" value={props.draft[k]} onChange={(e) => props.onPick(k, e.target.value)} />
          </label>
        ))}
      </div>
    </SetLine>
  )
}

function NumField(props: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  return (
    <label className="bubble-num">
      <span>{props.label}</span>
      <input
        type="number"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onChange={(e) => props.onChange(Math.min(props.max, Math.max(props.min, Number(e.target.value) || 0)))}
      />
    </label>
  )
}

export function BubbleSettings() {
  const { saveField } = useSettings()
  const themes = useBubbleThemes()
  const bubbleStyle = useSavedBubbleStyle()
  const [requirement, setRequirement] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [draft, setDraft] = useState<BubbleTheme | null>(null)
  const [armedDelete, setArmedDelete] = useState<string | null>(null)
  const disarmTimer = useRef(0)
  const previewRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const preview = previewRef.current
    if (!preview) return
    applyBubbleThemeTo(preview, draft)
    return () => applyBubbleThemeTo(preview, null)
  }, [draft])

  function pick(k: ColorKey, v: string) {
    if (draft) setDraft({ ...draft, [k]: v })
  }

  function setNum(k: NumKey, v: number) {
    if (draft) setDraft({ ...draft, [k]: v })
  }

  async function onGenerate() {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const rest = await generateBubbleTheme(requirement)
      setDraft({ ...rest, id: `custom_${Date.now().toString(36)}` })
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  async function onSave() {
    if (!draft) return
    setError(null)
    if (!draft.label.trim()) {
      setError('主题名不能为空')
      return
    }
    try {
      const next = { ...draft, label: draft.label.trim() }
      await saveBubbleTheme(next)
      setDraft(null)
      saveField({ bubbleStyle: next.id }, true) // 保存即应用
      setNote(`已保存并应用「${next.label}」`)
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
    await removeBubbleTheme(id)
    if (draft?.id === id) setDraft(null)
    if (bubbleStyle === id) saveField({ bubbleStyle: 'comic' }, true)
    setNote('已删除')
  }

  return (
    <>
      <SettingsCard card="预览" flash={null} title="预览" desc="实时反映当前选中的主题;真实台词气泡同款样式">
        <div ref={previewRef} className={`bubble-preview${draft ? ' editing' : ''}`}>
          {(['A', 'B', 'C'] as const).map((s) => (
            <div key={s} className="bubble" data-speaker={s} data-tail="center">
              <span className="b-name"><i />{s === 'C' ? '场外' : nameOf(s)}</span>
              <span className="b-text">
                {s === 'A' ? '我跟你说,今天这事不简单!' : s === 'B' ? '就这?然后呢。' : '好的,马上办!'}
              </span>
            </div>
          ))}
        </div>
        {draft && <div className="set-note">正在预览未保存的草稿；调整下方选项会立即更新。</div>}
      </SettingsCard>

      <SettingsCard card="选择主题" flash={null} title="选择主题">
        <SetLine title="气泡风格" hint="内置两套不可改;自建主题保存后出现在这里">
          <div className="seg-group">
            <button className={`seg-btn${bubbleStyle === 'comic' ? ' on' : ''}`} onClick={() => saveField({ bubbleStyle: 'comic' }, true)}>
              柔彩
            </button>
            <button className={`seg-btn${bubbleStyle === 'glass' ? ' on' : ''}`} onClick={() => saveField({ bubbleStyle: 'glass' }, true)}>
              夜色玻璃
            </button>
            {themes.map((t) => (
              <button key={t.id} className={`seg-btn${bubbleStyle === t.id ? ' on' : ''}`} onClick={() => saveField({ bubbleStyle: t.id }, true)}>
                {t.label}
              </button>
            ))}
          </div>
        </SetLine>
      </SettingsCard>

      <SettingsCard card="AI 生成主题" flash={null} title="AI 生成主题">
        <SetField
          label="想要的风格"
          htmlFor="cfg-bubble-requirement"
          hint="一句话描述,例如:赛博朋克霓虹风,深色底发光描边;或 樱花粉手账风"
        >
          <textarea
            id="cfg-bubble-requirement"
            rows={2}
            value={requirement}
            onChange={(e) => setRequirement(e.target.value)}
            placeholder="描述配色气质、明暗、材质感觉…"
          />
        </SetField>
        <div className="shot-key-row">
          <button className="panel-btn" disabled={busy || !requirement.trim()} onClick={() => void onGenerate()}>
            {busy ? '生成中…' : 'AI 生成'}
          </button>
          <button className="panel-btn" disabled={busy} onClick={() => setDraft(blankDraft())}>
            空白草稿
          </button>
        </div>
        <div className="set-note">
          生成后进入下方编辑卡,可改每个颜色再保存;也可直接手填。当前 {themes.length}/{BUBBLE_THEME_LIMIT} 个。
        </div>
      </SettingsCard>

      {draft && (
        <SettingsCard card="编辑主题" flash={null} title={draft.label ? `编辑:${draft.label}` : '新主题草稿'}>
          <SetField label="主题名" htmlFor="cfg-bubble-label">
            <input
              id="cfg-bubble-label"
              type="text"
              value={draft.label}
              maxLength={10}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            />
          </SetField>
          <ColorTriple title="台词与描边(全局)" hint="底 / 文字 / 描边" a="bg" b="text" c="stroke" draft={draft} onPick={pick} />
          <ColorTriple title={`名签强调色(${nameOf('A')}/${nameOf('B')}/${nameOf('C')})`} a="accA" b="accB" c="accC" draft={draft} onPick={pick} />
          <ColorTriple title="角色底色" hint="A / B / C 各自带色偏的浅底" a="bgA" b="bgB" c="bgC" draft={draft} onPick={pick} />
          <ColorTriple title="角色描边" a="strokeA" b="strokeB" c="strokeC" draft={draft} onPick={pick} />
          <div className="bubble-option-grid">
            <ChoiceField<BubbleShape>
              label="气泡轮廓"
              value={draft.shape}
              options={SHAPE_OPTIONS}
              onChange={(shape) => setDraft({ ...draft, shape })}
            />
            <ChoiceField<BubbleTailStyle>
              label="指向角"
              value={draft.tailStyle}
              options={TAIL_OPTIONS}
              onChange={(tailStyle) => setDraft({ ...draft, tailStyle })}
            />
            <ChoiceField<BubbleShadow>
              label="阴影"
              value={draft.shadow}
              options={SHADOW_OPTIONS}
              onChange={(shadow) => setDraft({ ...draft, shadow })}
            />
          </div>
          <div className="bubble-nums">
            <NumField label="底色不透明度 0.5~1" value={draft.bgOpacity} min={0.5} max={1} step={0.01} onChange={(v) => setNum('bgOpacity', v)} />
            <NumField label="描边宽 1~3" value={draft.strokeW} min={1} max={3} onChange={(v) => setNum('strokeW', v)} />
            <NumField label="背景模糊 0~24" value={draft.blurPx} min={0} max={24} onChange={(v) => setNum('blurPx', v)} />
            <NumField label="字号 12~22" value={draft.fontSize} min={12} max={22} onChange={(v) => setNum('fontSize', v)} />
            <NumField label="最大宽 240~480" value={draft.maxWidth} min={240} max={480} step={10} onChange={(v) => setNum('maxWidth', v)} />
            <NumField label="圆角 6~28" value={draft.radius} min={6} max={28} onChange={(v) => setNum('radius', v)} />
            <NumField label="字重 400~800" value={draft.fontWeight} min={400} max={800} step={10} onChange={(v) => setNum('fontWeight', v)} />
            <NumField label="行高 1.2~1.9" value={draft.lineHeight} min={1.2} max={1.9} step={0.05} onChange={(v) => setNum('lineHeight', v)} />
            <NumField label="左右留白 10~28" value={draft.paddingX} min={10} max={28} onChange={(v) => setNum('paddingX', v)} />
            <NumField label="上下留白 10~28" value={draft.paddingY} min={10} max={28} onChange={(v) => setNum('paddingY', v)} />
          </div>
          <div className="shot-key-row">
            <button className="panel-btn" onClick={() => void onSave()}>
              保存并应用
            </button>
            <button className="panel-btn" onClick={() => setDraft(null)}>
              取消
            </button>
          </div>
        </SettingsCard>
      )}

      {(error || note) && <div className="set-note">{error ? `⚠ ${error}` : note}</div>}

      <SettingsCard card="自定义主题" flash={null} title={`自定义主题(${themes.length})`}>
        {themes.length === 0 ? (
          <div className="set-note">还没有自定义主题。用上面的"AI 生成主题"或空白草稿创建一个。</div>
        ) : (
          themes.map((t) => (
            <SetLine
              key={t.id}
              title={`${t.label}${bubbleStyle === t.id ? '(使用中)' : ''}`}
              hint={`轮廓 ${labelOf(SHAPE_OPTIONS, t.shape)} · 尾巴 ${labelOf(TAIL_OPTIONS, t.tailStyle)} · 字号 ${t.fontSize} · 模糊 ${t.blurPx}px`}
            >
              <div className="shot-key-row">
                <button className="panel-btn" onClick={() => setDraft(t)}>
                  编辑
                </button>
                <button className="panel-btn" onClick={() => void onDelete(t.id)}>
                  {armedDelete === t.id ? '再点确认删除' : '删除'}
                </button>
              </div>
            </SetLine>
          ))
        )}
        <div className="set-note">删除正在使用的主题会自动回落「柔彩」。界面主题(设置窗口深浅色)与气泡主题相互独立。</div>
      </SettingsCard>
    </>
  )
}
