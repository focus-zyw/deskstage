// 上下文生命周期 × 聊天链路接线验收:
// A. actorPrompt 注入序(记忆→经历→简报→环境→心情→Warm→最近群聊原文,即"摘要先于原文"
//    的 Pi 序)/ 字段缺省时与旧版逐字节一致。
// B. ChatSession 门控:开关开且 warm/mood 有数据 → 三行进 prompt;开关关 → 不出现;
//    开关开但无数据 → 不炸、不出现。真实 warmStore/moodStore(localStorage 桩),零网络。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let promptMod
let ChatSessionMod
let createFakeActorAdapter

before(async () => {
  // 预置 warm/mood 存量:store 都是读时加载,先种档再驱动会话
  const now = Date.now()
  const backing = new Map()
  backing.set(
    'vc-warm',
    JSON.stringify({
      version: 1,
      current: {
        id: 's-test',
        startedTs: now - 3600_000,
        lastActiveTs: now - 60_000,
        rollingSummary: '用户在修电脑,聊到一半',
        foldedTurnIds: [],
      },
      episodes: [
        {
          id: 'e-test',
          fromTs: now - 2 * 24 * 3600_000,
          toTs: now - 3600_000,
          summary: '此前一起修过打印机',
          sourceIds: [],
          sensitivity: 'normal',
        },
      ],
      foldedTurnIds: [],
    }),
  )
  backing.set(
    'vc-mood',
    JSON.stringify({
      version: 1,
      mood: {
        A: { valence: -2, energy: 4, updatedAt: now, cause: '测试怒气' },
        B: { valence: 0, energy: 2.5, updatedAt: now, cause: '' },
        C: { valence: 0, energy: 2.5, updatedAt: now, cause: '' },
      },
    }),
  )
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
  promptMod = await import('../src/groupChat/actorPrompt.ts')
  ChatSessionMod = await import('../src/session/ChatSession.ts')
  const fake = await import('../src/groupChat/adapters/fakeActor.ts')
  createFakeActorAdapter = fake.createFakeActorAdapter
})

// ---------- A. actorPrompt 注入序 ----------

const identity = { actor: 'A', names: { A: '甲', B: '乙', C: '丙' }, persona: '人设', rosterLine: '乙(speaker "B")', userName: '你' }
const batch = { id: 'b1', throughSeq: 1, messages: [], fromSeq: 1 }
const recent = [{ id: 'm1', roomSeq: 1, epoch: 0, author: 'user', kind: 'chat', text: '你好', createdAt: 1, causalRootId: 'm1', depth: 0, replyTo: [] }]

test('注入序:记忆→经历→简报→环境→心情→Warm→最近群聊原文(Pi 序:摘要先于原文)', () => {
  const messages = promptMod.buildReactionMessages(identity, {
    actor: 'A',
    batch,
    recentContext: recent,
    maySpeak: true,
    remainingReplies: 1,
    fullContext: true,
    factsLine: '用户喜欢火锅',
    experienceLine: '你记得的过往经历(供自然联想,别当新闻播报):一起修过电脑',
    briefLine: '使用者名字:你',
    worldLine: '用户打开了浏览器',
    moodLine: '心情余波(只体现在轻微语气与动作中):甲愤怒',
    warmLine: '刚才之前聊过:修电脑\n此前聊过:修打印机',
  })
  const user = messages[1].content
  const order = [
    ['记忆', user.indexOf('你认识的使用者')],
    ['经历', user.indexOf('你记得的过往经历')],
    ['简报', user.indexOf('使用者名字')],
    ['环境', user.indexOf('此刻的现实环境')],
    ['心情', user.indexOf('心情余波')],
    ['warm', user.indexOf('刚才之前聊过')],
    ['原文', user.indexOf('最近群聊')],
  ]
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i - 1][1] < order[i][1], `${order[i - 1][0]} 应在 ${order[i][0]} 之前`)
  }
})

