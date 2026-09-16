// 文件型向量库回归:插入/同 id 覆盖、余弦排序、user_id 等值过滤、增删改查、
// list 计数、坏档清洗、零向量不召回、嵌入器指纹守卫(换模型 = 换空间重开)。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { createFileVectorStore, sanitizeVectorsFile, cosineSim } = await import(
  '../src/cold/vectorFileStore.ts'
)

function memoryIO() {
  let saved = null
  return {
    async read() {
      return saved
    },
    async write(file) {
      saved = JSON.parse(JSON.stringify(file))
    },
    get saved() {
      return saved
    },
  }
}

test('余弦:同向 1、正交 0、反向 -1、零向量保守 0', () => {
  assert.ok(Math.abs(cosineSim([1, 0], [2, 0]) - 1) < 1e-9)
  assert.ok(Math.abs(cosineSim([1, 0], [0, 3])) < 1e-9)
  assert.ok(Math.abs(cosineSim([1, 0], [-1, 0]) + 1) < 1e-9)
  assert.equal(cosineSim([0, 0], [1, 2]), 0)
  assert.equal(cosineSim([1], [1, 2]), 0) // 维度不齐
})

test('插入与同 id 覆盖(upsert 语义)', async () => {
  const io = memoryIO()
  const store = createFileVectorStore(io, 'col')
  await store.insert([[1, 0], [0, 1]], ['a', 'b'], [{ user_id: 'u', data: '甲' }, { user_id: 'u', data: '乙' }])
  await store.insert([[0.9, 0.1]], ['a'], [{ user_id: 'u', data: '甲改' }])
  const [items, count] = await store.list()
  assert.equal(count, 2)
  assert.equal(items.find((it) => it.id === 'a').payload.data, '甲改')
  assert.ok(io.saved.collections.col.items.length === 2) // 持久化生效
})

test('检索:按余弦排序 + user_id 过滤 + topK', async () => {
  const store = createFileVectorStore(memoryIO(), 'col')
  await store.insert(
    [[1, 0], [0.9, 0.1], [0, 1], [-1, 0]],
    ['near', 'nearest', 'other-user', 'far'],
    [
      { user_id: 'audience', data: '近' },
      { user_id: 'audience', data: '最近' },
      { user_id: 'someone', data: '别人' },
      { user_id: 'audience', data: '远' },
    ],
  )
  const hits = await store.search([1, 0], 2, { user_id: 'audience' })
  assert.equal(hits.length, 2)
  assert.equal(hits[0].id, 'near')
  assert.equal(hits[1].id, 'nearest')
  assert.ok(hits[0].score > hits[1].score)
})

test('get/update/delete/deleteCol 全链', async () => {
  const store = createFileVectorStore(memoryIO(), 'col')
  await store.insert([[1, 0]], ['a'], [{ user_id: 'u', data: '旧' }])
  assert.equal((await store.get('a')).payload.data, '旧')
  assert.equal(await store.get('missing'), null)
  await store.update('a', [0, 1], { user_id: 'u', data: '新' })
  assert.equal((await store.get('a')).payload.data, '新')
  await store.delete('a')
  assert.equal(await store.get('a'), null)
  await store.insert([[1, 0]], ['b'], [{}])
  await store.deleteCol()
  const [items, count] = await store.list()
  assert.equal(count, 0)
  assert.equal(items.length, 0)
})

test('getUserId/setUserId 与坏档清洗', async () => {
  const store = createFileVectorStore(memoryIO(), 'col')
  await store.setUserId('audience')
  assert.equal(await store.getUserId(), 'audience')

  const dirty = sanitizeVectorsFile({ collections: { col: { items: [{ id: 'ok', vector: [1], payload: {} }, null, { id: 7 }, 'x'] }, bad: 42 } })
  assert.equal(dirty.collections.col.items.length, 1)
  assert.deepEqual(sanitizeVectorsFile(dirty), dirty)
  assert.deepEqual(sanitizeVectorsFile(null).collections, {})
})

// ---- 嵌入器指纹守卫:换嵌入模型 = 换向量空间,旧向量全部不可比 ----

test('指纹不匹配:重开空库并盖上新指纹', async () => {
  const io = memoryIO()
  await createFileVectorStore(io, 'col', 'endpoint:p/m1').insert([[1, 0]], ['a'], [{ user_id: 'u' }])
  assert.equal(io.saved.collections.col.embedder, 'endpoint:p/m1')
  const next = createFileVectorStore(io, 'col', 'local:')
  const [items, count] = await next.list()
  assert.equal(count, 0) // 旧向量不可比,整体重开
  assert.equal(items.length, 0)
  assert.equal(io.saved.collections.col.embedder, 'local:')
})

test('指纹匹配保留;老档(升级存量)无指纹不重置、写盘时补盖', async () => {
  const io = memoryIO()
  await createFileVectorStore(io, 'col', 'local:bge').insert([[1, 0]], ['a'], [{}])
  const same = createFileVectorStore(io, 'col', 'local:bge')
  assert.equal((await same.list())[1], 1) // 同嵌入器:数据原样保留
  assert.equal(io.saved.collections.col.embedder, 'local:bge')

  const legacy = memoryIO()
  await createFileVectorStore(legacy, 'col').insert([[1, 0]], ['a'], [{}])
  assert.equal(legacy.saved.collections.col.embedder, undefined)
  const migrated = createFileVectorStore(legacy, 'col', 'endpoint:p/m')
  assert.equal((await migrated.list())[1], 1) // 不激进重置
  await migrated.insert([[0, 1]], ['b'], [{}])
  assert.equal(legacy.saved.collections.col.embedder, 'endpoint:p/m') // 补盖随写盘生效
})

test('deleteCol 清集合不清指纹', async () => {
  const io = memoryIO()
  const store = createFileVectorStore(io, 'col', 'local:')
  await store.insert([[1, 0]], ['a'], [{}])
  await store.deleteCol()
  assert.equal(io.saved.collections.col.items.length, 0)
  assert.equal(io.saved.collections.col.embedder, 'local:')
})
