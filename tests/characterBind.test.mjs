// 槽位绑定投影回归:绑定 patch 五字段只动目标槽 / 解绑还原空值与默认性别 /
// slotsBoundTo / 多槽占用标注 / 失效 id 视为未绑定。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { buildBindingPatch, slotsBoundTo, boundCharacterId, occupiedByElse } = await import('../src/characters/bind.ts')

const current = {
  names: { a: '甲', b: '乙', c: '丙' },
  genders: { a: '女', b: '男', c: '女' },
  persona: { a: '内置甲的人设', b: '', c: '' },
  personaSource: { a: 'default', b: 'custom', c: 'default' },
  slotBindings: { a: null, b: 'chr_other', c: null },
}

test('绑定:五字段只动目标槽,其余槽原样保留', () => {
  const patch = buildBindingPatch('a', { id: 'chr_1', name: '灰原哀', gender: '女', persona: '天才科学家' }, current)
  assert.deepEqual(patch.names, { a: '灰原哀', b: '乙', c: '丙' })
  assert.deepEqual(patch.genders, { a: '女', b: '男', c: '女' })
  assert.deepEqual(patch.persona, { a: '天才科学家', b: '', c: '' })
  assert.deepEqual(patch.personaSource, { a: 'custom', b: 'custom', c: 'default' })
  assert.deepEqual(patch.slotBindings, { a: 'chr_1', b: 'chr_other', c: null })
})

test('解绑:目标槽空值回默认(b 槽的 custom 人设不受影响)', () => {
  const patch = buildBindingPatch('a', null, current)
  assert.deepEqual(patch.names, { a: '', b: '乙', c: '丙' })
  assert.deepEqual(patch.genders, { a: '女', b: '男', c: '女' }) // A 内置默认女
  assert.deepEqual(patch.persona, { a: '', b: '', c: '' })
  assert.deepEqual(patch.personaSource, { a: 'default', b: 'custom', c: 'default' })
  assert.deepEqual(patch.slotBindings, { a: null, b: 'chr_other', c: null })
})

test('解绑 C:默认性别为女;绑定 B:保留其既有绑定', () => {
  const unbindC = buildBindingPatch('c', null, current)
  assert.equal(unbindC.genders.c, '女')
  const bindB = buildBindingPatch('b', { id: 'chr_2', name: '库莉丝', gender: '女', persona: 'p' }, current)
  assert.equal(bindB.genders.b, '女')
  assert.equal(bindB.slotBindings.b, 'chr_2')
})

test('slotsBoundTo / boundCharacterId / occupiedByElse', () => {
  const bindings = { a: 'chr_1', b: 'chr_other', c: 'chr_1' }
  assert.deepEqual(slotsBoundTo(bindings, 'chr_1'), ['a', 'c'])
  assert.deepEqual(slotsBoundTo(undefined, 'chr_1'), [])
  assert.equal(boundCharacterId(bindings, 'b'), 'chr_other')
  assert.equal(boundCharacterId(undefined, 'a'), null)
  assert.equal(occupiedByElse(bindings, 'chr_1', 'a'), 'c')
  assert.equal(occupiedByElse(bindings, 'chr_1', 'c'), 'a')
  assert.equal(occupiedByElse(bindings, 'chr_1', 'b'), 'a') // b 槽自身未绑定,其余槽 a 已占用
})

test('effectivePersona / projectedPersonaSource:内置留空跟模板,固化即 custom', async () => {
  const { effectivePersona, projectedPersonaSource } = await import('../src/characters/bind.ts')
  const template = (slot) => `内置模板(${slot})` // slot 为大写 ActorSlot
  assert.equal(effectivePersona({ persona: '', builtin: 'a' }, template), '内置模板(A)')
  assert.equal(effectivePersona({ persona: '自定义文本', builtin: 'a' }, template), '自定义文本')
  assert.equal(effectivePersona({ persona: '手动角色人设' }, template), '手动角色人设')
  assert.equal(projectedPersonaSource({ persona: '', builtin: 'b' }), 'default')
  assert.equal(projectedPersonaSource({ persona: '固化文本', builtin: 'b' }), 'custom')
  assert.equal(projectedPersonaSource({ persona: '任意' }), 'custom')
})

test('绑定内置未改角色:persona 投影为内置模板,personaSource 保持 default', async () => {
  const { defaultPersonaText } = await import('../src/engine/persona.ts')
  const patch = buildBindingPatch('a', { id: 'chr_builtin_a', name: '小明', gender: '女', persona: '', builtin: 'a' }, current)
  assert.equal(patch.persona.a, defaultPersonaText('A')) // 真实内置模板全文
  assert.equal(patch.personaSource.a, 'default')
})
