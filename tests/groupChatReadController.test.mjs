// GroupChatReadController 验收矩阵(方案 §15 的 12 条全部映射到控制器纯逻辑层;
// 滚动的像素级断言在页面层以效果类型代替——scroll-bottom/scroll-message/preserve)。
// 假游标仓:内存 Map + 落盘计数;零 IO 零 DOM。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let mod

before(async () => {
  mod = await import('../src/groupChat/readController.ts')
})


const NAME_OF = { A: '柯南', B: '大肥鱼', C: '小哀' }

function makeController(cursor = null) {
  const saved = []
  const state = { cursor }
  const controller = mod.createGroupChatReadController({
    getCursor: () => state.cursor,
    setCursor: (id) => {
      state.cursor = id
      saved.push(id)
    },
    nameOf: (a) => NAME_OF[a],
  })
  return { controller, saved, state }
}

const user = (id, text = '用户说') => ({ id, ts: 1, who: 'user', text })
const actor = (id, who, text = '角色说', over = {}) => ({ id, ts: 2, who, text, ...over })

const VIEW_BOTTOM = { active: true, distanceToBottom: 0, lastFullyVisibleId: null }
const VIEW_HISTORY = { active: true, distanceToBottom: 800, lastFullyVisibleId: null }
const VIEW_AWAY = { active: false, distanceToBottom: 800, lastFullyVisibleId: null }

function seed(controller, entries) {
  controller.setEntries(entries, 'initial')
  controller.setView({ ...VIEW_BOTTOM, lastFullyVisibleId: entries.at(-1)?.id ?? null })
}

test('0. getSnapshot 引用稳定(useSyncExternalStore 契约):突变前两次调用同一对象,突变后换新', () => {
  const { controller } = makeController()
  const base = [user('u1'), actor('m1', 'A')]
  seed(controller, base)
  const a = controller.getSnapshot()
  const b = controller.getSnapshot()
  assert.equal(a, b, '无突变时必须返回同一引用,否则 useSyncExternalStore 无限重渲染')
  controller.setView(VIEW_HISTORY)
  const c = controller.getSnapshot()
  assert.equal(c, controller.getSnapshot())
  controller.setEntries([...base, actor('m2', 'B')], 'append')
  const d = controller.getSnapshot()
  assert.notEqual(c, d, '突变后快照更新')
})

test('1. 底部收到消息:自动跟随(scroll-bottom),未读为 0', () => {
  const { controller } = makeController()
  seed(controller, [user('u1'), actor('m1', 'A')])
  assert.equal(controller.getSnapshot().unreadCount, 0)
  const effect = controller.setEntries([user('u1'), actor('m1', 'A'), actor('m2', 'B', '新消息')], 'append')
  assert.equal(effect.type, 'scroll-bottom')
  assert.equal(controller.getSnapshot().unreadCount, 0)
})

test('2. 阅读历史时收到三条:视口保持(preserve),按钮显示 3', () => {
  const { controller } = makeController()
  const base = [user('u1'), actor('m1', 'A')]
  seed(controller, base)
  controller.setView(VIEW_HISTORY)
  const effect = controller.setEntries(
    [...base, actor('m2', 'B'), actor('m3', 'A'), actor('m4', 'C')],
    'append',
  )
  assert.equal(effect.type, 'preserve-viewport')
  const snap = controller.getSnapshot()
  assert.equal(snap.unreadCount, 3)
  assert.equal(snap.label, '3 条新消息')
  assert.equal(snap.firstUnreadId, 'm2')
})

test('3+4. 窗口隐藏/切到其他分页:消息继续累计未读,不滚动', () => {
  const { controller } = makeController()
  const base = [user('u1'), actor('m1', 'A')]
  seed(controller, base)
  controller.setView(VIEW_AWAY)
  const effect = controller.setEntries([...base, actor('m2', 'B'), actor('m3', 'B')], 'append')
  assert.equal(effect.type, 'preserve-viewport')
  assert.equal(controller.getSnapshot().unreadCount, 2)
  // 重新进入:定位第一条未读(§1)
  const jump = controller.setView({ active: true, distanceToBottom: 800, lastFullyVisibleId: null })
  assert.equal(jump.type, 'scroll-message')
  assert.equal(jump.id, 'm2')
})

test('5. 点击按钮:存在未读定位第一条未读;没有未读滚到底部', () => {
  const { controller } = makeController()
  const base = [user('u1'), actor('m1', 'A')]
  seed(controller, base)
  controller.setView(VIEW_HISTORY)
  controller.setEntries([...base, actor('m2', 'B'), actor('m3', 'C')], 'append')
  const jump = controller.requestJump()
  assert.equal(jump.type, 'scroll-message')
  assert.equal(jump.id, 'm2', '定位第一条未读,而非最后一条')
  // 读完后:滚到底部
  controller.setView({ ...VIEW_BOTTOM, lastFullyVisibleId: 'm3' })
  assert.equal(controller.requestJump().type, 'scroll-bottom')
})