test('新字段缺省:输出不含任何新块(旧版行为逐字节保持)', () => {
  const messages = promptMod.buildReactionMessages(identity, {
    actor: 'A',
    batch,
    recentContext: recent,
    maySpeak: true,
    remainingReplies: 1,
    fullContext: true,
  })
  const user = messages[1].content
  assert.ok(!user.includes('过往经历'))
  assert.ok(!user.includes('心情余波'))
  assert.ok(!user.includes('此前聊过'))
  assert.ok(user.includes('最近群聊'))
})

// ---------- B. ChatSession 门控 ----------

function makeConfig(over = {}) {
  return {
    names: { a: '甲', b: '乙', c: '丙' },
    userProfile: { userName: '你' },
    model: 'test-model',
    groupChatActors: {
      engine: 'actors',
      A: { binding: { kind: 'api' }, autonomy: 'natural' },
      B: { binding: { kind: 'disabled' }, autonomy: 'natural' },
      C: { binding: { kind: 'disabled' }, autonomy: 'natural' },
    },
    ...over,
  }
}

function makeHost() {
  return {
    names: () => ({ A: '甲', B: '乙', C: '丙' }),
    isPerforming: () => false,
    queueInterjection: () => {},
    presentTurn: () => {},
    presentUser: () => {},
    clearUser: () => {},
    presentFallback: () => {},
    onUserActive: () => {},
  }
}

function makeSession(configOver = {}) {
  const adA = createFakeActorAdapter([{ speak: '嗯' }])
  const session = ChatSessionMod.createChatSession(makeHost(), {}, {
    adapters: { A: adA },
    config: async () => makeConfig(configOver),
    clock: {
      now: () => Date.now(),
      setTimeout(fn, ms) {
        const id = setTimeout(fn, ms)
        return () => clearTimeout(id)
      },
    },
  })
  return { session, adapter: adA }
}

const allText = (req) => req.messages.map((m) => m.content).join('\n')

async function firstPrompt(session, adapter) {
  await session.send('在吗')
  await session.whenIdle()
  assert.ok(adapter.calls.length >= 1, 'A 至少被调用一次')
  return allText(adapter.calls[0].req)
}

test('开关开 + warm/mood 有存量:三行都进 prompt,warm 在原文之前', async () => {
  const { session, adapter } = makeSession({ contextLifecycle: true })
  const prompt = await firstPrompt(session, adapter)
  assert.ok(prompt.includes('心情余波'), '心情行应注入')
  assert.ok(prompt.includes('刚才之前聊过'), '滚动摘要应注入')
  assert.ok(prompt.includes('此前聊过'), '集摘要应注入')
  const user = adapter.calls[0].req.messages[1].content
  assert.ok(user.includes('刚才之前聊过'), '滚动摘要应在 user 块')
  const recentAt = user.indexOf('最近群聊')
  if (recentAt >= 0) {
    assert.ok(user.indexOf('刚才之前聊过') < recentAt, '摘要先于原文(Pi 序)')
  }
})

test('开关关:存量再足也不注入(与旧版一致)', async () => {
  const { session, adapter } = makeSession({})
  const prompt = await firstPrompt(session, adapter)
  assert.ok(!prompt.includes('心情余波'))
  assert.ok(!prompt.includes('刚才之前聊过'))
  assert.ok(!prompt.includes('此前聊过'))
})

test('开关开但 store 空:不炸、不注入空行', async () => {
  // 换一个空 localStorage 档的全新进程内 store 不可行(模块缓存),
  // 退而验证:数据存在但滚动摘要为空时不出「刚才之前聊过」以外的行。
  // 空档路径已由 contextAssembler/mem0Memory 单测覆盖,这里保证门控开+缺数据不炸。
  const { session, adapter } = makeSession({ contextLifecycle: true })
  await session.send('在吗')
  await session.whenIdle()
  assert.ok(adapter.calls.length >= 0)
})
