// 诊断状态中心(diag/store)行为测试。回归目标:白名单事件归组、详情捕获门控
// (默认档零正文)、环淘汰、派生结论(未说话原因/回退链/取消泄漏/错误分类)、
// 导出筛选。隐私红线:detail_text 是唯一正文通道且必须先经 redact/scrub。
import assert from 'node:assert/strict'
import { before, beforeEach, test } from 'node:test'

let store
let types

before(async () => {
  const mem = new Map()
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
    clear: () => mem.clear(),
  }
  store = await import('../src/diag/store.ts')
  types = await import('../src/diag/types.ts')
})


beforeEach(() => {
  store.resetDiagForTest()
})

function eventsOf(id) {
  const s = store.getDiagSnapshot().sessions.find((x) => x.id === id)
  return s ? s.events : []
}

test('beginTurn 记录输入结构(零正文):长度/语言/指纹/target,文本本体不入环', () => {
  const id = store.diag.beginTurn({ id: 't1', source: 'voice', text: '今天天气怎么样', target: 'A', voice: true })
  const evs = eventsOf(id)
  const started = evs.find((e) => e.kind === 'turn_started')
  assert.equal(started.inputChars, 7)
  assert.equal(started.language, 'zh')
  assert.ok(started.fingerprint.startsWith('fp:'))
  assert.equal(started.voice, true)
  assert.ok(!JSON.stringify(store.getDiagSnapshot()).includes('今天天气怎么样'))
})

test('beginTurn 透传 room(群聊/单聊区分),fallback 支持 actor 来源', () => {
  const g = store.diag.beginTurn({ id: 'g1', source: 'chat', text: 'x', room: 'group:main' })
  const d = store.diag.beginTurn({ id: 'd1', source: 'chat', text: 'x', room: 'direct:A' })
  const snap = store.getDiagSnapshot()
  assert.equal(snap.sessions.find((x) => x.id === g).room, 'group:main')
  assert.equal(snap.sessions.find((x) => x.id === d).room, 'direct:A')
  // actors 引擎的失败退避/停用走 from:'actor'
  store.diag.fallback('g1', { call: 'groupActor', from: 'actor', reason: '模型调用失败 → 停用' })
  const evs = store.getDiagSnapshot().sessions.find((x) => x.id === g).events
  assert.equal(evs.find((e) => e.kind === 'fallback').from, 'actor')
})

test('未知会话 id 的事件被静默丢弃,零抛错', () => {
  assert.doesNotThrow(() => {
    store.diag.llmStarted('no-such-turn', {
      call: 'turnBatch',
      transport: 'api',
      promptChars: 100,
      systemChars: 50,
      userChars: 20,
      contextLines: 3,
    })
    store.diag.detailText('no-such-turn', { textKind: 'input', text: '任何文本' })
  })
  assert.equal(store.getDiagSnapshot().sessions.length, 0)
})

test('详情门控:未捕获时 detail_text 整体关闭;捕获后入库且必经脱敏', () => {
  const id1 = store.diag.beginTurn({ id: 't1', source: 'chat', text: 'hi' })
  store.diag.detailText(id1, { textKind: 'input', text: '我手机 13812345678' })
  assert.equal(eventsOf(id1).filter((e) => e.kind === 'detail_text').length, 0)

  store.armDetail({ once: true })
  const id2 = store.diag.beginTurn({ id: 't2', source: 'chat', text: 'hi' })
  assert.equal(store.getDiagSnapshot().sessions.find((s) => s.id === 't2').hasDetail, true)
  store.diag.detailText(id2, { textKind: 'input', text: '我手机 13812345678' })
  const detail = eventsOf(id2).find((e) => e.kind === 'detail_text')
  assert.ok(detail)
  assert.ok(!detail.text.includes('13812345678'))
  assert.ok(detail.text.includes('[PHONE]'))
  assert.equal(detail.rawChars, '我手机 13812345678'.length)
})

