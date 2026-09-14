// 气泡工坊 V2:左侧多场景预览,右侧模板画廊 + 材质/配色/文字/细节分组配置。
// 预览与舞台共用同一 Bubble 组件与 resolve 链路(工坊所见即舞台所得);
// 改稿动作一律经 mutateBubbleTheme,配色默认由引擎从主色派生,高级模式按语义色覆盖。
// 内置「柔彩/夜色玻璃」不可改但可复制;自定义上限 10 个,坏数据在存储层拒收。
import { useMemo, useRef, useState } from 'react'
import { useSyncExternalStore } from 'react'
import { useSettings } from '../useSettingsSession'
import { SettingsCard, SetField, SetLine } from '../SettingsPrimitives'
import { subscribeConfig, getConfigSnapshot } from '../../storage/configStore'
import {
  BUBBLE_THEME_LIMIT,
  getBubbleThemesV2Snapshot,
  removeBubbleTheme,
  saveBubbleTheme,
  subscribeBubbleThemes,
} from '../../storage/bubbleThemesStore'
import {
  BUILT_IN_BUBBLE_THEMES,
  BUILTIN_BUBBLE_THEME_IDS,
  Bubble,
  BubbleThemeProvider,
  autoFixBubbleTheme,
  diagnoseBubbleTheme,
  effectiveBubbleColors,
  generateBubbleCandidates,
  isBuiltinBubbleThemeId,
  listBubbleTemplates,
  mutateBubbleTheme,
  normalizeBubbleTheme,
  type BubbleCandidate,
  type BubbleMaterialId,
  type BubbleNameplatePosition,
  type BubbleNameplateStyle,
  type BubbleShadowLevel,
  type BubbleTailStyle,
  type BubbleTemplateId,
  type BubbleThemeV2,
} from '../../bubble'

/** saved.bubbleStyle 的轻量订阅(避免整份 config 重渲染) */
function useSavedBubbleStyle() {
  return useSyncExternalStore(subscribeConfig, getConfigSnapshot).bubbleStyle
}

function useBubbleThemesV2(): BubbleThemeV2[] {
  return useSyncExternalStore(subscribeBubbleThemes, getBubbleThemesV2Snapshot)
}

const TEMPLATES = listBubbleTemplates()
/** 模板画廊直接渲染真实 Bubble,只把模板相关组切到目录默认值;不维护第二套近似骨架。 */
const TEMPLATE_THUMB_THEMES = Object.fromEntries(TEMPLATES.map((tpl) => {
  const retargeted = mutateBubbleTheme(BUILT_IN_BUBBLE_THEMES.comic, {
    type: 'retarget-template',
    templateId: tpl.id,
    preserve: ['palette'],
  })
  return [tpl.id, mutateBubbleTheme(retargeted, { type: 'reset-to-template-defaults' })]
})) as Record<BubbleTemplateId, BubbleThemeV2>
const MATERIAL_LABEL: Record<BubbleMaterialId, string> = {
  solid: '纯色', gradient: '渐变', glass: '玻璃', paper: '纸张', neon: '霓虹',
}
const TAIL_LABEL: Record<BubbleTailStyle, string> = {
  droplet: '水滴', triangle: '尖角', curve: '弧尾', bubbles: '圆泡串', none: '隐藏',
}
const NAMEPLATE_LABEL: Record<BubbleNameplateStyle, string> = {
  badge: '徽章', tab: '标签槽', inline: '行内', hidden: '隐藏',
}
const NAMEPLATE_POS_LABEL: Record<BubbleNameplatePosition, string> = {
  'top-left': '左上', 'top-center': '居中', inside: '框内',
}
const SHADOW_LABEL: Record<BubbleShadowLevel, string> = { none: '无', soft: '柔和', strong: '明显' }
const FONT_LABEL: Record<BubbleThemeV2['typography']['fontPreset'], string> = {
  friendly: '友好', comic: '圆润', clean: '利落', pixel: '像素',
}
const ALIGN_LABEL: Record<BubbleThemeV2['typography']['align'], string> = { left: '左对齐', center: '居中' }

/** 撤销/重做历史栈(上限 50 步;draft=null 表示未在编辑) */
interface DraftHistory {
  past: BubbleThemeV2[]
  cur: BubbleThemeV2 | null
  future: BubbleThemeV2[]
}

