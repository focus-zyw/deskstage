// 气泡工坊回归:存储层 V2 化(旧 V1 主题读取时迁移、颜色零丢失)、内置 id 禁入自定义存储、
// bubbleStyle 选择器放宽。沿用仓库测试原则:不碰网络与磁盘(localStorage 用内存桩)。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

let saveBubbleTheme
let removeBubbleTheme
let getBubbleThemesV2Snapshot
let getConfig
let DEFAULT_CONFIG
let BUILT_IN_BUBBLE_THEMES

before(async () => {
  const values = new Map()
  globalThis.localStorage = {
    getItem: (k) => (values.has(k) ? values.get(k) : null),
    setItem: (k, v) => values.set(k, String(v)),
    removeItem: (k) => values.delete(k),
    clear: () => values.clear(),
  }
  ;({ saveBubbleTheme, removeBubbleTheme, getBubbleThemesV2Snapshot } =
    await import('../src/storage/bubbleThemesStore.ts'))
  ;({ getConfig, DEFAULT_CONFIG } = await import('../src/storage/configStore.ts'))
  ;({ BUILT_IN_BUBBLE_THEMES } = await import('../src/bubble/index.ts'))
})

after(async () => {
  delete globalThis.localStorage
})

const validV1 = {
  id: 'custom_neon',
  label: '霓虹',
  bg: '#101426', text: '#e8f4ff', stroke: '#38e1ff',
  accA: '#ff5ea8', accB: '#38e1ff', accC: '#b18cff',
  bgA: '#1c1030', bgB: '#0f2233', bgC: '#1a1233',
  strokeA: '#ff5ea8', strokeB: '#38e1ff', strokeC: '#b18cff',
  bgOpacity: 0.86, strokeW: 2, blurPx: 14, fontSize: 17, maxWidth: 360, radius: 14,
  shape: 'rounded', tailStyle: 'droplet', shadow: 'soft',
  fontWeight: 700, lineHeight: 1.6, paddingX: 18, paddingY: 16,
}

test('存储:V1 主题存入后内部为 V2,颜色与数值零丢失', async () => {
  await saveBubbleTheme(validV1)
  const v2 = getBubbleThemesV2Snapshot()[0]
  assert.equal(v2.version, 2)
  assert.equal(v2.material.opacity, 0.86)
  assert.equal(v2.material.blur, 14)
  assert.equal(v2.material.id, 'glass') // blurPx>0 迁移为玻璃
  assert.equal(v2.frame.outlineWidth, 2)
  assert.equal(v2.typography.size, 17)
  const ov = v2.palette.overrides
  assert.equal(ov.surface, '#101426')
  assert.equal(ov.text, '#e8f4ff')
  assert.equal(ov.surfaceB, '#0f2233')
  assert.equal(ov.accC, '#b18cff')
})

test('存储:V2 主题直存,save→read 往返不改字段', async () => {
  const v2 = {
    version: 2,
    id: 'custom_direct',
    label: '直存',
    templateId: 'cloud',
    material: { id: 'gradient', opacity: 0.9, blur: 0 },
    palette: { mode: 'per-speaker', primary: '#9fd8ff', lightness: 'light', speakerStrength: 70 },
    frame: { radius: 24, outlineWidth: 1.5 },
    typography: { fontPreset: 'comic', size: 15, weight: 600, lineHeight: 1.5, align: 'center' },
    nameplate: { style: 'tab', position: 'top-left' },
    tail: { style: 'bubbles', size: 12 },
    layout: { maxWidth: 340, paddingX: 20, paddingY: 16 },
    effects: { shadow: 'strong', glow: 30, texture: 0 },
  }
  await saveBubbleTheme(v2)
  assert.deepEqual(getBubbleThemesV2Snapshot().find((t) => t.id === 'custom_direct'), v2)
  await saveBubbleTheme({ ...v2, label: '改名' })
  assert.equal(getBubbleThemesV2Snapshot().find((t) => t.id === 'custom_direct').label, '改名')
  await removeBubbleTheme('custom_direct')
  assert.ok(!getBubbleThemesV2Snapshot().some((t) => t.id === 'custom_direct'))
})

test('存储:内置主题禁止存成自定义(绕过检查的 V2 输入同样拒收)', async () => {
  await assert.rejects(
    saveBubbleTheme(BUILT_IN_BUBBLE_THEMES.comic),
    /custom_ 前缀/,
  )
  await assert.rejects(
    saveBubbleTheme({ ...BUILT_IN_BUBBLE_THEMES.glass, id: 'glass' }),
    /custom_ 前缀/,
  )
  assert.ok(!getBubbleThemesV2Snapshot().some((t) => t.id === 'comic' || t.id === 'glass'))
})

test('bubbleStyle 选择器:custom_ id 放行,默认柔彩', async () => {
  assert.equal(DEFAULT_CONFIG.bubbleStyle, 'comic')
  const { saveConfig } = await import('../src/storage/configStore.ts')
  const saved = await saveConfig({ bubbleStyle: 'custom_neon' })
  assert.equal(saved.bubbleStyle, 'custom_neon')
  assert.equal((await getConfig()).bubbleStyle, 'custom_neon')
})
