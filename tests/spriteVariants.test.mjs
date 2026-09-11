import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let SpriteVariantPicker
let firstDelayedVariantGroup
let immediateSpriteVariants
let SPRITE_SETS

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  ;({ SpriteVariantPicker, firstDelayedVariantGroup, immediateSpriteVariants } =
    await server.ssrLoadModule('/src/stage/spriteVariants.ts'))
  ;({ SPRITE_SETS } = await server.ssrLoadModule('/src/stage/spriteSets.ts'))
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

test('延迟待机变体不会进入动作时立即出现', () => {
  const variants = [
    { file: 'idle.png', weight: 1 },
    { file: 'idle-look.png', weight: 1, activationDelayMs: 6_500 },
    { file: 'idle-proud.png', weight: 1, activationDelayMs: 6_500 },
  ]

  assert.deepEqual(immediateSpriteVariants(variants).map((variant) => variant.file), ['idle.png'])
  assert.deepEqual(firstDelayedVariantGroup(variants), {
    delayMs: 6_500,
    variants: variants.slice(1),
  })
})

test('两名角色注册的所有变体都有对应素材文件', () => {
  const expected = {
    A: [
      'idle-look.png',
      'idle-proud.png',
      'idle-bag.png',
      'idle-hair.png',
      'idle-stretch.png',
      'talk-point.png',
      'talk-boast.png',
      'happy-proud.png',
      'angry-pout.png',
      'surprise-flustered.png',
      'laugh-belly.png',
      'laugh-clap.png',
      'laugh-cheer.png',
    ],
    B: [
      'idle-phone.png',
      'idle-glasses.png',
      'idle-headphones.png',
      'idle-pocket.png',
      'idle-yawn.png',
      'talk-explain.png',
      'talk-deadpan.png',
      'happy-smirk.png',
      'angry-glare.png',
      'surprise-freeze.png',
      'laugh-hold.png',
      'laugh-break.png',
      'laugh-wave.png',
    ],
  }

  for (const [speaker, expectedFiles] of Object.entries(expected)) {
    const set = SPRITE_SETS[speaker]
    const registered = Object.values(set.variants).flat().map((variant) => variant.file)
    for (const file of expectedFiles) {
      assert.ok(registered.includes(file), `${speaker} 未注册 ${file}`)
      assert.ok(existsSync(path.join(process.cwd(), 'public', set.dir, file)), `${file} 不存在`)
    }
  }
})

test('待机姿势统一使用延迟、停留时长和 dip 切图', () => {
  for (const set of Object.values(SPRITE_SETS)) {
    const specials = set.variants.idle.filter((variant) => variant.file !== 'idle.png')
    assert.ok(specials.length >= 5)
    for (const variant of specials) {
      assert.equal(variant.activationDelayMs, 8_000, `${variant.file} 的首次延迟不一致`)
      assert.ok(
        variant.holdMs >= 6_000 && variant.holdMs <= 10_000,
        `${variant.file} 的停留时长超出范围`,
      )
      assert.equal(variant.transitionMode, 'dip', `${variant.file} 应使用 dip 切图`)
    }
  }
})