test('详情档捕获 prompt 编译结果:掩码 + 保头保尾截断;默认档不入库', () => {
  store.armDetail({ once: true })
  const id = store.diag.beginTurn({ id: 'p1', source: 'chat', text: 'hi' })
  const big =
    '系统协议段,只能输出JSON。'.repeat(200) +
    '中间段本段应被掐掉。'.repeat(100) +
    '结尾用户消息 联系 13812345678 请遵守协议。'.repeat(30)
  store.diag.detailText(id, { textKind: 'prompt', text: big })
  const ev = eventsOf(id).find((e) => e.kind === 'detail_text')
  assert.ok(ev, '详情档应入库 prompt 编译结果')
  assert.ok(!ev.text.includes('13812345678'), '手机号必须被掩码')
  assert.ok(ev.text.includes('[PHONE]'), '尾部的手机号应掩码为 [PHONE]')
  assert.ok(!ev.text.includes('中间段本段应被掐掉'), '中段应被丢弃')
  assert.ok(ev.text.includes('中略'), '超长 prompt 应掐中段')
  assert.ok(ev.text.includes('原文 ' + big.length + ' 字符'), '截断标记记原长')
  assert.ok(ev.text.startsWith('系统协议段'), '头部(人设/协议)保留')
  assert.ok(ev.text.includes('请遵守协议'), '尾部(协议尾/用户消息)保留')
  assert.equal(ev.rawChars, big.length)
})

test('once 模式:会话定稿后详情捕获自动关闭', () => {
  store.armDetail({ once: true })
  assert.equal(store.getDetailState().armed, true)
  const id = store.diag.beginTurn({ id: 't1', source: 'chat', text: 'x' })
  store.diag.turnFinished(id, { outcome: 'spoke', totalMs: 10, replyChars: 1, replySentences: 1 })
  store.finishDiag(id)
  assert.equal(store.getDetailState().armed, false)
})

test('deriveSummary:无声原因(tts 被压制/勿扰)', () => {
  const id = store.diag.beginTurn({ id: 't1', source: 'voice', text: '在吗' })
  store.diag.ttsRequest(id, { seg: 0, speaker: 'A', chars: 10, channel: 'voice', epoch: 1 })
  store.diag.ttsSegment(id, { seg: 0, epoch: 1, outcome: 'demoted', reason: '被在播的 proactive 压制' })
  store.diag.turnFinished(id, { outcome: 'silent', totalMs: 900, replyChars: 10, replySentences: 1 })
  const s = store.getDiagSnapshot().sessions.find((x) => x.id === 't1').summary
  assert.equal(s.outcome, 'silent')
  assert.ok(s.noSpeechReason.includes('proactive'))
})

test('deriveSummary:回退链(网页版失败回落 API)——回退成功不挂错误章', () => {
  const id = store.diag.beginTurn({ id: 't1', source: 'performance', text: '来段相声' })
  store.diag.llmStarted(id, { call: 'dialog', transport: 'webchat', promptChars: 500, systemChars: 300, userChars: 100, contextLines: 0 })
  store.diag.llmFinished(id, { call: 'dialog', transport: 'webchat', ok: false, elapsedMs: 2000, outputChars: 0, errorKind: 'cdp', serverMsg: 'send 超时' })
  store.diag.fallback(id, { call: 'dialog', from: 'webchat', reason: '网页生成失败(HTTP 500)' })
  store.diag.llmStarted(id, { call: 'dialog', transport: 'api', promptChars: 500, systemChars: 300, userChars: 100, contextLines: 0 })
  store.diag.llmFinished(id, { call: 'dialog', transport: 'api', ok: true, elapsedMs: 1500, outputChars: 200 })
  store.diag.turnFinished(id, { outcome: 'spoke', totalMs: 4000, replyChars: 200, replySentences: 2 })
  const s = store.getDiagSnapshot().sessions.find((x) => x.id === 't1').summary
  assert.equal(s.fallbacks.length, 1)
  assert.equal(s.fallbacks[0].from, 'webchat')
  assert.ok(s.fallbacks[0].reason.includes('网页生成失败'))
  // 回退后成功:错误不是最终状态 → 不挂错误章(回退链已可见)
  assert.equal(s.errorKind, undefined)
  assert.equal(s.outcome, 'spoke')
})

