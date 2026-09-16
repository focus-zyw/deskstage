// 聊天房间化纯函数:filterTurnsBySession(房间过滤,无 sessionId 归群聊)+
// summarizeConversations(按房间聚合最后一条,时间降序)+ 房间 id 约定。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  directSessionId,
  filterTurnsBySession,
  GROUP_SESSION_ID,
  summarizeConversations,
} from '../src/storage/chatLogStore'

const entry = (over) => ({
  ts: 1,
  who: 'user',
  text: 'x',
  ...over,
})

test('filterTurnsBySession:精确匹配,无 sessionId 归群聊房间', () => {
  const turns = [
    entry({ text: '群聊消息', sessionId: 'group:main' }),
    entry({ text: '旧插话(无 sessionId)' }),
    entry({ text: '单聊A', sessionId: 'direct:A' }),
    entry({ text: '单聊B', sessionId: 'direct:B' }),
  ]
  const group = filterTurnsBySession(turns, GROUP_SESSION_ID)
  assert.deepEqual(
    group.map((t) => t.text),
    ['群聊消息', '旧插话(无 sessionId)'],
  )
  const directA = filterTurnsBySession(turns, 'direct:A')
  assert.deepEqual(directA.map((t) => t.text), ['单聊A'])
  assert.equal(filterTurnsBySession(turns, 'direct:C').length, 0)
})

test('summarizeConversations:每间房取最后一条,时间降序', () => {
  const summaries = summarizeConversations([
    entry({ ts: 100, who: 'user', text: '群聊第一条', sessionId: 'group:main' }),
    entry({ ts: 300, who: 'A', text: '单聊最新一句', sessionId: 'direct:A' }),
    entry({ ts: 200, who: 'A', text: '群聊最新一句', sessionId: 'group:main' }),
    entry({ ts: 150, who: 'B', text: '单聊旧一句', sessionId: 'direct:A' }),
  ])
  assert.deepEqual(
    summaries.map((s) => [s.sessionId, s.text]),
    [
      ['direct:A', '单聊最新一句'],
      ['group:main', '群聊最新一句'],
    ],
  )
})

test('directSessionId:direct:<slot> 约定', () => {
  assert.equal(directSessionId('B'), 'direct:B')
})
