import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let SpriteVariantPicker

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  ;({ SpriteVariantPicker } = await server.ssrLoadModule('/src/stage/spriteVariants.ts'))
})

after(async () => {
  await server?.close()
})

test('没有变体时保持基础动作图片', () => {
  const picker = new SpriteVariantPicker()
  assert.equal(picker.pick('talk', 'talk.png', undefined, 100, () => 0.9), 'talk.png')
})

test('按权重区间选择候选图片', () => {
  const variants = [
    { file: 'talk.png', weight: 4 },
    { file: 'talk-point.png', weight: 1 },
  ]
  assert.equal(new SpriteVariantPicker().pick('talk', 'talk.png', variants, 100, () => 0.1), 'talk.png')
  assert.equal(
    new SpriteVariantPicker().pick('talk', 'talk.png', variants, 100, () => 0.9),
    'talk-point.png',
  )
})

test('非基础变体不会连续播放，并遵守冷却时间', () => {
  const picker = new SpriteVariantPicker()
  const variants = [
    { file: 'talk.png', weight: 1 },
    { file: 'talk-point.png', weight: 10, cooldownMs: 1_000 },
  ]

  assert.equal(picker.pick('talk', 'talk.png', variants, 100, () => 0.99), 'talk-point.png')
  assert.equal(picker.pick('talk', 'talk.png', variants, 200, () => 0.99), 'talk.png')
  assert.equal(picker.pick('talk', 'talk.png', variants, 1_100, () => 0.99), 'talk-point.png')
})

test('所有候选都在冷却时安全回退基础图片', () => {
  const picker = new SpriteVariantPicker()
  const variants = [{ file: 'talk-special.png', cooldownMs: 1_000 }]

  assert.equal(picker.pick('talk', 'talk.png', variants, 100, () => 0), 'talk-special.png')
  assert.equal(picker.pick('talk', 'talk.png', variants, 200, () => 0), 'talk.png')
})
