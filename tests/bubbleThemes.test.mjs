// 气泡工坊回归:存储层 V2 化(旧 V1 主题读取时迁移、颜色零丢失)、投影往返、
// bubbleStyle 选择器放宽。沿用仓库测试原则:不碰网络与磁盘(localStorage 用内存桩)。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let sanitizeBubbleTheme
let sanitizeBubbleThemes
let saveBubbleTheme
let removeBubbleTheme
let getBubbleThemesSnapshot
let getBubbleThemesV2Snapshot
let getConfig
let DEFAULT_CONFIG

before(async () => {
  const values = new Map()
  globalThis.localStorage = {
    getItem: (k) => (values.has(k) ? values.get(k) : null),
    setItem: (k, v) => values.set(k, String(v)),
    removeItem: (k) => values.delete(k),
    clear: () => values.clear(),
  }
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  ;({ sanitizeBubbleTheme, sanitizeBubbleThemes, saveBubbleTheme, removeBubbleTheme, getBubbleThemesSnapshot, getBubbleThemesV2Snapshot } =
    await server.ssrLoadModule('/src/storage/bubbleThemesStore.ts'))
  ;({ getConfig, DEFAULT_CONFIG } = await server.ssrLoadModule('/src/storage/configStore.ts'))
})

after(async () => {
  await server?.close()
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

test('存储:V1 主题存入后内部为 V2,投影视图保留全部颜色与数值', async () => {
  await saveBubbleTheme(validV1)
  const v2List = getBubbleThemesV2Snapshot()
  const legacy = getBubbleThemesSnapshot()
  assert.equal(v2List.length, 1)
  assert.equal(legacy.length, 1)
  const v2 = v2List[0]
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
  // 投影视图逐字段可读
  const view = legacy[0]
  assert.equal(view.bg, '#101426')
  assert.equal(view.strokeW, 2)
  assert.equal(view.fontSize, 17)
  assert.equal(view.shape, 'rounded')
  assert.equal(view.tailStyle, 'droplet')
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
  const back = getBubbleThemesV2Snapshot().find((t) => t.id === 'custom_direct')
  assert.deepEqual(back, v2)
  // upsert 覆盖
  await saveBubbleTheme({ ...v2, label: '改名' })
  assert.equal(getBubbleThemesV2Snapshot().find((t) => t.id === 'custom_direct').label, '改名')
  await removeBubbleTheme('custom_direct')
  assert.ok(!getBubbleThemesV2Snapshot().some((t) => t.id === 'custom_direct'))
})

test('清洗:V1/V2 混合列表读取、坏条目跳过、去重限量', () => {
  const mixed = [
    validV1,
    { ...validV1, id: 'custom_neon' }, // 重复 id
    { id: 'bad', label: '坏数据' },
    {
      version: 2, id: 'custom_ok', label: '好的', templateId: 'rpg',
      material: { id: 'glass', opacity: 0.8, blur: 12 },
      palette: { mode: 'unified', primary: '#888888', lightness: 'dark', speakerStrength: 50 },
    },
  ]
  const list = sanitizeBubbleThemes(mixed)
  assert.deepEqual(list.map((t) => t.id), ['custom_neon', 'custom_ok'])
})

test('清洗:坏 id/label 拒收;坏颜色落安全默认', () => {
  assert.equal(sanitizeBubbleTheme({ ...validV1, id: 'comic' }), null)
  assert.equal(sanitizeBubbleTheme({ ...validV1, id: 'NEON' }), null)
  assert.equal(sanitizeBubbleTheme({ ...validV1, label: '' }), null)
  const t = sanitizeBubbleTheme({ ...validV1, bg: 'not-a-color' })
  assert.ok(t)
  assert.equal(t.bg, '#faf7f2')
})

test('bubbleStyle 选择器:custom_ id 放行,默认柔彩', async () => {
  assert.equal(DEFAULT_CONFIG.bubbleStyle, 'comic')
  const { saveConfig } = await server.ssrLoadModule('/src/storage/configStore.ts')
  const saved = await saveConfig({ bubbleStyle: 'custom_neon' })
  assert.equal(saved.bubbleStyle, 'custom_neon')
  assert.equal((await getConfig()).bubbleStyle, 'custom_neon')
})