type SceneText = 'short' | 'long' | 'shout'
type Desk = 'light' | 'dark' | 'clear'

const SCENE_TEXT: Record<SceneText, string> = {
  short: '我跟你说,今天这事不简单!',
  shout: '你给我站住——!!',
  long: '那天晚上我们聊了很久,从巷口的路灯一直聊到楼下的猫都睡着了,风把窗帘吹得一鼓一鼓,谁也没有先说再见。这一大段就是故意写这么长,看看气泡超过八十个字之后字号会不会自动降下来,行距和留白是不是还稳。',
}

function newThemeId(): string {
  return `custom_${Date.now().toString(36)}`
}

function Seg<T extends string>(props: {
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (v: T) => void
}) {
  return (
    <div className="seg-group">
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`seg-btn${props.value === o.value ? ' on' : ''}`}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Num(props: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
}) {
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

const OVERRIDE_KEYS = [
  { key: 'surface', label: '底色' },
  { key: 'text', label: '文字' },
  { key: 'outline', label: '描边' },
  { key: 'accA', label: '甲名签' },
  { key: 'accB', label: '乙名签' },
  { key: 'accC', label: '丙名签' },
  { key: 'surfaceA', label: '甲底' },
  { key: 'surfaceB', label: '乙底' },
  { key: 'surfaceC', label: '丙底' },
  { key: 'outlineA', label: '甲描' },
  { key: 'outlineB', label: '乙描' },
  { key: 'outlineC', label: '丙描' },
] as const

export function BubbleSettings() {
  const { saveField } = useSettings()
  const themes = useBubbleThemesV2()
  const bubbleStyle = useSavedBubbleStyle()
  // 编辑历史(撤销/重做)
  const [hist, setHist] = useState<DraftHistory>({ past: [], cur: null, future: [] })
  const draft = hist.cur
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [armedDelete, setArmedDelete] = useState<string | null>(null)
  const disarmTimer = useRef(0)
  // 预览场景:文本长短/喊话 × 上下位置 × 桌面深浅 × 说话人(高级配色改 B/C 时必须能单独看)
  const [sceneText, setSceneText] = useState<SceneText>('short')
  const [sceneBelow, setSceneBelow] = useState(false)
  const [desk, setDesk] = useState<Desk>('light')
  const [sceneSpeaker, setSceneSpeaker] = useState<'A' | 'B' | 'C' | 'all'>('A')
  const [compare, setCompare] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  // AI 三候选
  const [requirement, setRequirement] = useState('')
  const [busy, setBusy] = useState(false)
  const [candidates, setCandidates] = useState<BubbleCandidate[] | null>(null)

  /** 当前生效主题(内置或自定义;被删回落柔彩),用于"未编辑时预览"与前后对比 */
  const currentTheme = useMemo<BubbleThemeV2>(() => {
    if (isBuiltinBubbleThemeId(bubbleStyle)) return BUILT_IN_BUBBLE_THEMES[bubbleStyle]
    return themes.find((t) => t.id === bubbleStyle) ?? BUILT_IN_BUBBLE_THEMES.comic
  }, [bubbleStyle, themes])
  const previewTheme = draft ?? currentTheme
  const issues = useMemo(() => (draft ? diagnoseBubbleTheme(draft) : []), [draft])

  function push(next: BubbleThemeV2 | null): void {
    setHist((h) =>
      next
        ? { past: [...h.past, h.cur].filter((t): t is BubbleThemeV2 => Boolean(t)).slice(-50), cur: next, future: [] }
        : { past: [], cur: null, future: [] },
    )
  }

  /** 编辑一步:normalize 后压栈(撤销/重做的最小单位) */
  function update(fn: (t: BubbleThemeV2) => BubbleThemeV2): void {
    if (!draft) return
    const next = normalizeBubbleTheme(fn(draft))
    if (next) push(next)
  }

  function undo(): void {
    setHist((h) => {
      const prev = h.past[h.past.length - 1]
      if (!prev || !h.cur) return h
      return { past: h.past.slice(0, -1), cur: prev, future: [h.cur, ...h.future].slice(0, 50) }
    })
  }
  function redo(): void {
    setHist((h) => {
      const next = h.future[0]
      if (!next || !h.cur) return h
      return { past: [...h.past, h.cur].slice(-50), cur: next, future: h.future.slice(1) }
    })
  }

  /** 简洁配色:改派生输入并丢弃覆盖,让引擎按主色重算全套语义色 */
  function setSimplePalette(patch: Partial<Pick<BubbleThemeV2['palette'], 'primary' | 'lightness' | 'speakerStrength' | 'mode'>>): void {
    update((t) => ({
      ...t,
      palette: { ...t.palette, ...patch, overrides: undefined },
    }))
  }

  /** 高级配色:按语义色写覆盖(其余仍走派生) */
  function setOverride(key: (typeof OVERRIDE_KEYS)[number]['key'], value: string): void {
    update((t) => ({
      ...t,
      palette: { ...t.palette, overrides: { ...t.palette.overrides, [key]: value } },
    }))
  }

  async function onGenerate(): Promise<void> {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const list = await generateBubbleCandidates(requirement)
      setCandidates(list)
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  function adopt(candidate: BubbleCandidate): void {
    push(candidate.theme)
    setCandidates(null)
    setNote(`已采纳「${candidate.theme.label}」,可继续调整后保存`)
    if (candidate.fixes.length > 0) setNote(`已采纳并自动修复:${candidate.fixes.join(';')}`)
  }

  async function onSave(): Promise<void> {
    if (!draft) return
    setError(null)
    if (!draft.label.trim()) {
      setError('主题名不能为空')
      return
    }
    try {
      const next = normalizeBubbleTheme({ ...draft, label: draft.label.trim(), id: draft.id })
      if (!next) throw new Error('主题数据不合法')
      await saveBubbleTheme(next)
      push(null)
      saveField({ bubbleStyle: next.id }, true) // 保存即应用
      setNote(`已保存并应用「${next.label}」`)
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    }
  }

  async function onDelete(id: string): Promise<void> {
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
    if (draft?.id === id) push(null)
    if (bubbleStyle === id) saveField({ bubbleStyle: 'comic' }, true)
    setNote('已删除')
  }

  function duplicate(source: BubbleThemeV2): void {
    push({ ...source, id: newThemeId(), label: `${source.label}副本`.slice(0, 10) })
  }

  const tpl = draft ? TEMPLATES.find((t) => t.id === draft.templateId) : undefined
  const colors = draft ? effectiveBubbleColors(draft) : null
  const ov = draft?.palette.overrides ?? {}
  const sceneLoud = sceneText === 'shout'

  return (
    <div className="bubble-workshop">
      {/* ---------- 左:多场景预览(与舞台同一链路) ---------- */}
      <aside className="bw-preview-col">
        <SettingsCard card="预览" flash={null} title="预览" desc="真实台词气泡同款;切换主题不保存即失效">
          <div className="bw-scenes">
            <Seg<SceneText>
              value={sceneText}
              onChange={setSceneText}
              options={[
                { value: 'short', label: '短句' },
                { value: 'long', label: '长文本' },
                { value: 'shout', label: '喊话' },
              ]}
            />
            <Seg<string>
              value={sceneBelow ? 'below' : 'above'}
              onChange={(v) => setSceneBelow(v === 'below')}
              options={[
                { value: 'above', label: '角色上方' },
                { value: 'below', label: '角色下方' },
              ]}
            />
            <Seg<Desk>
              value={desk}
              onChange={setDesk}
              options={[
                { value: 'light', label: '浅色桌面' },
                { value: 'dark', label: '深色桌面' },
                { value: 'clear', label: '透明桌面' },
              ]}
            />
            <Seg<string>
              value={sceneSpeaker}
              onChange={(v) => setSceneSpeaker(v as 'A' | 'B' | 'C' | 'all')}
              options={[
                { value: 'A', label: '甲' },
                { value: 'B', label: '乙' },
                { value: 'C', label: '丙' },
                { value: 'all', label: '三人' },
              ]}
            />
          </div>
          <div className={`bw-stage desk-${desk}${draft ? ' editing' : ''}`}>
            <div className="bw-stage-row">
              <BubbleThemeProvider theme={previewTheme}>
                {(sceneSpeaker === 'all' ? (['A', 'B', 'C'] as const) : ([sceneSpeaker] as const)).map((sp) => (
                  <Bubble
                    key={sp}
                    text={SCENE_TEXT[sceneText]}
                    speaker={sp}
                    below={sceneBelow}
                    loud={sceneLoud}
                    tailSide={sp === 'C' ? 'center' : 'left'}
                  />
                ))}
              </BubbleThemeProvider>
            </div>
            {compare && draft && (
              <div className="bw-stage-row">
                <div className="bw-vs">保存前:{currentTheme.label}</div>
                <BubbleThemeProvider theme={currentTheme}>
                  {(sceneSpeaker === 'all' ? (['A', 'B', 'C'] as const) : ([sceneSpeaker] as const)).map((sp) => (
                    <Bubble
                      key={sp}
                      text={SCENE_TEXT[sceneText]}
                      speaker={sp}
                      below={sceneBelow}
                      loud={sceneLoud}
                      tailSide={sp === 'C' ? 'center' : 'left'}
                    />
                  ))}
                </BubbleThemeProvider>
              </div>
            )}
          </div>
          <div className="shot-key-row">
            <button className={`panel-btn${compare ? ' primary' : ''}`} disabled={!draft} onClick={() => setCompare((c) => !c)}>
              {compare ? '退出对比' : '保存前后对比'}
            </button>
          </div>
          {issues.length > 0 && (
            <div className="bw-diag">
              <span>⚠ {issues.map((i) => i.message).join(';')}</span>
              <button
                className="panel-btn"
                onClick={() => {
                  if (!draft) return
                  const fixed = autoFixBubbleTheme(draft)
                  push(fixed.theme)
                  setNote(fixed.fixes.length > 0 ? `已修复:${fixed.fixes.join(';')}` : '未发现可自动修复的问题')
                }}
              >
                一键修复
              </button>
            </div>
          )}
          {draft && <div className="set-note">正在编辑草稿(未保存);调整右侧选项立即更新。</div>}
        </SettingsCard>
      </aside>

      {/* ---------- 右:配置列 ---------- */}
      <div className="bw-config-col">
        <SettingsCard card="选择主题" flash={null} title="选择主题">
          <SetLine title="内置主题" hint="不可修改,可复制一份来改">
            <div className="shot-key-row">
              {BUILTIN_BUBBLE_THEME_IDS.map((id) => (
                <button
                  key={id}
                  className={`seg-btn${bubbleStyle === id ? ' on' : ''}`}
                  onClick={() => saveField({ bubbleStyle: id }, true)}
                >
                  {BUILT_IN_BUBBLE_THEMES[id].label}
                </button>
              ))}
              <button className="panel-btn" onClick={() => duplicate(currentTheme)}>
                复制当前来改
              </button>
            </div>
          </SetLine>
          <SetLine title="自定义主题" hint={`${themes.length}/${BUBBLE_THEME_LIMIT}`}>
            <span />
          </SetLine>
          {themes.length === 0 ? (
            <div className="set-note">还没有自定义主题,用下面的 AI 生成或复制内置主题。</div>
          ) : (
            themes.map((t) => (
              <SetLine
                key={t.id}
                title={`${t.label}${bubbleStyle === t.id ? '(使用中)' : ''}`}
                hint={`${TEMPLATES.find((x) => x.id === t.templateId)?.label ?? t.templateId} · ${MATERIAL_LABEL[t.material.id]} · 字号 ${t.typography.size}`}
              >
                <div className="shot-key-row">
                  <button className={`panel-btn${bubbleStyle === t.id ? ' primary' : ''}`} onClick={() => saveField({ bubbleStyle: t.id }, true)}>
                    应用
                  </button>
                  <button className="panel-btn" onClick={() => {
                    push(t)
                    setNote(`正在编辑「${t.label}」`)
                  }}>
                    编辑
                  </button>
                  <button className="panel-btn" onClick={() => duplicate(t)}>复制</button>
                  <button className="panel-btn" onClick={() => void onDelete(t.id)}>
                    {armedDelete === t.id ? '再点确认删除' : '删除'}
                  </button>
                </div>
              </SetLine>
            ))
          )}
        </SettingsCard>

        <SettingsCard card="AI 生成主题" flash={null} title="AI 生成主题">
          <SetField
            label="想要的风格"
            htmlFor="cfg-bubble-requirement"
            hint="一句话描述,例如:樱花粉手账风,温柔一点;或 赛博朋克霓虹风。AI 一次给出三个方向不同的方案"
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
            <button className="panel-btn primary" disabled={busy || !requirement.trim()} onClick={() => void onGenerate()}>
              {busy ? '生成中…' : 'AI 生成三方案'}
            </button>
          </div>
          {candidates && (
            <div className="bw-candidates">
              {candidates.map((c) => (
                <div key={c.slot} className="bw-candidate">
                  <div className="bw-cand-stage">
                    <BubbleThemeProvider theme={c.theme}>
                      <Bubble text="就这?然后呢。" speaker="B" tailSide="center" />
                    </BubbleThemeProvider>
                  </div>
                  <div className="bw-cand-name">{c.theme.label}</div>
                  <div className="bw-cand-meta">
                    {TEMPLATES.find((x) => x.id === c.theme.templateId)?.label} · {MATERIAL_LABEL[c.theme.material.id]}
                  </div>
                  <button className="panel-btn primary" onClick={() => adopt(c)}>
                    用这个
                  </button>
                </div>
              ))}
            </div>
          )}
        </SettingsCard>

        {draft && tpl && colors && (
          <SettingsCard card="编辑主题" flash={null} title={draft.label ? `编辑:${draft.label}` : '新主题草稿'}>
            <SetField label="主题名" htmlFor="cfg-bubble-label">
              <input
                id="cfg-bubble-label"
                type="text"
                value={draft.label}
                maxLength={10}
                onChange={(e) => update((t) => ({ ...t, label: e.target.value }))}
              />
            </SetField>

            {/* 样式:模板画廊 */}
            <SetLine title="模板" hint={tpl.desc}>
              <span />
            </SetLine>
            <div className="bw-gallery">
              {TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`bw-tpl${draft.templateId === t.id ? ' on' : ''}`}
                  title={t.desc}
                  onClick={() => update((cur) => mutateBubbleTheme(cur, { type: 'retarget-template', templateId: t.id as BubbleTemplateId, preserve: ['palette', 'typography'] }))}
                >
                  <span className="bw-thumb" aria-hidden>
                    <BubbleThemeProvider theme={TEMPLATE_THUMB_THEMES[t.id]}>
                      <Bubble text="预览" speaker="A" tailSide="center" />
                    </BubbleThemeProvider>
                  </span>
                  <span className="bw-tpl-label">{t.label}</span>
                </button>
              ))}
            </div>

            <div className="bubble-option-grid">
              <div className="bubble-option">
                <span>材质</span>
                <Seg<BubbleMaterialId>
                  value={draft.material.id}
                  options={tpl.materials.map((m) => ({ value: m, label: MATERIAL_LABEL[m] }))}
                  onChange={(materialId) => update((cur) => mutateBubbleTheme(cur, { type: 'set-material', materialId }))}
                />
              </div>
              <div className="bubble-option">
                <span>尾巴</span>
                <Seg<BubbleTailStyle>
                  value={draft.tail.style}
                  options={(Object.keys(TAIL_LABEL) as BubbleTailStyle[]).map((v) => ({ value: v, label: TAIL_LABEL[v] }))}
                  onChange={(style) => update((cur) => ({ ...cur, tail: { ...cur.tail, style } }))}
                />
              </div>
              <div className="bubble-option">
                <span>名签</span>
                <Seg<BubbleNameplateStyle>
                  value={draft.nameplate.style}
                  options={(Object.keys(NAMEPLATE_LABEL) as BubbleNameplateStyle[]).map((v) => ({ value: v, label: NAMEPLATE_LABEL[v] }))}
                  onChange={(style) => update((cur) => ({ ...cur, nameplate: { ...cur.nameplate, style } }))}
                />
              </div>
              {draft.nameplate.style === 'badge' || draft.nameplate.style === 'tab' ? (
                <div className="bubble-option">
                  <span>名签位置</span>
                  <Seg<BubbleNameplatePosition>
                    value={draft.nameplate.position}
                    options={(Object.keys(NAMEPLATE_POS_LABEL) as BubbleNameplatePosition[]).map((v) => ({ value: v, label: NAMEPLATE_POS_LABEL[v] }))}
                    onChange={(position) => update((cur) => ({ ...cur, nameplate: { ...cur.nameplate, position } }))}
                  />
                </div>
              ) : null}
            </div>

            {/* 配色:简洁 + 高级 */}
            <SetLine title="配色" hint="简洁模式由主色自动派生全套颜色;高级模式可单独覆盖">
              <button className="panel-btn" onClick={() => setAdvanced((a) => !a)}>
                {advanced ? '收起高级配色' : '展开高级配色'}
              </button>
            </SetLine>
            <div className="bubble-color-row" title="主色(角色甲的名签色,整套配色的出发点)">
              <label className="bubble-color-chip">
                <input type="color" value={draft.palette.primary} onChange={(e) => setSimplePalette({ primary: e.target.value })} />
              </label>
              <div className="bw-simple-palette">
                <Seg<string>
                  value={draft.palette.lightness}
                  onChange={(v) => setSimplePalette({ lightness: v as 'light' | 'dark' })}
                  options={[
                    { value: 'light', label: '浅色' },
                    { value: 'dark', label: '深色' },
                  ]}
                />
                <Seg<string>
                  value={draft.palette.mode}
                  onChange={(v) => setSimplePalette({ mode: v as 'unified' | 'per-speaker' })}
                  options={[
                    { value: 'per-speaker', label: '角色独立底色' },
                    { value: 'unified', label: '统一底色' },
                  ]}
                />
              </div>
            </div>
            <label className="bw-strength">
              <span>角色区分强度 {Math.round(draft.palette.speakerStrength)}</span>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(draft.palette.speakerStrength)}
                onChange={(e) => setSimplePalette({ speakerStrength: Number(e.target.value) })}
              />
            </label>
            {advanced && (
              <div className="bw-advanced-colors">
                {OVERRIDE_KEYS.map(({ key, label }) => (
                  <label key={key} className="bubble-color-chip" title={`${label}(当前 ${colors[key]})`}>
                    <span>{label}</span>
                    <input type="color" value={ov[key] ?? colors[key]} onChange={(e) => setOverride(key, e.target.value)} />
                  </label>
                ))}
                <button className="panel-btn" disabled={!draft.palette.overrides} onClick={() => update((t) => ({ ...t, palette: { ...t.palette, overrides: undefined } }))}>
                  清除覆盖
                </button>
              </div>
            )}

            {/* 文字 */}
            <SetLine title="文字" hint="字体、字号、字重、行高与对齐">
              <span />
            </SetLine>
            <div className="bubble-option-grid">
              <div className="bubble-option">
                <span>字体</span>
                <Seg<BubbleThemeV2['typography']['fontPreset']>
                  value={draft.typography.fontPreset}
                  options={(Object.keys(FONT_LABEL) as BubbleThemeV2['typography']['fontPreset'][]).map((v) => ({ value: v, label: FONT_LABEL[v] }))}
                  onChange={(fontPreset) => update((cur) => ({ ...cur, typography: { ...cur.typography, fontPreset } }))}
                />
              </div>
              <div className="bubble-option">
                <span>对齐</span>
                <Seg<BubbleThemeV2['typography']['align']>
                  value={draft.typography.align}
                  options={(Object.keys(ALIGN_LABEL) as BubbleThemeV2['typography']['align'][]).map((v) => ({ value: v, label: ALIGN_LABEL[v] }))}
                  onChange={(align) => update((cur) => ({ ...cur, typography: { ...cur.typography, align } }))}
                />
              </div>
            </div>
            <div className="bubble-nums">
              <Num label="字号 12~22" value={draft.typography.size} min={12} max={22} onChange={(v) => update((cur) => ({ ...cur, typography: { ...cur.typography, size: v } }))} />
              <Num label="字重 400~800" value={draft.typography.weight} min={400} max={800} step={10} onChange={(v) => update((cur) => ({ ...cur, typography: { ...cur.typography, weight: v } }))} />
              <Num label="行高 1.2~1.9" value={draft.typography.lineHeight} min={1.2} max={1.9} step={0.05} onChange={(v) => update((cur) => ({ ...cur, typography: { ...cur.typography, lineHeight: v } }))} />
              {draft.tail.style !== 'none' && (
                <Num label="尾巴大小 10~24" value={draft.tail.size} min={10} max={24} onChange={(v) => update((cur) => ({ ...cur, tail: { ...cur.tail, size: v } }))} />
              )}
            </div>

            {/* 细节 */}
            <SetLine title="细节" hint="描边、阴影、辉光、纹理与留白">
              <span />
            </SetLine>
            <div className="bubble-option-grid">
              <div className="bubble-option">
                <span>阴影</span>
                <Seg<BubbleShadowLevel>
                  value={draft.effects.shadow}
                  options={(Object.keys(SHADOW_LABEL) as BubbleShadowLevel[]).map((v) => ({ value: v, label: SHADOW_LABEL[v] }))}
                  onChange={(shadow) => update((cur) => ({ ...cur, effects: { ...cur.effects, shadow } }))}
                />
              </div>
            </div>
            <div className="bubble-nums">
              <Num label="描边宽 0~4" value={draft.frame.outlineWidth} min={0} max={4} step={0.5} onChange={(v) => update((cur) => ({ ...cur, frame: { ...cur.frame, outlineWidth: v } }))} />
              {tpl.radiusEditable && (
                <Num label="圆角 6~28" value={draft.frame.radius} min={6} max={28} onChange={(v) => update((cur) => ({ ...cur, frame: { ...cur.frame, radius: v } }))} />
              )}
              <Num label="辉光 0~100" value={draft.effects.glow} min={0} max={100} onChange={(v) => update((cur) => ({ ...cur, effects: { ...cur.effects, glow: v } }))} />
              {draft.material.id === 'paper' && (
                <Num label="纹理 0~100" value={draft.effects.texture} min={0} max={100} onChange={(v) => update((cur) => ({ ...cur, effects: { ...cur.effects, texture: v } }))} />
              )}
              <Num label="最大宽 240~520" value={draft.layout.maxWidth} min={240} max={520} step={10} onChange={(v) => update((cur) => ({ ...cur, layout: { ...cur.layout, maxWidth: v } }))} />
              <Num label="左右留白 10~28" value={draft.layout.paddingX} min={10} max={28} onChange={(v) => update((cur) => ({ ...cur, layout: { ...cur.layout, paddingX: v } }))} />
              <Num label="上下留白 8~28" value={draft.layout.paddingY} min={8} max={28} onChange={(v) => update((cur) => ({ ...cur, layout: { ...cur.layout, paddingY: v } }))} />
              <Num label="底色不透明度 0.35~1" value={draft.material.opacity} min={0.35} max={1} step={0.01} onChange={(v) => update((cur) => ({ ...cur, material: { ...cur.material, opacity: v } }))} />
              {draft.material.id === 'glass' && (
                <Num label="背景模糊 0~24" value={draft.material.blur} min={0} max={24} onChange={(v) => update((cur) => ({ ...cur, material: { ...cur.material, blur: v } }))} />
              )}
            </div>

            {/* 操作行 */}
            <div className="shot-key-row">
              <button className="panel-btn" disabled={hist.past.length === 0} onClick={undo}>撤销</button>
              <button className="panel-btn" disabled={hist.future.length === 0} onClick={redo}>重做</button>
              <button className="panel-btn" onClick={() => update((cur) => mutateBubbleTheme(cur, { type: 'reset-to-template-defaults' }))}>
                恢复模板默认
              </button>
              <button className="panel-btn" onClick={() => update((cur) => mutateBubbleTheme(cur, { type: 'jitter-colors' }))}>
                随机微调配色
              </button>
              <button className="panel-btn" onClick={() => update((cur) => mutateBubbleTheme(cur, { type: 'simpler-nameplate' }))}>
                名签更简
              </button>
              <button className="panel-btn" onClick={() => update((cur) => mutateBubbleTheme(cur, { type: 'softer-shadow' }))}>
                阴影弱一点
              </button>
              <button className="panel-btn" onClick={() => update((cur) => mutateBubbleTheme(cur, { type: 'playful-font' }))}>
                字体更活泼
              </button>
              <button className="panel-btn primary" onClick={() => void onSave()}>保存并应用</button>
              <button className="panel-btn" onClick={() => push(null)}>取消</button>
            </div>
          </SettingsCard>
        )}

        {(error || note) && <div className="set-note">{error ? `⚠ ${error}` : note}</div>}
      </div>
    </div>
  )
}
