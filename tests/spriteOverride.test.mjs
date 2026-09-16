// 角色工坊立绘覆盖回归:store 增删查(localStorage 桩)/前缀与大小校验/文件白名单/
// 双槽隔离/清除还原;spriteFileSrc 覆盖命中返回 data URL、清除后回落静态路径;
// 订阅版本 bump 驱动渲染层重绘。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let store
let spriteSets

const PNG = (n = 10) => `data:image/png;base64,${'A'.repeat(n)}`
const BAD = 'data:image/jpeg;base64,xxx' // jpeg 不收(立绘需透明)

before(async () => {
  const backing = new Map()
  globalThis.localStorage = {
    getItem: (k) => backing.get(k) ?? null,
    setItem: (k, v) => void backing.set(k, String(v)),
    removeItem: (k) => void backing.delete(k),
    clear: () => backing.clear(),
    key: (i) => [...backing.keys()][i] ?? null,
    get length() {
      return backing.size
    },
  }
  store = await import('../src/storage/spriteOverrideStore.ts')
  spriteSets = await import('../src/stage/spriteSets.ts')
})

test('spriteFileSrc 默认走静态路径', () => {
  const set = spriteSets.SPRITE_SETS.A
  assert.equal(spriteSets.spriteFileSrc(set, 'idle.png'), '/sprites/a/idle.png'.replace('//', '/'))
})

test('保存覆盖后 spriteFileSrc 命中 data URL,清除后回落;版本号 bump', async () => {
  const set = spriteSets.SPRITE_SETS.A
  const v0 = spriteSets.spriteOverridesVersion()
  let notified = 0
  const unsub = spriteSets.subscribeSpriteOverrides(() => notified++)
  assert.equal(await store.saveSpriteOverride('a', 'idle.png', PNG()), null)
  assert.equal(spriteSets.spriteFileSrc(set, 'idle.png'), PNG())
  assert.equal(spriteSets.spriteOverridesVersion(), v0 + 1)
  assert.ok(notified >= 1)

  await store.clearSpriteOverride('a', 'idle.png')
  assert.ok(spriteSets.spriteFileSrc(set, 'idle.png').endsWith('/sprites/a/idle.png'), '清除后回落静态路径')
  unsub()
})

test('校验:jpeg 拒收 / 超大拒收 / 未知文件名拒收', async () => {
  assert.ok((await store.saveSpriteOverride('a', 'idle.png', BAD)).includes('PNG'))
  assert.ok((await store.saveSpriteOverride('a', 'idle.png', `data:image/png;base64,${'A'.repeat(1024 * 1024)}`)).includes('太大'))
  assert.ok((await store.saveSpriteOverride('a', 'not-a-sprite.png', PNG())).includes('未知'))
  assert.equal(spriteSets.spriteFileSrc(spriteSets.SPRITE_SETS.A, 'idle.png').startsWith('data:'), false)
})

test('双槽隔离;b 槽覆盖不影响 a 槽', async () => {
  await store.saveSpriteOverride('a', 'talk.png', PNG(20))
  await store.saveSpriteOverride('b', 'talk.png', PNG(30))
  assert.equal(spriteSets.spriteFileSrc(spriteSets.SPRITE_SETS.A, 'talk.png'), PNG(20))
  assert.equal(spriteSets.spriteFileSrc(spriteSets.SPRITE_SETS.B, 'talk.png'), PNG(30))
  const listA = await store.listSpriteOverrides('a')
  const listB = await store.listSpriteOverrides('b')
  assert.deepEqual(Object.keys(listA), ['talk.png'])
  assert.deepEqual(Object.keys(listB), ['talk.png'])
  assert.equal(listA['talk.png'], PNG(20))
})

test('白名单覆盖动作图与变体图', () => {
  const files = spriteSets.spriteFileWhitelist(spriteSets.SPRITE_SETS.A)
  assert.ok(files.has('idle.png') && files.has('talk-point.png') && files.has('reading.png'))
  assert.ok(!files.has('../evil.png'))
})

test('applySpriteOverrides 整表替换:map 外的文件回到默认', async () => {
  const dir = spriteSets.SPRITE_SETS.A.dir
  await store.saveSpriteOverride('a', 'wave.png', PNG(7))
  assert.ok(spriteSets.spriteFileSrc(spriteSets.SPRITE_SETS.A, 'wave.png').startsWith('data:'))
  spriteSets.applySpriteOverrides(dir, { 'talk.png': PNG(8) })
  assert.ok(spriteSets.spriteFileSrc(spriteSets.SPRITE_SETS.A, 'talk.png').startsWith('data:'))
  assert.ok(spriteSets.spriteFileSrc(spriteSets.SPRITE_SETS.A, 'wave.png').endsWith('/sprites/a/wave.png'))
})

test('启动预载:ensureSpriteOverridesLoaded 把 localStorage 存量装进缓存', async () => {
  await store.saveSpriteOverride('b', 'happy.png', PNG(9))
  // 模拟重启:清掉内存缓存后重新预载
  spriteSets.applySpriteOverrides(spriteSets.SPRITE_SETS.B.dir, {})
  assert.ok(spriteSets.spriteFileSrc(spriteSets.SPRITE_SETS.B, 'happy.png').endsWith('/sprites/b/happy.png'))
  await store.ensureSpriteOverridesLoaded()
  assert.equal(spriteSets.spriteFileSrc(spriteSets.SPRITE_SETS.B, 'happy.png'), PNG(9))
})
