// C 常驻行为的情绪偏置回归:闹情绪不哼歌、蔫了发呆且节奏放缓、精神足加专注小动作、平静走默认池。
// 偏置函数是纯函数,直接喂 Mood;池成员必须是合法片段 id(类型层保证,这里测行为语义)。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let machine

const T0 = new Date(2026, 5, 3, 14, 0, 0).getTime()
const mood = (valence, energy) => ({ valence, energy, updatedAt: T0 })

before(async () => {
  machine = await import('../src/stage/resident/residentMachine.ts')
})


test('闹情绪:待机不哼歌改敲桌面,点击回应收起热情招手', () => {
  const angry = mood(-2, 3)
  const ambient = machine.ambientClipsForMood(angry)
  assert.ok(ambient.includes('tap'), `ambient=${ambient}`)
  assert.ok(!ambient.includes('hum'))
  const poke = machine.pokeClipsForMood(angry)
  assert.ok(!poke.includes('happy') && !poke.includes('wave'), `poke=${poke}`)
  assert.ok(poke.includes('startled') && poke.includes('caught'))
})

test('蔫了/犯困:安静发呆,待机间隔拉长 1.5 倍', () => {
  const sad = mood(-2, 1)
  const sleepy = mood(0, 0.5)
  for (const m of [sad, sleepy]) {
    const ambient = machine.ambientClipsForMood(m)
    assert.ok(!ambient.includes('hum') && !ambient.includes('focus'), `ambient=${ambient}`)
    assert.equal(machine.ambientIntervalScale(m), 1.5)
    assert.ok(ambient.includes('turn'))
  }
  assert.ok(!machine.pokeClipsForMood(sleepy).includes('happy'))
})

test('精神足:待机加专注小动作,节奏不变', () => {
  const excited = mood(2, 4)
  assert.ok(machine.ambientClipsForMood(excited).includes('focus'))
  assert.equal(machine.ambientIntervalScale(excited), 1)
})

test('平静/愉快:走默认池,零偏置', () => {
  const calm = mood(0, 2.5)
  assert.deepEqual(machine.ambientClipsForMood(calm), machine.AMBIENT_CLIPS)
  assert.deepEqual(machine.pokeClipsForMood(calm), machine.POKE_CLIPS)
  assert.equal(machine.ambientIntervalScale(calm), 1)
  assert.deepEqual(machine.pokeClipsForMood(mood(2, 2)), machine.POKE_CLIPS)
})
