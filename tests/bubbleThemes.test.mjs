// 气泡工坊回归:主题校验清洗、存储合并、bubbleStyle 选择器放宽、AI 生成解析。
// 沿用仓库测试原则:不碰网络与磁盘(localStorage 用内存桩)。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let sanitizeBubbleTheme
let sanitizeBubbleThemes
let ensureBubbleThemesLoaded
let saveBubbleTheme
let removeBubbleTheme
let getBubbleThemesSnapshot
let applyBubbleThemeTo
let getConfig
let DEFAULT_CONFIG
let generateBubbleTheme

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  ;({ sanitizeBubbleTheme, sanitizeBubbleThemes, ensureBubbleThemesLoaded, saveBubbleTheme, removeBubbleTheme, getBubbleThemesSnapshot, applyBubbleThemeTo } =
    await server.ssrLoadModule('/src/storage/bubbleThemesStore.ts'))
  ;({ getConfig, DEFAULT_CONFIG } = await server.ssrLoadModule('/src/storage/configStore.ts'))
  ;({ generateBubbleTheme } = await server.ssrLoadModule('/src/engine/bubbleThemeGenerator.ts'))
})

after(async () => {
  await server?.close()
})

const validTheme = {
  id: 'custom_neon',
  label: '霓虹',
  bg: '#101426', text: '#e8f4ff', stroke: '#38e1ff',
  accA: '#ff5ea8', accB: '#38e1ff', accC: '#b18cff',
  bgA: '#1c1030', bgB: '#0f2233', bgC: '#1a1233',
  strokeA: '#ff5ea8', strokeB: '#38e1ff', strokeC: '#b18cff',
  bgOpacity: 0.86, strokeW: 2, blurPx: 14, fontSize: 17, maxWidth: 360, radius: 14,
}

test('校验:合法主题原样通过', () => {
  const t = sanitizeBubbleTheme(validTheme)
  assert.ok(t)
  assert.equal(t.id, 'custom_neon')
  assert.equal(t.label, '霓虹')
  assert.equal(t.blurPx, 14)
  assert.equal(t.shape, 'rounded', '旧主题自动补齐新增外观选项')
  assert.equal(t.tailStyle, 'droplet')
  assert.equal(t.shadow, 'soft')
  assert.equal(t.fontWeight, 650)
  assert.equal(t.lineHeight, 1.58)
  assert.equal(t.paddingX, 17)
  assert.equal(t.paddingY, 15)
})

test('校验:id 必须 custom_ 前缀永与内置不撞键;label 缺失拒收;颜色坏值落安全默认', () => {
  assert.equal(sanitizeBubbleTheme({ ...validTheme, id: 'comic' }), null)
  assert.equal(sanitizeBubbleTheme({ ...validTheme, id: 'NEON' }), null)
  assert.equal(sanitizeBubbleTheme({ ...validTheme, label: '' }), null)
  // 颜色字段坏值不整体拒收:落默认值(有安全兜底),label/id 缺失才拒收
  const fallback = sanitizeBubbleTheme({ ...validTheme, bg: 'not-a-color' })
  assert.equal(fallback.bg, '#faf7f2')
})

test('校验:数值钳位(字号/宽度/圆角/透明度/模糊)', () => {
  const t = sanitizeBubbleTheme({
    ...validTheme,
    shape: 'triangle', tailStyle: 'laser', shadow: 'huge',
    fontSize: 99, maxWidth: 10, radius: 0, bgOpacity: 5, blurPx: -3,
    fontWeight: 999, lineHeight: 9, paddingX: 2, paddingY: 99,
  })
  assert.equal(t.fontSize, 22)
  assert.equal(t.maxWidth, 240)
  assert.equal(t.radius, 6)
  assert.equal(t.bgOpacity, 1)
  assert.equal(t.blurPx, 0)
  assert.equal(t.shape, 'rounded')
  assert.equal(t.tailStyle, 'droplet')
  assert.equal(t.shadow, 'soft')
  assert.equal(t.fontWeight, 800)
  assert.equal(t.lineHeight, 1.9)
  assert.equal(t.paddingX, 10)
  assert.equal(t.paddingY, 28)
})

test('清洗整份存储:去重、限量、坏条目跳过', () => {
  const list = sanitizeBubbleThemes({ themes: [validTheme, validTheme, { id: 'bad' }, { ...validTheme, id: 'custom_two', label: '第二' }] })
  assert.equal(list.length, 2)
  assert.equal(list[1].label, '第二')
})