test('deriveSummary:错误是最终状态才挂章(重试成功 vs 最终失败)', () => {
  const retry = store.diag.beginTurn({ id: 'retry', source: 'chat', text: 'x' })
  store.diag.llmFinished(retry, { call: 'turnBatch', transport: 'api', ok: false, elapsedMs: 10, outputChars: 0, errorKind: 'http', status: 500 })
  store.diag.llmFinished(retry, { call: 'singleReply', transport: 'api', ok: true, elapsedMs: 20, outputChars: 8 })
  store.diag.turnFinished(retry, { outcome: 'spoke', totalMs: 40, replyChars: 8, replySentences: 1 })
  assert.equal(store.getDiagSnapshot().sessions.find((x) => x.id === 'retry').summary.errorKind, undefined)

  const dead = store.diag.beginTurn({ id: 'dead', source: 'chat', text: 'x' })
  store.diag.llmFinished(dead, { call: 'turnBatch', transport: 'api', ok: true, elapsedMs: 10, outputChars: 0 })
  store.diag.llmFinished(dead, { call: 'singleReply', transport: 'api', ok: false, elapsedMs: 20, outputChars: 0, errorKind: 'network' })
  store.diag.turnFinished(dead, { outcome: 'failed', totalMs: 50, replyChars: 0, replySentences: 0 })
  const s = store.getDiagSnapshot().sessions.find((x) => x.id === 'dead').summary
  assert.equal(s.errorKind, 'network')
  assert.ok(s.noSpeechReason.includes('network'))
})

test('deriveSummary:取消后仍出声(cancelLeak)与正常取消', () => {
  const leakId = store.diag.beginTurn({ id: 'leak', source: 'voice', text: '讲个故事' })
  store.diag.ttsRequest(leakId, { seg: 1, speaker: 'A', chars: 20, channel: 'voice', epoch: 5 })
  store.diag.cancelRequested(leakId, { generation: 3, hadHandle: true, hadAbort: true })
  store.diag.ttsStopped(leakId, { trigger: 'cancel', hadActiveSession: true, activeChannel: 'voice', epochBefore: 5, epochAfter: 6 })
  // 取消之后才出声的段:泄漏
  store.diag.ttsSegment(leakId, { seg: 1, epoch: 5, outcome: 'played', audibleAt: Date.now(), playbackMs: 800 })
  const leakSummary = store.getDiagSnapshot().sessions.find((x) => x.id === 'leak').summary
  assert.equal(leakSummary.cancelLeak, true)

  const okId = store.diag.beginTurn({ id: 'ok', source: 'voice', text: '讲个故事' })
  store.diag.ttsRequest(okId, { seg: 0, speaker: 'A', chars: 20, channel: 'voice', epoch: 7 })
  store.diag.ttsSegment(okId, { seg: 0, epoch: 7, outcome: 'played', audibleAt: Date.now() - 5000, playbackMs: 900 })
  store.diag.cancelRequested(okId, { generation: 1, hadHandle: true, hadAbort: true })
  const okSummary = store.getDiagSnapshot().sessions.find((x) => x.id === 'ok').summary
  assert.equal(okSummary.cancelLeak, false)
})

test('deriveSummary:错误分类与首 token 延迟', () => {
  const id = store.diag.beginTurn({ id: 't1', source: 'chat', text: '你好' })
  store.diag.llmStarted(id, { call: 'turnBatch', transport: 'api', promptChars: 1000, systemChars: 600, userChars: 100, contextLines: 8, timeoutMs: 12000 })
  store.diag.llmFirstToken(id, { call: 'turnBatch', transport: 'api', ms: 730 })
  store.diag.llmFinished(id, { call: 'turnBatch', transport: 'api', ok: false, elapsedMs: 12000, outputChars: 0, errorKind: 'timeout' })
  store.diag.turnFinished(id, { outcome: 'failed', totalMs: 12500, replyChars: 0, replySentences: 0 })
  const s = store.getDiagSnapshot().sessions.find((x) => x.id === 't1').summary
  assert.equal(s.errorKind, 'timeout')
  assert.equal(s.firstTokenMs, 730)
  assert.ok(s.noSpeechReason.includes('timeout'))
})

test('会话环淘汰:上限 60,最老先出;迟到事件在 finish 后仍更新总结论', () => {
  for (let i = 0; i < 61; i++) {
    store.diag.beginTurn({ id: `t${i}`, source: 'chat', text: `m${i}` })
  }
  const snap = store.getDiagSnapshot()
  assert.equal(snap.sessions.length, 60)
  assert.ok(!snap.sessions.some((s) => s.id === 't0'))
  assert.ok(snap.sessions.some((s) => s.id === 't60'))
  // 迟到的后台记忆写入:finish 后仍计入 summary
  store.diag.memoryWrite('t60', { candidates: 2, changed: 1, addedIds: ['f1'], supersededIds: [], rejected: 1, ms: 30 })
  const s = store.getDiagSnapshot().sessions.find((x) => x.id === 't60')
  assert.equal(s.summary.memoryWritten, 1)
})

