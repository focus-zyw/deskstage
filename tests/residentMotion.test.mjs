// C 的漫游路径纯函数回归:步幅范围、边界反弹、速度换算。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let motion

before(async () => {
  motion = await import('../src/stage/resident/residentMotion.ts')
})


test('漫游目标始终在界内,步幅 3~7 个百分点', () => {
  for (let i = 0; i < 200; i++) {
    const rand = () => (i % 10) / 10 + (i % 100) / 1000 // 确定性伪随机,覆盖各种组合
    const to = motion.nextRoamTarget(50, rand)
    assert.ok(to >= motion.RESIDENT_ROAM_BOUNDS.minPct, `越下界: ${to}`)
    assert.ok(to <= motion.RESIDENT_ROAM_BOUNDS.maxPct, `越上界: ${to}`)
    const step = Math.abs(to - 50)
    assert.ok(step >= 3 - 1e-9 && step <= 7 + 1e-9, `步幅越界: ${step}`)
  }
})

test('贴上界时强制反弹向内,不会越界', () => {
  // rand()=0.99 → 步幅接近 7;在上界附近无论方向怎么掷都必须回到界内
  for (let i = 0; i < 50; i++) {
    const to = motion.nextRoamTarget(motion.RESIDENT_ROAM_BOUNDS.maxPct - 2, Math.random)
    assert.ok(to <= motion.RESIDENT_ROAM_BOUNDS.maxPct)
  }
  for (let i = 0; i < 50; i++) {
    const to = motion.nextRoamTarget(motion.RESIDENT_ROAM_BOUNDS.minPct + 2, Math.random)
    assert.ok(to >= motion.RESIDENT_ROAM_BOUNDS.minPct)
  }
})

test('自定义边界同样被尊重(钳位兜底)', () => {
  const to = motion.nextRoamTarget(10, () => 0.99, { minPct: 0, maxPct: 20 })
  assert.ok(to >= 0 && to <= 20)
})

test('行进耗时按速度换算:距离越远越久', () => {
  const ms = motion.roamDurationMs(50, 55)
  assert.equal(ms, Math.round((5 / motion.ROAM_SPEED_PCT_PER_SEC) * 1000))
  assert.equal(motion.roamDurationMs(30, 30), 0)
  assert.ok(motion.roamDurationMs(10, 60) > motion.roamDurationMs(10, 20))
})
