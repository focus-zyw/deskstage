// 聊天 @ 补全纯函数回归:语境判定/候选过滤/插入替换(见 src/ui/mention.ts 头注释)。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let mention

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  mention = await server.ssrLoadModule('/src/ui/mention.ts')
})

after(async () => {
  await server?.close()
})

test('语境判定:@紧邻光标即开启,空格/删@即关闭', () => {
  assert.deepEqual(mention.mentionContext('你好@'), { query: '' })
  assert.deepEqual(mention.mentionContext('你好@乙'), { query: '乙' })
  assert.equal(mention.mentionContext('你好@乙 '), null) // 敲了空格
  assert.equal(mention.mentionContext('你好乙'), null) // 没有 @
  assert.equal(mention.mentionContext(''), null)
  // 只看光标前的部分:@ 在光标后不算语境
  assert.deepEqual(mention.mentionContext('@'), { query: '' })
})

test('候选清单用自定义名,缺省回落字母', () => {
  assert.deepEqual(
    mention.mentionTargets({ A: '大米', B: '小米', C: '' }).map((t) => `${t.id}:${t.name}`),
    ['A:大米', 'B:小米', 'C:C'],
  )
})

test('过滤:名字包含不区分大小写,字母前缀命中,无匹配为空', () => {
  const targets = mention.mentionTargets({ A: '大米', B: '小米', C: '丙丙' })
  assert.deepEqual(mention.filterMentionTargets(targets, '').length, 3)
  assert.deepEqual(mention.filterMentionTargets(targets, '米').map((t) => t.id), ['A', 'B'])
  assert.deepEqual(mention.filterMentionTargets(targets, 'a').map((t) => t.id), ['A']) // 字母前缀
  assert.deepEqual(mention.filterMentionTargets(targets, '丙').map((t) => t.id), ['C'])
  assert.deepEqual(mention.filterMentionTargets(targets, '不存在'), [])
})

test('applyMention:替换 @过滤词 为 @全名+空格,光标落到空格后', () => {
  // "你好@乙" 光标在末尾,选"小乙" → "你好@小乙 ␣"
  const r = mention.applyMention('你好@乙', 4, '小乙')
  assert.equal(r.text, '你好@小乙 ')
  assert.equal(r.caret, '你好@小乙 '.length)
  // 光标在中间:只替换光标前的片段,后面的文字保留
  const mid = mention.applyMention('@甲在吗', 2, '大米')
  assert.equal(mid.text, '@大米 在吗')
  assert.equal(mid.caret, '@大米 '.length)
  // 无 @ 语境(防御兜底):在光标处直接插入
  const plain = mention.applyMention('在吗', 2, '丙丙')
  assert.equal(plain.text, '在吗@丙丙 ')
})
