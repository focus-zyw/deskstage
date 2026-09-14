// 气泡主题引擎回归:目录完整性、V2 清洗、V1 迁移、resolve 兜底、配色诊断/修复、
// mutate 改稿动作、根兼容变量同步。全部穿 src/bubble 公共接口,不碰内部颜色工具。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let bubble
let generateBubbleCandidates

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  bubble = await server.ssrLoadModule('/src/bubble/index.ts')
  ;({ generateBubbleCandidates } = await server.ssrLoadModule('/src/bubble/generate.ts'))
})

after(async () => {
  await server?.close()
})

const HEX_RE = /^#[0-9a-f]{6}$/

const validV2 = () => ({
  version: 2,
  id: 'custom_test',
  label: '测试',
  templateId: 'soft-chat',
  material: { id: 'solid', opacity: 0.9, blur: 12 },
  palette: { mode: 'per-speaker', primary: '#e98050', lightness: 'light', speakerStrength: 60 },
  frame: { radius: 18, outlineWidth: 1 },
  typography: { fontPreset: 'friendly', size: 16, weight: 650, lineHeight: 1.58, align: 'left' },
  nameplate: { style: 'badge', position: 'top-left' },
  tail: { style: 'droplet', size: 16 },
  layout: { maxWidth: 320, paddingX: 17, paddingY: 15 },
  effects: { shadow: 'soft', glow: 0, texture: 0 },
})

test('目录:七个模板齐全,兼容材质非空且含默认材质', () => {
  const list = bubble.listBubbleTemplates()
  assert.equal(list.length, 7)
  for (const tpl of list) {
    assert.ok(tpl.materials.length >= 1, `${tpl.id} 至少一种兼容材质`)
    assert.ok(tpl.materials.includes(tpl.defaultMaterial), `${tpl.id} 默认材质必须在白名单内`)
  }
  assert.deepEqual(
    list.map((t) => t.id).sort(),
    ['cloud', 'comic-burst', 'pill', 'rpg', 'soft-chat', 'sticker', 'caption'].sort(),
  )
})

test('目录:内置柔彩/夜色玻璃是合法 V2,normalize 后字段不变', () => {
  for (const id of bubble.BUILTIN_BUBBLE_THEME_IDS) {
    const t = bubble.BUILT_IN_BUBBLE_THEMES[id]
    const clean = bubble.normalizeBubbleTheme(t)
    assert.ok(clean, `${id} 应为合法 V2`)
    assert.deepEqual(clean, t, `${id} normalize 幂等且逐字段一致`)
  }
})

test('清洗 V2:钳位、材质降级、blur 非 glass 强制 0、坏 id/label 拒收', () => {
  const t = bubble.normalizeBubbleTheme({
    ...validV2(),
    templateId: 'comic-burst',
    material: { id: 'glass', opacity: 9, blur: 20 },
    frame: { radius: 99, outlineWidth: -3 },
    typography: { fontPreset: 'friendly', size: 99, weight: 999, lineHeight: 9, align: 'left' },
    layout: { maxWidth: 99, paddingX: 99, paddingY: 0 },
  })
  assert.ok(t)
  // 玻璃不在 comic-burst 白名单 → 回落 solid;blur 随之清 0
  assert.equal(t.material.id, 'solid')
  assert.equal(t.material.blur, 0)
  assert.equal(t.material.opacity, 1)
  assert.equal(t.frame.radius, 28) // 越界数值钳位到范围上限
  assert.equal(t.typography.size, 22)
  assert.equal(t.layout.maxWidth, 240)

  assert.equal(bubble.normalizeBubbleTheme({ ...validV2(), id: 'comic' })?.id, 'comic') // 内置 id 放行
  assert.equal(bubble.normalizeBubbleTheme({ ...validV2(), id: 'bad id' }), null)
  assert.equal(bubble.normalizeBubbleTheme({ ...validV2(), label: '  ' }), null)
})

test('清洗幂等:V2 进 V2 出值不变', () => {
  const t = bubble.normalizeBubbleTheme(validV2())
  assert.deepEqual(bubble.normalizeBubbleTheme(t), t)
})