test('存储合并:upsert + 删除 + 订阅快照', async () => {
  const values = new Map()
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size
    },
  }
  await ensureBubbleThemesLoaded()
  assert.equal(getBubbleThemesSnapshot().length, 0)

  await saveBubbleTheme(validTheme)
  assert.equal(getBubbleThemesSnapshot().length, 1)
  await saveBubbleTheme({ ...validTheme, label: '霓虹改' })
  assert.equal(getBubbleThemesSnapshot()[0].label, '霓虹改')

  await removeBubbleTheme('custom_neon')
  assert.equal(getBubbleThemesSnapshot().length, 0)
  delete globalThis.localStorage
})

test('applyBubbleThemeTo:注入变量与 rgba 合成;null 清理全部', () => {
  const store = new Map()
  const fakeRoot = {
    style: {
      setProperty: (k, v) => store.set(k, v),
      removeProperty: (k) => store.delete(k),
    },
  }
  applyBubbleThemeTo(fakeRoot, validTheme)
  assert.equal(store.get('--bubble-bg'), 'rgba(16, 20, 38, 0.86)')
  assert.equal(store.get('--bubble-acc-a'), '#ff5ea8')
  assert.equal(store.get('--bubble-blur'), 'blur(14px)')
  assert.equal(store.get('--bubble-font-size'), '17px')
  assert.equal(store.get('--bubble-radius'), '14px')
  assert.equal(store.get('--bubble-border-radius'), '14px 14px 14px 9px')
  assert.equal(store.get('--bubble-tail-display'), 'block')
  assert.equal(store.get('--bubble-tail-radius'), '4px 3px 12px 3px')
  assert.equal(store.get('--bubble-shadow'), '0 10px 28px var(--bubble-shadow-color)')
  assert.equal(store.get('--bubble-font-weight'), '650')
  assert.equal(store.get('--bubble-line-height'), '1.58')
  assert.equal(store.get('--bubble-padding'), '15px 17px')

  applyBubbleThemeTo(fakeRoot, null)
  assert.equal(store.size, 0, '切回内置主题必须清掉全部 inline 变量')

  const noBlur = { ...validTheme, blurPx: 0 }
  applyBubbleThemeTo(fakeRoot, noBlur)
  assert.equal(store.get('--bubble-blur'), 'none')
  applyBubbleThemeTo(fakeRoot, null)
})

test('外观预设:轮廓、尾巴和阴影映射为可直接消费的 CSS 变量', () => {
  const store = new Map()
  const fakeRoot = {
    style: {
      setProperty: (k, v) => store.set(k, v),
      removeProperty: (k) => store.delete(k),
    },
  }
  applyBubbleThemeTo(fakeRoot, {
    ...validTheme,
    shape: 'cloud', tailStyle: 'none', shadow: 'strong',
    fontWeight: 720, lineHeight: 1.7, paddingX: 22, paddingY: 18,
  })
  assert.equal(store.get('--bubble-border-radius'), '48% 52% 46% 54% / 42% 46% 54% 58%')
  assert.equal(store.get('--bubble-tail-display'), 'none')
  assert.equal(store.get('--bubble-shadow'), '0 14px 38px var(--bubble-shadow-color), 0 3px 10px color-mix(in srgb, var(--bubble-edge) 24%, transparent)')
  assert.equal(store.get('--bubble-font-weight'), '720')
  assert.equal(store.get('--bubble-line-height'), '1.7')
  assert.equal(store.get('--bubble-padding'), '18px 22px')
})

test('bubbleStyle 选择器:custom_ id 放行(getConfig 有会话级缓存,只做一次读取断言)', async () => {
  assert.equal(DEFAULT_CONFIG.bubbleStyle, 'comic')
  const values = new Map()
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size
    },
  }
  values.set('vc-config', JSON.stringify({ bubbleStyle: 'custom_neon' }))
  assert.equal((await getConfig()).bubbleStyle, 'custom_neon')
  // 坏值回 comic 由 App 侧兜底:选中的主题不存在(含格式坏值)时 applyBubbleThemeTo(root,null)+dataset=comic
  delete globalThis.localStorage
})

test('AI 生成:合法输出清洗采纳(去 id);失败与坏格式抛错', async () => {
  const good = await generateBubbleTheme('赛博朋克', { complete: async () => JSON.stringify(validTheme) })
  assert.equal(good.label, '霓虹')
  assert.equal('id' in good, false, '生成结果不带 id,由调用方补')

  await assert.rejects(() => generateBubbleTheme('赛博朋克', { complete: async () => '不是JSON' }), /JSON/)
  await assert.rejects(() => generateBubbleTheme('赛博朋克', { complete: async () => JSON.stringify({ bg: '#101426' }) }), /关键字段/, 'label 缺失拒收(颜色缺失落默认不算)')
  await assert.rejects(() => generateBubbleTheme('赛博朋克', { complete: async () => { throw new Error('超时') } }), /AI 调用失败/)
  await assert.rejects(() => generateBubbleTheme('   ', { complete: async () => '{}' }), /描述/)
})
