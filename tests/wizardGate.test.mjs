// 首启向导门控回归:wizardDone 字段的清洗与"零痕迹"判定数据源。
// 弹出条件(App 侧,此处固定其输入契约):!wizardDone && 无聊天记录 && 未填称呼;
// 老用户升级(wizardDone 缺省 false)但有任一痕迹 → 不弹。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let configStore

before(async () => {
  configStore = await import('../src/storage/configStore.ts')
})


test('wizardDone:老配置缺省 false(视为未完成,是否弹由零痕迹判定决定)', () => {
  assert.equal(configStore.sanitizeConfig({}).wizardDone, false)
})

test('wizardDone:显式完成后不再弹', () => {
  assert.equal(configStore.sanitizeConfig({ wizardDone: true }).wizardDone, true)
})

test('老用户痕迹字段清洗后仍在,支撑零痕迹判定', () => {
  // 有称呼的老用户:wizardDone 缺省 false 但 userName 非空 → App 不弹
  const legacy = configStore.sanitizeConfig({
    userProfile: { userName: '小张' },
  })
  assert.equal(legacy.wizardDone, false)
  assert.equal(legacy.userProfile.userName, '小张')
})

test('纯新装用户:全部零痕迹 → 满足弹出条件', () => {
  const fresh = configStore.sanitizeConfig({})
  const shouldShow = !fresh.wizardDone && !fresh.userProfile.userName.trim()
  assert.ok(shouldShow)
})
