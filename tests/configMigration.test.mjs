// 配置平滑迁移回归:老配置没有 characters.C / persona.c / names.c 时自动补默认值,
// A/B 原值一字不动;非法值钳位回落。读清洗经 sanitizeCharacters(导出供测试)。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let configStore

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  configStore = await server.ssrLoadModule('/src/storage/configStore.ts')
})

after(async () => {
  await server?.close()
})

test('老配置缺少 C 时补默认值,A/B 原值不动', () => {
  const legacy = {
    height: 280,
    A: { xPct: 15, bottom: 40 },
    B: { xPct: 85, bottom: 0 },
  }
  const next = configStore.sanitizeCharacters(legacy)
  assert.deepEqual(next.A, { xPct: 15, bottom: 40 })
  assert.deepEqual(next.B, { xPct: 85, bottom: 0 })
  assert.equal(next.height, 280)
  assert.deepEqual(next.C, { xPct: 50, bottom: 0, width: 462, enabled: true })
})

test('已有 C 配置原样保留(用户拖过的位置不丢)', () => {
  const next = configStore.sanitizeCharacters({
    height: 320,
    A: { xPct: 20, bottom: 0 },
    B: { xPct: 80, bottom: 0 },
    C: { xPct: 66, bottom: 120, width: 520, enabled: false },
  })
  assert.deepEqual(next.C, { xPct: 66, bottom: 120, width: 520, enabled: false })
})

test('C 的非法值钳位:宽度限 160~1200,enabled 缺省视为开', () => {
  const next = configStore.sanitizeCharacters({
    A: {},
    B: {},
    C: { xPct: 999, bottom: -50, width: 99999, enabled: true },
  })
  assert.equal(next.C.xPct, 97)
  assert.equal(next.C.bottom, 0)
  assert.equal(next.C.width, 1200)
  assert.equal(next.C.enabled, true)
  const missingEnabled = configStore.sanitizeCharacters({
    A: {},
    B: {},
    C: { xPct: 50, bottom: 0, width: 462 },
  })
  assert.equal(missingEnabled.C.enabled, true)
})

test('完全空的配置对象整体落默认', () => {
  const next = configStore.sanitizeCharacters(undefined)
  assert.deepEqual(next, configStore.DEFAULT_CONFIG.characters)
})

// 群聊设置(聊天记录页):老配置缺字段回默认,群名截断,bg 只认布尔
test('群聊设置:老配置缺字段整体落默认', () => {
  const next = configStore.sanitizeGroupChat(undefined)
  assert.deepEqual(next, { name: '我们的群', bg: false })
})

test('群聊设置:已有群名保留,非法回落;bg 只认布尔', () => {
  assert.deepEqual(configStore.sanitizeGroupChat({ name: '快乐老家', bg: true }), {
    name: '快乐老家',
    bg: true,
  })
  assert.equal(configStore.sanitizeGroupChat({ name: '   ' }).name, '我们的群')
  assert.equal(configStore.sanitizeGroupChat({ name: 42 }).bg, false)
  const long = configStore.sanitizeGroupChat({ name: '群'.repeat(50), bg: 'yes' })
  assert.equal(long.name.length, 20)
  assert.equal(long.bg, false)
})
