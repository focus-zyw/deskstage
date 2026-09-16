// 聊天回复情绪标签(方案 docs/自由聊天情绪标签设计方案.md):
// 解析容错(主格式/笔误/未知标签/多次出现)/剥除不伤正文/action 与情绪增量映射/
// actorSchema 接入(plain 直答标签→action 落库干净;schema 群聊 text 残渣剥除先于截断)。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let moodTag
let actorSchema

before(async () => {
  moodTag = await import('../src/engine/moodTag.ts')
  actorSchema = await import('../src/groupChat/actorSchema.ts')
})

const batch = () => ({ id: 'b1', throughSeq: 3, messages: [{ id: 'm1' }, { id: 'm2' }] })

// ---------- 解析与剥除 ----------

test('主格式 <mood:X> 解析:剥除标签、正文干净、白名单命中', () => {
  const p = moodTag.parseMoodTag('真的吗!太好了<mood:laugh>')
  assert.equal(p.text, '真的吗!太好了')
  assert.equal(p.tag, 'laugh')
})

test('标签在句中也能剥:正文不受损,多余空白 trim', () => {
  const p = moodTag.parseMoodTag('<mood:happy> 早上好呀,今天也要加油 <mood:happy>')
  assert.equal(p.text, '早上好呀,今天也要加油')
  assert.equal(p.tag, 'happy')
})

test('多次出现取最后一个合法值;未知值剥除但不映射', () => {
  const p = moodTag.parseMoodTag('嗯。<mood:sad> 不对,是开心!<mood:happy>')
  assert.equal(p.tag, 'happy')
  const bad = moodTag.parseMoodTag('随便聊聊<mood:proud>')
  assert.equal(bad.tag, null)
  assert.equal(bad.text, '随便聊聊')
})

test('笔误形式 <X> 只认白名单词:非白名单的 <> 绝不误吞(如 <think>)', () => {
  assert.equal(moodTag.parseMoodTag('害羞死了<shy>').tag, 'shy')
  assert.equal(moodTag.parseMoodTag('好累啊<Sleepy>').tag, 'sleepy')
  const think = moodTag.parseMoodTag('<think>推理中</think>答案是 4')
  assert.equal(think.tag, null)
  assert.equal(think.text, '<think>推理中</think>答案是 4')
})

test('大小写与空格容错;mood 形残渣无论白名单与否一律剥除', () => {
  const p = moodTag.parseMoodTag('来啦<MOOD : ANGRY >')
  assert.equal(p.tag, 'angry')
  assert.equal(moodTag.stripMoodTag('好的<mood:sleepy>'), '好的')
  assert.equal(moodTag.stripMoodTag('好的<mood:proud>'), '好的')
})

test('无标签/null/undefined 输入原样返回', () => {
  assert.deepEqual(moodTag.parseMoodTag('普通一句话'), { text: '普通一句话', tag: null })
  assert.equal(moodTag.stripMoodTag(undefined), '')
})

// ---------- 词表映射 ----------

test('emotionActionOf:白名单原样,未知/空/talk 归一 talk', () => {
  assert.equal(moodTag.emotionActionOf('laugh'), 'laugh')
  assert.equal(moodTag.emotionActionOf('shy'), 'shy')
  assert.equal(moodTag.emotionActionOf('talk'), 'talk')
  assert.equal(moodTag.emotionActionOf('proud'), 'talk')
  assert.equal(moodTag.emotionActionOf(undefined), 'talk')
  assert.equal(moodTag.emotionActionOf(''), 'talk')
})

test('moodDeltaOfAction:情绪动作给增量,talk/未知返回 null(无标签不漂移)', () => {
  assert.deepEqual(moodTag.moodDeltaOfAction('angry'), { dValence: -0.8, dEnergy: 0.4 })
  assert.deepEqual(moodTag.moodDeltaOfAction('laugh'), { dValence: 0.6, dEnergy: 0.4 })
  assert.equal(moodTag.moodDeltaOfAction('talk'), null)
  assert.equal(moodTag.moodDeltaOfAction('jump'), null)
  // 词表动作与标签一一对应,增量单笔不超过 moodState 的事件钳位
  for (const id of Object.keys(moodTag.MOOD_TAG_TABLE)) {
    const row = moodTag.MOOD_TAG_TABLE[id]
    assert.ok(Math.abs(row.dValence) <= 2 && Math.abs(row.dEnergy) <= 2, id)
    assert.ok(row.action && row.action !== 'talk', id)
  }
})

test('提示词规则文本:含白名单出口与"平淡不加"约束', () => {
  assert.match(moodTag.MOOD_TAG_RULE, /<mood:X>/)
  assert.match(moodTag.MOOD_TAG_RULE, /sleepy/)
  assert.match(moodTag.MOOD_TAG_RULE, /平淡.*不加|不加.*平淡/s)
})

// ---------- actorSchema 接入 ----------

test('plain 直答:标签解析为 action,落库文本干净(剥除先于截断)', () => {
  const r = actorSchema.plainSpeakReaction('真的假的?笑死我了<mood:laugh>', batch())
  assert.equal(r.decision, 'speak')
  assert.equal(r.reply.text, '真的假的?笑死我了')
  assert.equal(r.reply.action, 'laugh')
  // 无标签回落 talk
  const plain = actorSchema.plainSpeakReaction('就那样吧', batch())
  assert.equal(plain.reply.action, 'talk')
})

test('plain 直答:标签不占 600 字预算;只剩标签 = 空文本按失败退避', () => {
  const long = '啊'.repeat(600) + '<mood:happy>'
  const r = actorSchema.plainSpeakReaction(long, batch())
  assert.equal(r.reply.text.length, 600)
  assert.equal(r.reply.action, 'happy')
  assert.throws(() => actorSchema.plainSpeakReaction('<mood:happy>', batch()), /empty-text/)
})

test('schema 群聊:text 混入的标签残渣剥除(剥除先于 80 字截断),action 字段保留', () => {
  const raw = JSON.stringify({
    protocolVersion: 1,
    batchId: 'b1',
    ackThrough: 3,
    decision: 'speak',
    reply: { text: '哈哈<mood:happy>', replyTo: ['m1'], action: 'laugh' },
  })
  const r = actorSchema.parseValidReaction(raw, batch())
  assert.equal(r.reply.text, '哈哈')
  assert.equal(r.reply.action, 'laugh')
})

test('schema 群聊:剥除后不足 80 字正文按剥除后长度计(标签不吃台词预算)', () => {
  const body = '字'.repeat(78)
  const raw = JSON.stringify({
    protocolVersion: 1,
    batchId: 'b1',
    ackThrough: 3,
    decision: 'speak',
    reply: { text: body + '<mood:sleepy>', replyTo: [], action: 'sleepy' },
  })
  const r = actorSchema.parseValidReaction(raw, batch())
  assert.equal(r.reply.text, body)
  assert.equal(r.reply.action, 'sleepy')
})
