// 三人对话协议回归:speaker/target 扩 C、reactions 清洗、listenersOf/reactionsOf 路由。
// 兼容性重点:旧 listenerAction 历史数据按 target 转换,行为与双人时代一致。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let schema

before(async () => {
  schema = await import('../src/performer/dialogSchema.ts')
})


const line = (raw) => schema.sanitizeDialogLine(raw)

test('speaker 与 target 都接受 C;非法 target 丢弃', () => {
  const c = line({ speaker: 'C', text: '好的,马上办', action: 'talk', target: 'C' })
  assert.equal(c.target, 'C')
  const room = line({ speaker: 'A', text: '大家好啊', target: 'room' })
  assert.equal(room.target, 'room')
  assert.equal(line({ speaker: 'A', text: 'x', target: 'D' }).target, undefined)
})

test('reactions 清洗:只认 A/B/C、跳过说话者自己、非法动作剔除', () => {
  const r = line({
    speaker: 'A',
    text: '我做饭从来不看菜谱。',
    action: 'happy',
    reactions: { B: 'thinking', C: 'surprise', A: 'angry', D: 'happy' },
  })
  assert.deepEqual(r.reactions, { B: 'thinking', C: 'surprise' })
  // 全非法 → undefined(不携带空对象)
  assert.equal(line({ speaker: 'A', text: 'x', reactions: { B: '乱写' } }).reactions, undefined)
  assert.equal(line({ speaker: 'A', text: 'x', reactions: 'not-an-object' }).reactions, undefined)
})

test('场景卡可选 roleC:缺省不废卡,有值时保留', () => {
  const base = {
    relationship: '老搭档',
    scene: '深夜便利店',
    secret: 'B 其实早就知道',
    escalation: ['铺垫', '升级', '响底'],
    goalA: '证明自己会做饭',
    goalB: '拦住 A',
  }
  assert.equal(schema.sanitizeSceneCard(base).roleC, undefined)
  assert.equal(
    schema.sanitizeSceneCard({ ...base, roleC: '把A吹牛的内容当真,开始销毁菜谱' }).roleC,
    '把A吹牛的内容当真,开始销毁菜谱',
  )
  // 清洗层只看数据合法性:缺 secret 不再废卡(非喜剧卡要能活着落盘),
  // 喜剧模式的 secret/callback 是否必有由 validatePerformanceScript 的 comedy 选项把关
  const noSecret = schema.sanitizeSceneCard({ ...base, roleC: 'x', secret: '' })
  assert.equal(noSecret.roleC, 'x')
  assert.equal(noSecret.secret, undefined)
  assert.equal(noSecret.escalation.length, 3)
})

test('listenersOf:room=除说话者全员;指定听者归一;audience/缺省无听者', () => {
  assert.deepEqual(schema.listenersOf({ speaker: 'A', target: 'room' }), ['B', 'C'])
  assert.deepEqual(schema.listenersOf({ speaker: 'C', target: 'room' }), ['A', 'B'])
  assert.deepEqual(schema.listenersOf({ speaker: 'A', target: 'C' }), ['C'])
  assert.deepEqual(schema.listenersOf({ speaker: 'A', target: 'B' }), ['B'])
  assert.deepEqual(schema.listenersOf({ speaker: 'A', target: 'audience' }), [])
  assert.deepEqual(schema.listenersOf({ speaker: 'A' }), [])
  // 自指不是听者
  assert.deepEqual(schema.listenersOf({ speaker: 'A', target: 'A' }), [])
})

test('reactionsOf:新字段优先,整段原样生效', () => {
  const reactions = { B: 'shy', C: 'surprise' }
  assert.deepEqual(
    schema.reactionsOf({
      speaker: 'A',
      text: 'x',
      action: 'talk',
      listenerAction: 'laugh',
      reactions,
    }),
    reactions,
  )
})

test('reactionsOf:旧 listenerAction 兼容——A/B 无 target 互为听者', () => {
  assert.deepEqual(schema.reactionsOf({ speaker: 'A', text: 'x', action: 'talk', listenerAction: 'shy' }), {
    B: 'shy',
  })
  assert.deepEqual(schema.reactionsOf({ speaker: 'B', text: 'x', action: 'talk', listenerAction: 'laugh' }), {
    A: 'laugh',
  })
})

test('reactionsOf:旧 listenerAction 指向 C 时按 target 转换', () => {
  assert.deepEqual(schema.reactionsOf({ speaker: 'A', text: 'x', action: 'talk', target: 'C', listenerAction: 'surprise' }), {
    C: 'surprise',
  })
})

test('reactionsOf:C 的旧画外音无 target 视为对全场,不指定单一听者', () => {
  assert.deepEqual(schema.reactionsOf({ speaker: 'C', text: 'x', action: 'talk', listenerAction: 'shy' }), {})
  assert.deepEqual(schema.reactionsOf({ speaker: 'C', text: 'x', action: 'talk', target: 'A', listenerAction: 'shy' }), {
    A: 'shy',
  })
})

test('reactionsOf:audience/room 的 listenerAction 不落在任何人身上', () => {
  assert.deepEqual(schema.reactionsOf({ speaker: 'A', text: 'x', action: 'talk', target: 'audience', listenerAction: 'shy' }), {})
  assert.deepEqual(schema.reactionsOf({ speaker: 'A', text: 'x', action: 'talk', target: 'room', listenerAction: 'shy' }), {})
})