test('6. 消息进入可视区:游标单调前进,未读逐步减少;回看不减', () => {
  const { controller } = makeController()
  const base = [user('u1'), actor('m1', 'A')]
  seed(controller, base)
  controller.setView(VIEW_HISTORY)
  controller.setEntries(
    [...base, actor('m2', 'B'), actor('m3', 'C'), actor('m4', 'A'), actor('m5', 'B')],
    'append',
  )
  assert.equal(controller.getSnapshot().unreadCount, 4)
  assert.equal(controller.getSnapshot().firstUnreadId, 'm2')
  // 依次看到 m2、m4:游标前进,未读逐步减少
  controller.setView({ ...VIEW_HISTORY, lastFullyVisibleId: 'm2' })
  assert.equal(controller.getSnapshot().unreadCount, 3)
  controller.setView({ ...VIEW_HISTORY, lastFullyVisibleId: 'm4' })
  assert.equal(controller.getSnapshot().unreadCount, 1)
  // 回看更早的 m1:游标不后退
  controller.setView({ ...VIEW_HISTORY, lastFullyVisibleId: 'm1' })
  assert.equal(controller.getSnapshot().unreadCount, 1)
  // 贴底:一次性推进到最后一条
  controller.setView({ ...VIEW_BOTTOM, lastFullyVisibleId: null })
  assert.equal(controller.getSnapshot().unreadCount, 0)
})

test('7. 直接回复用户:显示「角色回复了你 · N」(parentTurnId / replyTo 两路判定)', () => {
  const { controller } = makeController()
  const base = [user('u1', '在吗'), actor('m1', 'A')]
  seed(controller, base)
  controller.setView(VIEW_HISTORY)
  controller.setEntries(
    [...base, actor('m2', 'A', '在的', { parentTurnId: 'u1' }), actor('m3', 'B', '我也在', { replyTo: ['u1'] })],
    'append',
  )
  const snap = controller.getSnapshot()
  assert.equal(snap.unreadCount, 2)
  assert.equal(snap.latestTargetedActor, 'B', '最后一条定向回复的 actor 胜出')
  assert.equal(snap.label, '大肥鱼回复了你 · 2')
})

test('8. 用户自己发送消息:不增加未读;notifyOwnSend 贴底跟随', () => {
  const { controller } = makeController()
  const base = [user('u1'), actor('m1', 'A')]
  seed(controller, base)
  controller.setView(VIEW_HISTORY)
  controller.notifyOwnSend()
  const effect = controller.setEntries([...base, user('u2', '再说')], 'append')
  assert.equal(effect.type, 'scroll-bottom')
  assert.equal(controller.getSnapshot().unreadCount, 0)
})

test('9. 顶部加载旧消息:preserve,游标与未读不动(prepend)', () => {
  const { controller } = makeController()
  const base = [user('u1'), actor('m1', 'A')]
  seed(controller, base)
  controller.setView(VIEW_HISTORY)
  controller.setEntries([...base, actor('m2', 'B')], 'append')
  const before = controller.getSnapshot().unreadCount
  const effect = controller.setEntries([actor('m0', 'C'), ...base, actor('m2', 'B')], 'prepend')
  assert.equal(effect.type, 'preserve-viewport')
  assert.equal(controller.getSnapshot().unreadCount, before)
})

test('10. 清空记录:游标清空、未读归零、分割线消失', () => {
  const { controller, state } = makeController()
  const base = [user('u1'), actor('m1', 'A')]
  seed(controller, base)
  controller.setView(VIEW_HISTORY)
  controller.setEntries([...base, actor('m2', 'B')], 'append')
  assert.ok(controller.getSnapshot().unreadCount > 0)
  controller.setEntries([], 'clear')
  const snap = controller.getSnapshot()
  assert.equal(snap.unreadCount, 0)
  assert.equal(snap.firstUnreadId, null)
  assert.equal(state.cursor, null)
})

test('11. 旧日志无 ID/首装游标为空:不崩溃,也不把全部历史判为未读', () => {
  const { controller, state } = makeController(null)
  const legacy = [user('u1'), actor('m1', 'A'), actor('m2', 'B')]
  controller.setEntries(legacy, 'initial')
  const snap = controller.getSnapshot()
  assert.equal(snap.unreadCount, 0, '首装以日志末尾初始化,历史不算未读')
  assert.equal(state.cursor, 'm2', '游标以日志末尾初始化并持久化')
  // 追加一条:正常计未读
  controller.setView(VIEW_HISTORY)
  controller.setEntries([...legacy, actor('m3', 'C')], 'append')
  assert.equal(controller.getSnapshot().unreadCount, 1)
})

test('12. 重启应用:已读位置从持久游标恢复', () => {
  // "上次会话"读到 m2 后退出
  const first = makeController(null)
  const entries = [user('u1'), actor('m1', 'A'), actor('m2', 'B'), actor('m3', 'C')]
  first.controller.setEntries(entries, 'initial')
  first.controller.setView({ ...VIEW_BOTTOM, lastFullyVisibleId: 'm3' })
  const savedCursor = first.state.cursor
  assert.equal(savedCursor, 'm3')
  // "重启":新控制器从持久层恢复游标,期间新到了两条消息
  const second = makeController(savedCursor)
  second.controller.setEntries([...entries, actor('m4', 'B'), actor('m5', 'C')], 'initial')
  const snap = second.controller.getSnapshot()
  assert.equal(snap.unreadCount, 2, '只把游标之后的消息算未读')
  assert.equal(snap.firstUnreadId, 'm4')
  // 单角色连续消息:无定向 → 普通文案
  assert.equal(snap.label, '2 条新消息')
})
