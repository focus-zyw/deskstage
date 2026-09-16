// 招牌怪癖系统验收矩阵(设计方案 §4/§5/§8):配额规则/随机替换/锁定上限/
// 落盘数据修复/输出解析/生成 prompt 组装/演出注入渲染/开关关回归。
// 纯函数为主,假依赖注入,零 IO 零模型。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let mod

before(async () => {
  mod = await import('../src/quirks/index.ts')
})


const entry = (id, valence, extra = {}) => ({
  id,
  trigger: `触发${id}`,
  behavior: `行为${id}`,
  valence,
  type: '触发式',
  cause: '',
  causeType: 'inferred',
  source: 'cold',
  locked: false,
  createdAtEp: 0,
  lastUsedEp: -1,
  ...extra,
})

const bookWith = (slot, entries) => ({ A: [], B: [], C: [], [slot]: entries })

// ---------- 配额与替换(§3 纯规则) ----------

test('未满配额时直接追加', () => {
  const book = bookWith('A', [entry('r1', 'red')])
  const r = mod.insertQuirk(book, 'A', entry('r2', 'red'))
  assert.equal(r.ok, true)
  assert.equal(r.replaced, null)
  assert.equal(r.book.A.length, 2)
})

test('同价态满 5 时从未锁定者中随机替换;锁定者幸存', () => {
  const five = [
    entry('r1', 'red'),
    entry('r2', 'red'),
    entry('r3', 'red'),
    entry('r4', 'red'),
    entry('r5', 'red', { locked: true }),
  ]
  const book = bookWith('A', five)
  // rng=0 → 未锁定者[r1..r4]中取首个
  const r = mod.insertQuirk(book, 'A', entry('new', 'red'), () => 0)
  assert.equal(r.ok, true)
  assert.equal(r.replaced.id, 'r1')
  assert.equal(r.book.A.length, 5)
  assert.ok(r.book.A.some((q) => q.id === 'new'))
  assert.ok(r.book.A.some((q) => q.id === 'r5' && q.locked), '锁定者不被替换')
  assert.ok(!r.book.A.some((q) => q.id === 'r1'))
})

test('同价态全部锁定时拒绝插入,不跨价态顶替', () => {
  const five = [1, 2, 3, 4, 5].map((i) => entry(`r${i}`, 'red', { locked: true }))
  const r = mod.insertQuirk(bookWith('A', five), 'A', entry('new', 'red'))
  assert.deepEqual(r, { ok: false, reason: 'valence-full-locked' })
})

test('红/蓝配额独立:红满不阻塞蓝插入', () => {
  const fiveRed = [1, 2, 3, 4, 5].map((i) => entry(`r${i}`, 'red'))
  const book = bookWith('A', fiveRed)
  const r = mod.insertQuirk(book, 'A', entry('b1', 'blue'))
  assert.equal(r.ok, true)
  assert.equal(r.book.A.filter((q) => q.valence === 'blue').length, 1)
})

test('每价态锁定上限 3:第 4 条拒绝;解锁后可再锁;蓝色独立计数', () => {
  const book = bookWith('A', [1, 2, 3, 4].map((i) => entry(`r${i}`, 'red')))
  let cur = book
  for (const id of ['r1', 'r2', 'r3']) {
    const r = mod.setQuirkLocked(cur, 'A', id, true)
    assert.equal(r.ok, true)
    cur = r.book
  }
  assert.equal(mod.setQuirkLocked(cur, 'A', 'r4', true).ok, false)
  // 蓝色不受红色锁数影响
  const withBlue = mod.insertQuirk(cur, 'A', entry('b1', 'blue'))
  assert.equal(mod.setQuirkLocked(withBlue.book, 'A', 'b1', true).ok, true)
  // 解锁后可再锁
  const unlocked = mod.setQuirkLocked(cur, 'A', 'r1', false)
  assert.equal(unlocked.ok, true)
  assert.equal(mod.setQuirkLocked(unlocked.book, 'A', 'r4', true).ok, true)
})

test('清除只删目标条目', () => {
  const book = bookWith('A', [entry('r1', 'red'), entry('b1', 'blue')])
  const next = mod.removeQuirk(book, 'A', 'r1')
  assert.equal(next.A.length, 1)
  assert.equal(next.A[0].id, 'b1')
  assert.equal(book.A.length, 2, '原册不可变')
})

// ---------- 落盘数据修复(sanitizeShape) ----------

test('落盘数据修复:同价态超 5 截断、超 3 锁解除、坏条目丢弃、负集数归零', () => {
  const sixRed = [1, 2, 3, 4, 5, 6].map((i) => entry(`r${i}`, 'red', i >= 2 ? { locked: true } : {}))
  const raw = {
    version: 1,
    episode: -3,
    quirks: { A: [...sixRed, { id: 'bad', trigger: '' }, 'junk'], B: [], C: [] },
  }
  const s = mod.sanitizeShape(raw)
  assert.equal(s.episode, 0)
  assert.equal(s.quirks.A.length, 5, 'r6 被配额截断')
  assert.equal(s.quirks.A.filter((q) => q.locked).length, 3, 'r5 的锁因超每色 3 上限被解除')
  assert.ok(!s.quirks.A.some((q) => q.id === 'bad'))
})

// ---------- 输出解析(parseQuirkJson) ----------

