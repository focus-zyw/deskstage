import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let reserveArcBeat

before(async () => {
  ;({ reserveArcBeat } = await import('../src/engine/arcReservation.ts'))
})


const arcs = [
  {
    id: 'arc-a',
    title: '同一条剧情',
    stage: 2,
    nextHook: '下一拍只能生成一次',
    status: 'active',
    lastSeen: 100,
  },
]

test('同一剧情拍生成期间不能被另一个模式重复预生成', () => {
  const first = reserveArcBeat(arcs, new Set(), () => 0)
  const second = reserveArcBeat(arcs, new Set(), () => 0)

  assert.equal(first?.beat.id, 'arc-a')
  assert.equal(second, null)

  first?.release()
  const afterRelease = reserveArcBeat(arcs, new Set(), () => 0)
  assert.equal(afterRelease?.beat.id, 'arc-a')
  afterRelease?.release()
})

test('已经进入预生成缓存的剧情拍仍视为占用', () => {
  const reservation = reserveArcBeat(arcs, new Set(['arc-a']), () => 0)

  assert.equal(reservation, null)
})
