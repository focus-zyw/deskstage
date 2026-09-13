// CharInteractions 行为矩阵(深模块验收):内存 adapter + 确定性 rand/clock,
// 零网络零 DOM。覆盖:演说打断 / 连戳分级(害羞@2 生气@5) / C 台词包优先且豁免即兴 /
// 即兴成功替换占位·失败回落·冷却 / 团宠起哄安全缝 / 投喂吃撑窗口与冷却 / 摸头害羞。
//
// rand 消耗顺序(poke 非 C 非生气):①普通池取句 ②laugh 掷骰(<0.3) ③即兴触发(<0.3);
// C 走 ①② 后跳过即兴,直接进起哄掷骰(<0.3)。测试按此排布序列。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let mod

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  mod = await server.ssrLoadModule('/src/interaction/charInteractions.ts')
})

after(async () => {
  await server?.close()
})

function makeWorld(over = {}) {
  const calls = { present: [], focus: [], logs: [], interrupts: [], poked: [], active: 0 }
  const host = {
    present: (who, line, action, ms) => calls.present.push({ who, line, action, ms }),
    focus: (who) => calls.focus.push(who),
    onUserActive: () => calls.active++,
    isSpeaking: (who) => (over.speaking ?? null) === who,
    isPerforming: () => over.performing ?? false,
    isIdle: () => over.idle ?? true,
    isDirectorBusy: () => over.directorBusy ?? false,
    recentLines: () => over.recent ?? [],
  }
  let now = 1_000_000
  let improvCalls = 0
  const seq = [...(over.rand ?? [])]
  const deps = {
    bumpPoke: () => {},
    logInteraction: (kind) => calls.logs.push(kind),
    logInterrupt: (who) => calls.interrupts.push(who),
    notePoked: (who) => calls.poked.push(who),
    improvLine: async () => `即兴${++improvCalls}`,
    pick: (kind, pool) => `包:${kind}:${pool.length}`, // 台词包命中形态(带池长度可断言选池)
    rand: () => seq.shift() ?? 0.99, // 序列耗尽恒 0.99:不触发任何概率事件
    clock: {
      now: () => now,
      setTimeout: (fn, ms) => {
        now += ms // 虚拟时钟:立即触发并推进
        fn()
        return () => {}
      },
    },
    ...(over.deps ?? {}),
  }
  const api = {
    tick(ms) {
      now += ms
    },
    improvCount: () => improvCalls,
  }
  const it = mod.createCharInteractions(host, deps)
  return { it, calls, api }
}

test('演说中被戳:打断分支,不进账本不计数', () => {
  const { it, calls } = makeWorld({ performing: true, speaking: 'A' })
  it.poke('A')
  assert.equal(calls.interrupts.length, 1)
  assert.equal(calls.logs.length, 0) // 打断不记 pokeA
  assert.equal(calls.present[0].action, 'surprise')
})

test('连戳分级:第1次普通,第2次害羞,第5次生气(同角色滑动窗口)', () => {
  const { it, calls } = makeWorld()
  it.poke('A')
  assert.equal(calls.present[0].action, 'talk')
  it.poke('A')
  assert.equal(calls.present[1].action, 'shy')
  it.poke('A')
  it.poke('A')
  it.poke('A')
  assert.equal(calls.present[4].action, 'angry')
  assert.equal(calls.present.length, 5)
})

test('C 走团宠专属池(5句),豁免即兴,低概率也不会起哄失败崩溃', () => {
  const { it, calls, api } = makeWorld({ rand: [0.5, 0.9, 0.9] })
  it.poke('C')
  assert.equal(calls.present.length, 1) // 无占位无起哄(0.9 不触发)
  assert.equal(calls.present[0].line, '包:poke:5') // cPokeLines 5 句(甲乙池 7 句)
  assert.equal(api.improvCount(), 0) // C 不参与即兴
})

test('即兴:先占位后替换;冷却内不再触发', async () => {
  // 序列:①普通池 0.5 ②laugh 0.9 ③即兴触发 0.0(<0.3)
  const { it, calls, api } = makeWorld({ rand: [0.5, 0.9, 0.0] })
  it.poke('B')
  assert.equal(api.improvCount(), 1)
  assert.equal(calls.present[0].line, '（被戳得一激灵）') // 占位在前(同步)
  await new Promise((r) => setImmediate(r)) // 即兴替换是微任务
  assert.equal(calls.present[1].line, '即兴1') // 替换在后
  // 冷却内(虚拟时钟未推进):不再触发,直接普通反应
  const before = calls.present.length
  it.poke('B')
  assert.equal(api.improvCount(), 1)
  assert.equal(calls.present.length, before + 1)
})

test('即兴失败回落内置选句', async () => {
  const { it, calls } = makeWorld({
    rand: [0.5, 0.9, 0.0],
    deps: {
      improvLine: async () => {
        throw new Error('LLM 挂了')
      },
    },
  })
  it.poke('A')
  await new Promise((r) => setImmediate(r))
  // 占位之后,回落是内置池原句(POKE_LINES[3],rand 0.5 → floor(0.5*7)=3),非即兴文本
  assert.ok(calls.present.some((p) => p.line === '摸鱼被发现了？！'))
  assert.ok(!calls.present.some((p) => p.line.startsWith('即兴')))
})

test('即兴超 TTL(4500ms)返回被丢弃,不顶掉气泡', async () => {
  let resolveLate
  const { it, calls, api } = makeWorld({
    rand: [0.5, 0.9, 0.0],
    deps: {
      improvLine: () =>
        new Promise((r) => {
          resolveLate = () => r('迟到的即兴')
        }),
    },
  })
  it.poke('A')
  assert.equal(calls.present.at(-1).line, '（被戳得一激灵）')
  api.tick(5000) // 超 TTL
  resolveLate()
  await new Promise((r) => setTimeout(r, 10))
  assert.ok(!calls.present.some((p) => p.line === '迟到的即兴'))
})

test('戳团宠起哄:非空闲时被安全缝拦下', () => {
  // 起哄判定 rand 0.0(<0.3 触发排程);触发时 idle=false → 拦下
  const { it, calls } = makeWorld({ rand: [0.5, 0.9, 0.0], idle: false })
  it.poke('C')
  assert.equal(calls.present.filter((p) => p.action === 'laugh').length, 0)
})

test('投喂:第3次吃撑并进入60s冷却;冷却内再喂仍是撑;过冷却恢复正常', () => {
  const { it, calls, api } = makeWorld()
  it.feedC()
  it.feedC()
  it.feedC()
  assert.equal(calls.present.at(-1).action, 'stuffed') // 第3次 → 吃撑
  it.feedC()
  assert.equal(calls.present.at(-1).action, 'stuffed') // 冷却期内仍撑
  api.tick(301_000) // 过 60s 冷却且出 5 分钟吃撑窗口(计时点全部出窗)
  it.feedC()
  assert.ok(calls.present.at(-1).action !== 'stuffed') // 重新从 1 数,正常端点心
  assert.equal(calls.present.at(-1).ms, 2600) // 正常投喂的呈现时长(吃撑是 2200/2400)
})

test('摸头:60s 内第3次起害羞;非害羞走台词包', () => {
  const { it, calls } = makeWorld()
  it.headpatC()
  it.headpatC()
  assert.equal(calls.present.at(-1).line, '包:headpat:5') // cHeadpatLines 5 句
  it.headpatC()
  assert.ok(!calls.present.at(-1).line.startsWith('包:')) // 第3次害羞走内置池
  assert.equal(calls.present.at(-1).action, 'headpat')
})