test('解析:容忍围栏与混杂文本,六字段齐全', () => {
  const raw = '好的,这是结果:\n```json\n{"trigger":"听到按键声","behavior":"会跟着节奏敲桌面","valence":"red","type":"触发式","causeType":"interaction","cause":"以前当打字员养成的习惯"}\n```\n以上。'
  const r = mod.parseQuirkJson(raw)
  assert.ok(r)
  assert.equal(r.trigger, '听到按键声')
  assert.equal(r.valence, 'red')
  assert.equal(r.type, '触发式')
  assert.equal(r.causeType, 'interaction')
})

test('解析:缺省容错(type/causeType/cause 给默认),触发/行为/价态严格', () => {
  const ok = mod.parseQuirkJson('{"trigger":"t","behavior":"b","valence":"blue"}')
  assert.equal(ok.type, '触发式')
  assert.equal(ok.causeType, 'inferred')
  assert.equal(ok.cause, '')
  assert.equal(mod.parseQuirkJson('{"behavior":"b","valence":"blue"}'), null, '缺 trigger 拒收')
  assert.equal(mod.parseQuirkJson('{"trigger":"t","behavior":"b","valence":"green"}'), null, '坏价态拒收')
  assert.equal(mod.parseQuirkJson('不是 JSON'), null)
})

test('解析:超长 trigger/behavior 截断到 80 字', () => {
  const long = 'x'.repeat(120)
  const r = mod.parseQuirkJson(`{"trigger":"${long}","behavior":"b","valence":"red"}`)
  assert.equal(r.trigger.length, 80)
})

test('宁缺毋滥出口:{"skip":true} 识别为 skip,带 trigger 的不算 skip', () => {
  assert.equal(mod.isSkipResponse('{"skip":true}'), true)
  assert.equal(mod.isSkipResponse('模型说:{"skip":true}'), true)
  assert.equal(mod.isSkipResponse('{"skip":true,"trigger":"夹带"}'), false, '夹带怪癖字段的不算空手')
  assert.equal(mod.isSkipResponse('{"trigger":"t","behavior":"b","valence":"red"}'), false)
  assert.equal(mod.isSkipResponse('不是 JSON'), false)
})

// ---------- 生成 prompt 组装(§4.3 纯函数) ----------

test('prompt 组装:槽位全进,空摘要给占位,反套路承重条款在', () => {
  const p = mod.buildQuirkPrompt({
    name: '小甲',
    pronoun: '她',
    persona: '女,便利店店员。精力充沛。',
    existing: [{ trigger: '听到按键声', behavior: '跟着敲桌面', valence: 'red' }],
  })
  assert.ok(p.includes('「小甲」'))
  assert.ok(p.includes('符合她人生经历'))
  assert.ok(p.includes('女,便利店店员'))
  assert.ok(p.includes('(red) 听到按键声 → 跟着敲桌面'))
  assert.ok(p.includes('(暂无)'), '近期互动/因果存档空槽占位')
  assert.ok(p.includes('放到别的五个角色身上也成立'), '§11 可迁移性测试(承重条款)')
  assert.ok(p.includes('伪具体'), '§13 直接关联约束')
  assert.ok(p.includes('不是小剧场'), '§14 反多拍表演')
  assert.ok(p.includes('不指向不知情的第三方'), '§15 反捉弄他人(神经质修正)')
  assert.ok(p.includes('不是角色世界设定的证据'), '§16 防旧怪癖架空人设')
  assert.ok(p.includes('怪癖强度纪律'), '强度纪律整块在场')
  assert.ok(p.includes('辨识度大胆'), '大胆=辨识度,非严重程度(纪律第6条)')
  assert.ok(p.includes('只有这个角色会这样'), '好怪癖判据(纪律第7条)')
  assert.ok(p.includes('以本纪律为准'), '强度纪律对前文大胆条款的优先级声明')
  assert.ok(p.includes('禁止沿用其中的物品、场景或句式'), 'few-shot 防克隆声明')
  assert.ok(p.includes('"causeType":"memory|interaction|inferred"'))
  assert.ok(p.includes('最小因果'), 'cause 定义:最小因果,不是背景故事')
})

// ---------- 演出注入渲染(§5.1 纯函数) ----------

const nameOf = (slot) => ({ A: '小甲', B: '小乙', C: '小丙' })[slot]

test('注入渲染:关闭返回空串;开而无怪癖也返回空串', () => {
  const book = bookWith('A', [entry('r1', 'red')])
  assert.equal(mod.renderQuirkBlock(book, false, nameOf, ['A']), '')
  assert.equal(mod.renderQuirkBlock({ A: [], B: [], C: [] }, true, nameOf, ['A', 'B', 'C']), '')
})

test('注入渲染:清单带角色名与五句纪律;只列启用角色', () => {
  const book = {
    A: [entry('r1', 'red')],
    B: [entry('b1', 'blue', { locked: true })],
    C: [entry('c1', 'blue')],
  }
  const block = mod.renderQuirkBlock(book, true, nameOf, ['A', 'B'])
  assert.ok(block.includes('小甲:触发r1 → 行为r1'))
  assert.ok(block.includes('小乙:触发b1 → 行为b1'))
  assert.ok(!block.includes('小丙'), '未启用角色的怪癖不注入')
  for (const rule of mod.QUIRK_INJECTION_RULES) {
    assert.ok(block.includes(rule), `纪律句应在场:${rule.slice(0, 12)}…`)
  }
  assert.equal(mod.QUIRK_INJECTION_RULES.length, 5, '注入纪律恒为五句(逐字,不压缩)')
})

// ---------- 开关关回归(§8):默认配置下生成入口直接跳过 ----------

test('开关关闭时 generateForSlot 直接 skip,不发起模型调用', async () => {
  const r = await mod.generateForSlot('A', 'cold')
  assert.equal(r, 'skip')
})
