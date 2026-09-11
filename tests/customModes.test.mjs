// 自定义模式(模式工坊)回归:校验清洗、存储合并、自然语言路由、AI 生成解析。
// 沿用仓库测试原则:依赖注入、不碰网络与磁盘(localStorage 用内存桩)。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let sanitizeCustomMode
let sanitizeCustomModes
let ensureCustomModesLoaded
let saveCustomMode
let removeCustomMode
let getCustomModesSnapshot
let MODES
let allModes
let modeOf
let nlRoute
let generateCustomMode

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  ;({ sanitizeCustomMode, sanitizeCustomModes, ensureCustomModesLoaded, saveCustomMode, removeCustomMode, getCustomModesSnapshot } =
    await server.ssrLoadModule('/src/storage/customModesStore.ts'))
  ;({ MODES, allModes, modeOf } = await server.ssrLoadModule('/src/performer/modes/index.ts'))
  ;({ nlRoute } = await server.ssrLoadModule('/src/features/commands/commands.ts'))
  ;({ generateCustomMode } = await server.ssrLoadModule('/src/engine/modeGenerator.ts'))
})

after(async () => {
  await server?.close()
})

const validMode = {
  id: 'custom_debate',
  label: '辩论',
  accent: '#4aa3f0',
  gap: 260,
  prompt: '正反方互怼',
  script: [
    { speaker: 'A', text: '我方认为熬夜是自由。', action: 'talk' },
    { speaker: 'B', text: '自由到中午吗?', action: 'surprise' },
  ],
  triggers: ['辩论'],
}

test('校验:合法模式原样通过', () => {
  const mode = sanitizeCustomMode(validMode)
  assert.ok(mode)
  assert.equal(mode.id, 'custom_debate')
  assert.equal(mode.label, '辩论')
  assert.equal(mode.gap, 260)
  assert.deepEqual(mode.triggers, ['辩论'])
})

test('校验:id 必须 custom_ 前缀(永与内置模式不撞键)', () => {
  assert.equal(sanitizeCustomMode({ ...validMode, id: 'debate' }), null)
  assert.equal(sanitizeCustomMode({ ...validMode, id: 'daily' }), null)
  assert.equal(sanitizeCustomMode({ ...validMode, id: 'CUSTOM_X' }), null)
})

test('校验:缺关键字段拒收', () => {
  assert.equal(sanitizeCustomMode({ ...validMode, label: '' }), null)
  assert.equal(sanitizeCustomMode({ ...validMode, prompt: '' }), null)
  assert.equal(sanitizeCustomMode({ ...validMode, script: [] }), null)
  assert.equal(sanitizeCustomMode({ ...validMode, script: [{ speaker: 'A', text: '只有一句', action: 'talk' }] }), null)
  assert.equal(sanitizeCustomMode(null), null)
})

test('校验:非法值钳位而非拒收(gap/动作/兴趣概率)', () => {
  const mode = sanitizeCustomMode({
    ...validMode,
    gap: 99999,
    interestTopicChance: 5,
    script: [
      { speaker: 'A', text: '第一句', action: 'dance' },
      { speaker: 'B', text: '第二句', action: 'talk', listenerAction: 'fly' },
    ],
  })
  assert.ok(mode)
  assert.equal(mode.gap, 2000)
  assert.equal(mode.interestTopicChance, 1)
  assert.equal(mode.script[0].action, 'talk') // 非法动作归一为 talk
  assert.equal(mode.script[1].listenerAction, undefined) // 非法听者动作丢弃
})

test('清洗整份存储:去重、限量、坏条目跳过', () => {
  const list = sanitizeCustomModes({
    modes: [validMode, validMode, { id: 'bad' }, { ...validMode, id: 'custom_second' }],
  })
  assert.equal(list.length, 2)
  assert.equal(list[0].id, 'custom_debate')
  assert.equal(list[1].id, 'custom_second')
})

test('存储合并:自定义模式进 allModes/modeOf,未知 id 仍回退日常', async () => {
  // 内存 localStorage 桩,先种入一份已保存的自定义模式
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
  values.set('vc-custom-modes', JSON.stringify({ version: 1, modes: [validMode] }))
  await ensureCustomModesLoaded()

  assert.equal(getCustomModesSnapshot().length, 1)
  assert.equal(modeOf('custom_debate').label, '辩论')
  assert.equal(modeOf('no-such-mode').id, 'daily') // 未知 id 回退内置
  const ids = allModes().map((m) => m.id)
  assert.ok(ids.includes('custom_debate'))
  assert.ok(ids.includes('daily'))
  assert.deepEqual(ids.slice(0, 3), ['daily', 'crosstalk', 'live']) // 内置顺序在前

  // upsert + 删除
  await saveCustomMode({ ...validMode, label: '抬杠', gap: 300 })
  assert.equal(modeOf('custom_debate').label, '抬杠')
  await removeCustomMode('custom_debate')
  assert.equal(getCustomModesSnapshot().length, 0)
  assert.equal(modeOf('custom_debate').id, 'daily')
  delete globalThis.localStorage
})

test('自然语言路由:触发词来自模式数据,"来一段关于X的辩论"命中自定义模式', async () => {
  // store 在上一个测试已加载过(loaded 标志),这里走公共 API 写入并发布
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
  await saveCustomMode(validMode)

  const route = await nlRoute('来一段关于加班的辩论', [])
  assert.equal(route.kind, 'perform')
  assert.equal(route.mode, 'custom_debate')
  assert.equal(route.topic, '加班')

  // 内置触发词不回归:日常/闲聊→daily,段子→crosstalk,开播→live
  const daily = await nlRoute('来一段日常', [])
  assert.equal(daily.mode, 'daily')
  const crosstalk = await nlRoute('来一段关于加班的段子', [])
  assert.equal(crosstalk.mode, 'crosstalk')
  const live = await nlRoute('开播', [])
  assert.equal(live.mode, 'live')
  delete globalThis.localStorage
})

test('AI 生成:合法输出被清洗采纳;失败与坏格式抛错', async () => {
  const good = await generateCustomMode('要一个辩论模式', {
    complete: async () => JSON.stringify(validMode),
  })
  assert.equal(good.id, 'custom_debate')

  await assert.rejects(
    () => generateCustomMode('要一个辩论模式', { complete: async () => '不是JSON' }),
    /JSON/,
  )
  await assert.rejects(
    () => generateCustomMode('要一个辩论模式', { complete: async () => JSON.stringify({ id: 'bad' }) }),
    /关键字段/,
  )
  await assert.rejects(
    () => generateCustomMode('要一个辩论模式', { complete: async () => { throw new Error('超时') } }),
    /AI 调用失败/,
  )
  await assert.rejects(() => generateCustomMode('   ', { complete: async () => '{}' }), /描述/)
})

test('内置模式自带触发词(数据驱动路由的前提)', () => {
  assert.deepEqual(MODES.daily.triggers, ['日常', '闲聊'])
  assert.deepEqual(MODES.crosstalk.triggers, ['相声', '段子'])
})