test('V1 迁移:四种 shape 各自落位,12 色零丢失', () => {
  const v1 = {
    id: 'custom_old', label: '旧主题',
    bg: '#101426', text: '#e8f4ff', stroke: '#38e1ff',
    accA: '#ff5ea8', accB: '#38e1ff', accC: '#b18cff',
    bgA: '#1c1030', bgB: '#0f2233', bgC: '#1a1233',
    strokeA: '#ff5ea8', strokeB: '#38e1ff', strokeC: '#b18cff',
    bgOpacity: 0.86, strokeW: 2, blurPx: 0, fontSize: 17, maxWidth: 360, radius: 14,
    shape: 'rounded', tailStyle: 'droplet', shadow: 'soft',
    fontWeight: 700, lineHeight: 1.6, paddingX: 18, paddingY: 16,
  }
  const cases = [
    ['rounded', 'soft-chat'],
    ['pill', 'pill'],
    ['square', 'rpg'],
    ['cloud', 'cloud'],
  ]
  for (const [shape, templateId] of cases) {
    const t = bubble.normalizeBubbleThemeAny({ ...v1, shape })
    assert.equal(t.templateId, templateId, `${shape} → ${templateId}`)
    const ov = t.palette.overrides
    assert.equal(ov.surface, '#101426')
    assert.equal(ov.text, '#e8f4ff')
    assert.equal(ov.outline, '#38e1ff')
    assert.equal(ov.accA, '#ff5ea8')
    assert.equal(ov.surfaceB, '#0f2233')
    assert.equal(ov.outlineC, '#b18cff')
    assert.equal(t.material.opacity, 0.86)
    assert.equal(t.frame.outlineWidth, 2)
    assert.equal(t.typography.size, 17)
    assert.equal(t.typography.weight, 700)
    assert.equal(t.layout.maxWidth, 360)
    assert.equal(t.palette.lightness, 'dark') // 深底浅字
    assert.equal(t.palette.mode, 'per-speaker')
  }
})

test('V1 迁移:玻璃主题保透明度与模糊;blurPx=0 时回渐变;统一底色判 unified;normalize 幂等', () => {
  const base = {
    id: 'custom_g', label: '玻璃',
    bg: '#101426', text: '#e8f4ff', stroke: '#38e1ff',
    accA: '#ff5ea8', accB: '#38e1ff', accC: '#b18cff',
    bgA: '#151520', bgB: '#151520', bgC: '#151520',
    strokeA: '#ff5ea8', strokeB: '#38e1ff', strokeC: '#b18cff',
    bgOpacity: 0.8, strokeW: 1, blurPx: 14, fontSize: 16, maxWidth: 320, radius: 18,
    shape: 'rounded', tailStyle: 'sharp', shadow: 'strong',
    fontWeight: 650, lineHeight: 1.58, paddingX: 17, paddingY: 15,
  }
  const glass = bubble.normalizeBubbleThemeAny(base)
  assert.equal(glass.material.id, 'glass')
  assert.equal(glass.material.blur, 14)
  assert.equal(glass.tail.style, 'triangle')
  assert.equal(glass.palette.mode, 'unified')
  assert.deepEqual(bubble.normalizeBubbleTheme(glass), glass)

  const flat = bubble.normalizeBubbleThemeAny({ ...base, blurPx: 0 })
  assert.equal(flat.material.id, 'gradient')
  assert.equal(flat.material.blur, 0)
  assert.equal(flat.tail.style, 'triangle') // tailStyle sharp 与 blur 无关,照常映射
  assert.equal(flat.effects.shadow, 'strong')
})

