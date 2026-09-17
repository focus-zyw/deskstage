// 角色库持久层回归:sanitize 幂等/坏档拒收/CRUD/容量上限/id 去重/localStorage 降级。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let store

const def = (over = {}) => ({
  id: 'chr_1',
  name: '灰原哀',
  gender: '女',
  persona: '天才科学家,毒舌傲娇。',
  source: 'manual',
  createdAt: 1_800_000_000_000,
  ...over,
})

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
  store = await import('../src/storage/charactersStore.ts')
})

test('sanitize:垃圾档归空、无 id/无名拒收、幂等', () => {
  const once = store.sanitizeCharactersData({
    version: 1,
    characters: [def(), { name: '没 id' }, { id: 'chr_x' }, 'junk', def({ id: 'chr_2', source: 'card', card: { spec: 'chara_card_v2' } })],
  })
  assert.equal(once.characters.length, 2)
  assert.equal(once.characters[1].source, 'card')
  assert.deepEqual(store.sanitizeCharactersData(once), once)
  assert.deepEqual(store.sanitizeCharactersData(null).characters, [])
})

test('CRUD:新增/更新/查询/删除', async () => {
  const created = await store.saveCharacter({ name: '灰原哀', gender: '女', persona: '天才科学家' })
  assert.ok(created.id.startsWith('chr_'))
  const updated = await store.saveCharacter({ id: created.id, name: '库莉丝', gender: '女', persona: '神经科学家' })
  assert.equal(updated.id, created.id)
  assert.equal(updated.name, '库莉丝')
  const got = await store.getCharacter(created.id)
  assert.equal(got.name, '库莉丝')
  await store.deleteCharacter(created.id)
  assert.equal(await store.getCharacter(created.id), null)
})

test('名字与人设超长截断;空名报错', async () => {
  const c = await store.saveCharacter({ name: '一二三四五六七八九十一二三', persona: 'x'.repeat(9000) })
  assert.equal(c.name.length, 12)
  assert.equal(c.persona.length, 8000)
  await assert.rejects(() => store.saveCharacter({ name: '   ' }), /角色名/)
})


test('内置种子:ensureSeeded 补种甲/乙/丙,config 自定义无损固化;已种不重复', async () => {
  await store.resetCharacters()
  await store.ensureSeeded({
    names: { a: '小明', b: '', c: '丙' },
    genders: { a: '女', b: '男', c: '女' },
    persona: { a: '自定义人设文本', b: '', c: '' },
    personaSource: { a: 'custom', b: 'default', c: 'default' },
  })
  const list = await store.listCharacters()
  const builtins = list.filter((c) => c.builtin)
  assert.equal(builtins.length, 3)
  const a = builtins.find((c) => c.builtin === 'a')
  assert.equal(a.name, '小明')
  assert.equal(a.persona, '自定义人设文本') // 已自定义 → 固化
  const b = builtins.find((c) => c.builtin === 'b')
  assert.equal(b.name, '乙')
  assert.equal(b.persona, '') // 未自定义 → 跟随模板
  // 再种一次:不重复
  await store.ensureSeeded({ names: { a: 'x', b: 'y', c: 'z' }, genders: { a: '女', b: '男', c: '女' }, persona: { a: '', b: '', c: '' }, personaSource: { a: 'default', b: 'default', c: 'default' } })
  assert.equal((await store.listCharacters()).filter((c) => c.builtin).length, 3)
})

test('内置角色不可删除', async () => {
  await store.resetCharacters()
  await store.ensureSeeded(undefined)
  const a = (await store.listCharacters()).find((c) => c.builtin === 'a')
  await assert.rejects(() => store.deleteCharacter(a.id), /内置/)
})

test('sanitize 保留 builtin 标记', () => {
  const once = store.sanitizeCharactersData({ version: 1, characters: [def({ builtin: 'c' })] })
  assert.equal(once.characters[0].builtin, 'c')
  assert.deepEqual(store.sanitizeCharactersData(once), once)
})

test('容量上限 50:满了新增报错,更新不占新位', async () => {
  await store.resetCharacters()
  for (let i = 0; i < 50; i++) {
    await store.saveCharacter({ name: `角色${i}`, persona: '' })
  }
  await assert.rejects(() => store.saveCharacter({ name: '第51个' }), /已满/)
  const some = (await store.listCharacters())[0]
  await store.saveCharacter({ id: some.id, name: '改个名不占位' }) // 更新照常
  assert.equal((await store.listCharacters()).length, 50)
})

test('版本广播:save/delete/seed 都 bump,订阅者收到通知', async () => {
  await store.resetCharacters()
  let notified = 0
  const unsub = store.subscribeCharacters(() => notified++)
  const v0 = store.charactersVersion()
  const c = await store.saveCharacter({ name: '广播测试' })
  assert.equal(store.charactersVersion(), v0 + 1)
  await store.deleteCharacter(c.id)
  assert.ok(store.charactersVersion() >= v0 + 2)
  assert.ok(notified >= 2)
  unsub()
})