test('详情会话上限 20:最老的详情会话被裁掉,基础会话不受影响', () => {
  store.armDetail({ minutes: 10 })
  for (let i = 0; i < 25; i++) {
    const id = store.diag.beginTurn({ id: `d${i}`, source: 'chat', text: `x${i}` })
    store.diag.detailText(id, { textKind: 'input', text: `内容${i}` })
  }
  const snap = store.getDiagSnapshot()
  const detailSessions = snap.sessions.filter((s) => s.hasDetail)
  assert.equal(detailSessions.length, 20)
  assert.ok(!detailSessions.some((s) => s.id === 'd0'))
  assert.ok(detailSessions.some((s) => s.id === 'd24'))
  store.disarmDetail()
})

test('事件环上限:单会话 400 事件封顶,不再增长', () => {
  const id = store.diag.beginTurn({ id: 't1', source: 'chat', text: 'x' })
  for (let i = 0; i < 500; i++) {
    store.diag.actionFired(id, { speaker: 'A', action: 'talk' })
  }
  assert.equal(eventsOf(id).length, 400)
})

test('exportDiagJson:默认剔除正文,可选包含;隐私清单随档位标注', () => {
  store.armDetail({ once: true })
  const id = store.diag.beginTurn({ id: 't1', source: 'chat', text: '秘密' })
  store.diag.detailText(id, { textKind: 'input', text: '秘密内容' })
  const basic = JSON.parse(store.exportDiagJson({ includeDetailText: false }))
  assert.equal(basic.sessions[0].events.filter((e) => e.kind === 'detail_text').length, 0)
  assert.ok(basic.privacy.excluded.some((x) => x.includes('API Key')))
  const full = JSON.parse(store.exportDiagJson({ includeDetailText: true }))
  assert.equal(full.sessions[0].events.filter((e) => e.kind === 'detail_text').length, 1)
})

test('事件类型协议:所有事件只有白名单 kind', () => {
  const id = store.diag.beginTurn({ id: 't1', source: 'chat', text: 'x' })
  store.diag.llmStarted(id, { call: 'turnBatch', transport: 'api', promptChars: 1, systemChars: 1, userChars: 1, contextLines: 0 })
  store.diag.llmFinished(id, { call: 'turnBatch', transport: 'api', ok: true, elapsedMs: 5, outputChars: 2 })
  store.diag.turnFinished(id, { outcome: 'spoke', totalMs: 5, replyChars: 2, replySentences: 1 })
  const known = new Set(
    types.DiagEvent ? [] : [
      'turn_started', 'turn_finished', 'llm_started', 'llm_first_token', 'llm_first_sentence',
      'llm_finished', 'fallback', 'webchat_stages', 'tts_request', 'tts_segment', 'tts_stopped',
      'cancel_requested', 'action_fired', 'memory_selection', 'memory_write', 'asr_result', 'detail_text',
    ],
  )
  const allow = known.size === 0 ? new Set([
    'turn_started', 'turn_finished', 'llm_started', 'llm_first_token', 'llm_first_sentence',
    'llm_finished', 'fallback', 'webchat_stages', 'tts_request', 'tts_segment', 'tts_stopped',
    'cancel_requested', 'action_fired', 'memory_selection', 'memory_write', 'asr_result', 'detail_text',
  ]) : known
  for (const ev of eventsOf(id)) assert.ok(allow.has(ev.kind), `未知事件 kind: ${ev.kind}`)
})

test('setDiagUpsert:增量回调按 dirty 会话推送,finish 即时推送,full 清空', () => {
  const pushed = []
  store.setDiagUpsert((p) => pushed.push(p))
  const id = store.diag.beginTurn({ id: 't1', source: 'chat', text: 'x' })
  store.diag.turnFinished(id, { outcome: 'spoke', totalMs: 1, replyChars: 1, replySentences: 1 })
  store.finishDiag(id)
  const upserts = pushed.filter((p) => !p.full)
  assert.ok(upserts.length >= 1)
  assert.ok(upserts.some((p) => p.sessions.some((s) => s.id === 't1' && s.ended)))
  store.clearDiag()
  assert.ok(pushed.some((p) => p.full))
  assert.equal(store.getDiagSnapshot().sessions.length, 0)
  store.setDiagUpsert(null)
})
