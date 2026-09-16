// 角色卡留档 store 回归:按槽位读写互不覆盖、sanitize 幂等、超限 raw 置 null、清除。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let store

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
  store = await import('../src/storage/cardImportStore.ts')
})

const record = (over = {}) => ({
  importedAt: 1_800_000_000_000,
  spec: 'chara_card_v2',
  creator: 'tester',
  characterVersion: '1.0',
  tags: ['test'],
  styleExamples: ['示例1:\n……'],
  bakedLore: [{ keys: [], content: '常驻背景', constant: true, priority: 10, enabled: true }],
  keywordLore: [{ keys: ['组织'], content: '关键词条', constant: false, priority: 5, enabled: true }],
  alternateGreetings: ['另一版开场'],
  raw: '{"name":"灰原哀"}',
  ...over,
})

test('按槽位读写互不覆盖;读回字段完整', async () => {
  await store.saveCardImport('a', record())
  await store.saveCardImport('b', record({ spec: 'chara_card_v3', creator: 'other' }))
  const a = await store.getCardImport('a')
  const b = await store.getCardImport('b')
  assert.equal(a.spec, 'chara_card_v2')
  assert.equal(b.spec, 'chara_card_v3')
  assert.equal(a.bakedLore.length, 1)
  assert.equal(a.keywordLore[0].keys[0], '组织')
  assert.equal(a.raw, '{"name":"灰原哀"}')
})

test('sanitize 幂等;坏档归空;raw 超限置 null', () => {
  const once = store.sanitizeCardImportsData({
    version: 1,
    imports: { a: record({ raw: 'x'.repeat(513 * 1024) }), b: { garbage: true } },
  })
  assert.equal(once.imports.a.raw, null, '超 512KB 的原始 JSON 置 null')
  assert.equal(once.imports.a.bakedLore.length, 1)
  assert.equal(once.imports.b, undefined)
  assert.deepEqual(store.sanitizeCardImportsData(once), once)
  assert.deepEqual(store.sanitizeCardImportsData(null).imports, {})
})

test('清除单槽不影响另一槽', async () => {
  await store.clearCardImport('a')
  assert.equal(await store.getCardImport('a'), null)
  assert.ok(await store.getCardImport('b'))
})
