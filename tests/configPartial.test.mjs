// 写前校验闸:sanitizePartial 只清洗 update 中出现的顶层键,表外键拒绝(不落盘);
// 与全量 sanitizeConfig(读路径)共用同一张 FIELD_SANITIZERS 表,规则必然一致。
// 统一状态中心后,saveConfig 在 invoke('config_set') 前过这道闸,Rust 不复制 schema。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let configStore

before(async () => {
  configStore = await import('../src/storage/configStore.ts')
})


test('sanitizePartial 只清洗出现的键,未触及字段不出现在结果里', () => {
  const out = configStore.sanitizePartial({ dnd: true })
  assert.deepEqual(out, { dnd: true })
})

test('sanitizePartial 非法值清洗回默认(与读路径同一套规则)', () => {
  const out = configStore.sanitizePartial({
    characters: { height: 99999, A: { xPct: 3, bottom: 0 }, B: { xPct: 97, bottom: 0 } },
    theme: 'neo',
    choiceChance: 7,
  })
  assert.equal(out.characters.height, 2000)
  assert.equal(out.theme, 'dark')
  assert.equal(out.choiceChance, 1)
})

test('sanitizePartial 拒绝 schema 外的顶层键(未知字段不落盘)', () => {
  const out = configStore.sanitizePartial({ evilField: 'x', model: 'm2' })
  assert.deepEqual(out, { model: 'm2' })
})

test('sanitizePartial 与 sanitizeConfig 全量清洗同规则(同名同值)', () => {
  const patch = { names: { a: ' 小甲 ', b: '', c: '丙丙丙' }, persona: { a: '  ' } }
  const partial = configStore.sanitizePartial(patch)
  const full = configStore.sanitizeConfig(patch)
  assert.deepEqual(partial.names, full.names)
  assert.deepEqual(partial.persona, full.persona)
})

test('读路径行为不变:sanitizeConfig 空对象落默认值', () => {
  const cfg = configStore.sanitizeConfig({})
  // 与旧实现一致的代表性默认:空 screenshot.hotkey 不回落默认快捷键(仅新装首启写默认值时有)
  assert.equal(cfg.apiKey, '')
  assert.equal(cfg.baseUrl, 'https://api.deepseek.com/v1')
  assert.equal(cfg.theme, 'dark')
  assert.equal(cfg.screenshot.hotkey, '')
  assert.equal(cfg.screenshot.enabled, true)
  assert.equal(cfg.characters.height, 320)
  assert.equal(cfg.proactivity, 'balanced')
  assert.deepEqual(cfg.tools, { switches: {}, autoApproved: {} })
})