test('resolve:全部目录兼容组合产出合法外观(无 undefined/NaN/坏颜色)', () => {
  const combos = []
  for (const tpl of bubble.listBubbleTemplates()) {
    for (const m of tpl.materials) combos.push([tpl.id, m])
  }
  assert.ok(combos.length >= 7)
  for (const [templateId, materialId] of combos) {
    const t = bubble.normalizeBubbleTheme({ ...validV2(), templateId, material: { id: materialId, opacity: 0.9, blur: 10 } })
    const ap = bubble.resolveBubbleAppearance(t, { speaker: 'A', placement: 'above', tailSide: 'center', emphasis: 'normal', length: 'normal' })
    assert.equal(ap.templateId, templateId)
    assert.equal(ap.materialId, materialId)
    for (const [k, v] of Object.entries(ap.cssVars)) {
      assert.equal(typeof v, 'string', `${templateId}/${materialId} 变量 ${k} 应为字符串`)
      assert.ok(v.length > 0, `${templateId}/${materialId} 变量 ${k} 不应为空`)
      assert.ok(!v.includes('NaN') && !v.includes('undefined'), `${templateId}/${materialId} 变量 ${k} 含 NaN/undefined: ${v}`)
    }
    for (const sp of ['A', 'B', 'C']) {
      assert.match(ap.speakers[sp].surface, /^rgba\(/)
      assert.match(ap.speakers[sp].accent, HEX_RE)
    }
  }
})

test('resolve:内置柔彩与旧静态变量逐色一致', () => {
  const ap = bubble.resolveBubbleAppearance(bubble.BUILT_IN_BUBBLE_THEMES.comic, {})
  assert.equal(ap.templateId, 'soft-chat')
  assert.equal(ap.materialId, 'gradient')
  assert.equal(ap.speakers.A.surface, 'rgba(255, 244, 235, 0.93)')
  assert.equal(ap.speakers.B.surface, 'rgba(237, 245, 255, 0.93)')
  assert.equal(ap.speakers.C.accent, '#8572d8')
  assert.equal(ap.text, '#26232f')
  assert.equal(ap.cssVars['--bub-font-size'], '16px')
})

test('resolve:unified 模式三角色同底;per-speaker 各自带色偏', () => {
  const unified = bubble.normalizeBubbleTheme({ ...validV2(), palette: { mode: 'unified', primary: '#e98050', lightness: 'light', speakerStrength: 80 } })
  const apU = bubble.resolveBubbleAppearance(unified, {})
  assert.equal(apU.speakers.A.surface, apU.speakers.B.surface)
  const per = bubble.resolveBubbleAppearance(bubble.normalizeBubbleTheme(validV2()), {})
  assert.notEqual(per.speakers.A.surface, per.speakers.B.surface)
})

test('resolve:reducedMotion 关入场动画', () => {
  const ap = bubble.resolveBubbleAppearance(bubble.normalizeBubbleTheme(validV2()), { reducedMotion: true })
  assert.equal(ap.cssVars['--bub-in'], 'none')
})

test('诊断与修复:深底深字可修复,修复幂等且带说明', () => {
  const bad = bubble.normalizeBubbleTheme({
    ...validV2(),
    palette: {
      mode: 'per-speaker',
      primary: '#33334d',
      lightness: 'dark',
      speakerStrength: 0,
      overrides: { surface: '#20202e', text: '#2c2c40' },
    },
  })
  const issues = bubble.diagnoseBubbleTheme(bad)
  assert.ok(issues.some((i) => i.kind === 'contrast-text'))
  const fixed = bubble.autoFixBubbleTheme(bad)
  assert.ok(fixed.fixes.length > 0)
  assert.equal(fixed.diagnostics.filter((i) => i.kind === 'contrast-text').length, 0)
  // 幂等:修完再修无新增动作
  const again = bubble.autoFixBubbleTheme(fixed.theme)
  assert.equal(again.fixes.length, 0)
  assert.deepEqual(bubble.diagnoseBubbleTheme(again.theme).filter((i) => i.kind === 'contrast-text'), [])
})

test('mutate:retarget-template 保配色、降级材质、radius 随新模板', () => {
  const base = bubble.normalizeBubbleTheme({
    ...validV2(),
    templateId: 'soft-chat',
    palette: { mode: 'per-speaker', primary: '#ff5ea8', lightness: 'light', speakerStrength: 60, overrides: { surface: '#fff0f6', text: '#40202e' } },
  })
  const clouded = bubble.mutateBubbleTheme(base, { type: 'retarget-template', templateId: 'comic-burst', preserve: ['palette'] })
  assert.equal(clouded.templateId, 'comic-burst')
  assert.equal(clouded.palette.overrides.surface, '#fff0f6', 'palette 保留')
  assert.equal(clouded.frame.radius, 6, '骨架半径随新模板默认')
  // gradient 不在漫画白名单 → 降级 solid
  const grad = bubble.normalizeBubbleTheme({ ...validV2(), material: { id: 'gradient', opacity: 0.9, blur: 0 } })
  const burst = bubble.mutateBubbleTheme(grad, { type: 'retarget-template', templateId: 'comic-burst' })
  assert.equal(burst.material.id, 'solid')
  // 未 preserve 的组回落模板默认
  assert.deepEqual(burst.effects, { shadow: 'strong', glow: 0, texture: 0 })
})

test('mutate:快捷动作语义正确', () => {
  const base = bubble.normalizeBubbleTheme(validV2())
  assert.equal(bubble.mutateBubbleTheme(base, { type: 'simpler-nameplate' }).nameplate.style, 'inline')
  assert.equal(bubble.mutateBubbleTheme(base, { type: 'softer-shadow' }).effects.shadow, 'none') // soft → none
  const playful = bubble.mutateBubbleTheme(base, { type: 'playful-font' })
  assert.equal(playful.typography.fontPreset, 'comic')
  const jitter = bubble.mutateBubbleTheme(base, { type: 'jitter-colors', amountDeg: 20, rand: () => 0.9 })
  assert.notEqual(jitter.palette.primary, base.palette.primary)
  assert.equal(jitter.templateId, base.templateId)
  const reset = bubble.mutateBubbleTheme(
    bubble.normalizeBubbleTheme({ ...validV2(), tail: { style: 'none', size: 24 }, effects: { shadow: 'none', glow: 30, texture: 40 } }),
    { type: 'reset-to-template-defaults' },
  )
  assert.equal(reset.tail.style, 'droplet')
  assert.equal(reset.effects.shadow, 'soft')
})

test('mutate:set-material 越界降级为模板默认材质', () => {
  const sticker = bubble.normalizeBubbleTheme({ ...validV2(), templateId: 'sticker' })
  const bad = bubble.mutateBubbleTheme(sticker, { type: 'set-material', materialId: 'neon' })
  assert.equal(bad.material.id, 'paper')
})

test('根兼容变量:注入 --bubble-acc-* 且 null 清理不残留', () => {
  const store = new Map()
  const root = {
    style: {
      setProperty: (k, v) => store.set(k, v),
      removeProperty: (k) => store.delete(k),
    },
  }
  bubble.syncBubbleCompatVars(root, bubble.BUILT_IN_BUBBLE_THEMES.comic)
  assert.equal(store.get('--bubble-acc-a'), '#e98050')
  assert.equal(store.get('--bubble-acc-c'), '#8572d8')
  bubble.syncBubbleCompatVars(root, null)
  assert.equal(store.size, 0)
})

test('compileIntent:意图编译出合法主题,坏材质降级', () => {
  const { theme } = bubble.compileIntent({
    slot: 'faithful', label: '樱花粉', templateId: 'comic-burst', materialId: 'glass',
    mood: 'cute', lightness: 'light', primaryColor: '#ff9db8', typographyPreset: 'comic', nameplateStyle: 'badge',
  })
  assert.equal(theme.material.id, 'solid') // glass 不兼容漫画 → solid
  assert.equal(theme.palette.primary, '#ff9db8')
  assert.ok(bubble.normalizeBubbleTheme(theme))
})

test('AI 候选:三槽位归位;坏输出按槽位补位,不整体失败', async () => {
  const good = JSON.stringify([
    { slot: 'faithful', label: '樱花粉', templateId: 'soft-chat', materialId: 'gradient', mood: 'cute', lightness: 'light', primaryColor: '#ff9db8', typographyPreset: 'friendly', nameplateStyle: 'badge' },
    { slot: 'expressive', label: '爆裂霓虹', templateId: 'comic-burst', materialId: 'neon', mood: 'dramatic', lightness: 'dark', primaryColor: '#8f7ff0', typographyPreset: 'comic', nameplateStyle: 'badge' },
    { slot: 'restrained', label: '素笺', templateId: 'caption', materialId: 'glass', mood: 'minimal', lightness: 'light', primaryColor: '#7f8fa6', typographyPreset: 'clean', nameplateStyle: 'inline' },
  ])
  const candidates = await generateBubbleCandidates('樱花粉手账风', { complete: async () => good })
  assert.equal(candidates.length, 3)
  assert.deepEqual(candidates.map((c) => c.slot), ['faithful', 'expressive', 'restrained'])
  assert.equal(candidates[0].theme.palette.primary, '#ff9db8')
  assert.ok(candidates.every((c) => c.theme.id.startsWith('custom_')))

  const garbage = await generateBubbleCandidates('随便', { complete: async () => '这不是 JSON' })
  assert.equal(garbage.length, 3)
  assert.deepEqual(garbage.map((c) => c.slot), ['faithful', 'expressive', 'restrained'])
  assert.ok(garbage.every((c) => bubble.normalizeBubbleTheme(c.theme)))

  // 两好一坏:有效的保留,坏的补位
  const partial = JSON.stringify([
    { slot: 'faithful', label: '好方案', templateId: 'cloud', materialId: 'gradient', mood: 'cute', lightness: 'light', primaryColor: '#9fd8ff', typographyPreset: 'friendly', nameplateStyle: 'badge' },
    { slot: 'expressive', label: '', templateId: 'nope', materialId: 'neon', mood: 'dramatic', lightness: 'dark', primaryColor: '#000000', typographyPreset: 'comic', nameplateStyle: 'badge' },
  ])
  const mixed = await generateBubbleCandidates('云朵', { complete: async () => partial })
  assert.equal(mixed[0].theme.label, '好方案')
  assert.equal(mixed[0].theme.templateId, 'cloud')
  assert.equal(mixed[1].slot, 'expressive')
  assert.ok(bubble.normalizeBubbleTheme(mixed[1].theme))

  await assert.rejects(
    generateBubbleCandidates('   ', { complete: async () => good }),
    /描述/,
  )
  await assert.rejects(
    generateBubbleCandidates('霓虹', { complete: async () => { throw new Error('boom') } }),
    /AI 调用失败/,
  )
})
