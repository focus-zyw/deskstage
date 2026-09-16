// 角色世界策展回归:迁移幂等、证据/断言门禁、相似去重、剧情生命周期、全量库存视野。
// 背景:事件线曾出现同场景重复入库、反问被写成事实、临时甩锅成为世界设定、
// 同一件事同时挂在事件线和剧情线上,这里逐一钉死。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'

let migration
let store
let curator

before(async () => {
  // storyStore 在非 Tauri 环境写 localStorage,先垫桩
  const values = new Map()
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size
    },
  }
  migration = await import('../src/storage/storyMigration.ts')
  store = await import('../src/storage/storyStore.ts')
  curator = await import('../src/engine/storyCurator.ts')
})

after(async () => {
  delete globalThis.localStorage
})

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/story.v1.json', import.meta.url), 'utf8'))

/** 空补丁(只填关心的字段) */
const patch = (over = {}) => ({
  threads: [],
  resolvedThreadIds: [],
  arcAdvance: null,
  newArc: null,
  ...over,
})

/** 空蒸馏结果 */
const distilled = (over = {}) => ({
  newThreads: [],
  resolvedThreadIds: [],
  arcAdvance: null,
  newArc: null,
  relationshipEvent: null,
  mood: [],
  ...over,
})

const threadTexts = () => store.getStory().then((s) => s.threads.map((t) => t.text))
const threadBy = (part) =>
  store.getStory().then((s) => s.threads.find((t) => t.text.includes(part)))

test('迁移:11 条已检老梗收敛为 6 条规范表述,检查范围外的新梗不动', async () => {
  const fx = fixture()
  const { data, report } = migration.migrateStoryData(fx)
  assert.equal(report.changed, true)
  assert.equal(data.version, 2)
  assert.equal(data.gags.length, 8) // 6 条规范 + 打地鼠/食堂阿姨两条检查范围外新梗
  assert.equal(data.threads.length, 3)
  const texts = data.gags.map((g) => g.text)
  assert.ok(texts.some((t) => t.includes('赛博身体不适') && t.includes('店长秒批')))
  assert.ok(texts.includes('甲家的猪会唱《孤勇者》，疑似陈奕迅教的'))
  assert.ok(texts.includes('甲认定家族群才是真算法，专推灵魂拷问'))
  assert.ok(texts.includes('甲办图书卡就算读过书，还在儿童区睡觉采风'))
  assert.ok(texts.includes('乙点无糖，甲喝全糖也要让乙背锅'))
  assert.ok(texts.includes('甲的赛博奶茶被吐槽连茶底都是AI画的'))
  assert.ok(texts.includes('观众是打地鼠的锤子，戳人二十六下'))
  assert.ok(!texts.some((t) => t.includes('充电宝')))
  // 合并记账:hits 相加、lastSeen/lastInjectedAt 取最大
  const g1 = data.gags.find((g) => g.text.includes('赛博身体不适'))
  assert.equal(g1.lastInjectedAt, 1789066309790)
  assert.equal(g1.hits, 0)
  const g5 = data.gags.find((g) => g.text.includes('无糖'))
  assert.equal(g5.hits, 1)
  // 事件线:只留有主语的 AI 怀疑线 + 房东语音线 + 耳机外放线
  const th = data.threads.map((t) => t.text)
  assert.ok(th.includes('甲怀疑观众和店长全是AI'))
  assert.ok(th.includes('甲的耳机外放《相亲对象观察日记》，乙已掌握其全部内容'))
  assert.ok(!th.some((t) => t.includes('孤勇者')))
  assert.ok(!th.some((t) => t.includes('毕业设计')))
  assert.ok(!th.some((t) => t.includes('管理员')))
  // 剧情线:完结线收尾入 ending、不再有下一拍;被污染的下一拍重写
  const dones = data.arcs.filter((a) => a.status === 'done')
  assert.equal(dones.length, 5)
  assert.ok(dones.every((a) => a.nextHook === '' && a.ending))
  const ai = data.arcs.find((a) => a.title === 'AI放假疑云')
  assert.equal(
    ai.nextHook,
    '店长秒批了甲的AI请假条，弹幕跟着起哄给自己批假，甲被追问AI到底放没放假',
  )
})

test('迁移:重复执行不改结果(幂等),且不修改原始输入', () => {
  const fx = fixture()
  const r1 = migration.migrateStoryData(fx)
  const r2 = migration.migrateStoryData(r1.data)
  assert.equal(r2.report.changed, false)
  assert.deepEqual(r2.data, r1.data)
  assert.equal(fx.version, 1)
})

test('纯函数:规范化统一"甲家"系主体,相似度识别换说法,校验拒绝短句与缺主体', () => {
  assert.equal(store.normalizeStoryText('甲家的猪，会唱吧'), store.normalizeStoryText('甲猪会唱'))
  assert.ok(
    store.storyTextSimilarity('甲认定家族群才是真算法', '甲认定家族群才是真正算法') >= 0.7,
  )
  assert.ok(store.storyTextSimilarity('AI写请假条店长秒批', '赛博身体不适需接入床铺碎片整理') < 0.7)
  assert.ok(store.validateStoryText('thread', '太短了'))
  assert.equal(store.validateStoryText('thread', '观众是打地鼠的锤子，戳人二十六下'), '缺少角色主体(甲/乙/丙或其配置名)')
  assert.equal(store.validateStoryText('thread', '乙点无糖，甲喝全糖也要让乙背锅'), null)
  // 有主语的事件线才可入库(乙的怪癖/丙的呆萌名场面同样有长期记忆载体)
  assert.equal(store.validateStoryText('thread', '丙把甲的泡面种进花盆等它长出办公椅'), null)
  assert.ok(store.validateStoryText('arcTitle', '这个剧情线标题实在是太长了不合规'))
})

test('确定性去重:与库存高度相似的事件线只刷新时间,不再新增', async () => {
  await store.mergeStory(patch({ threads: [{ text: '甲认定家族群才是真算法' }] }))
  const before = (await store.getStory()).threads.length
  await store.mergeStory(patch({ threads: [{ text: '甲认定家族群才是真正算法' }] }))
  const story = await store.getStory()
  assert.equal(story.threads.length, before) // 不新增
  const thread = story.threads.find((t) => t.text.includes('家族群才是'))
  assert.equal(thread.text, '甲认定家族群才是真算法') // 保留最初入库的表述,只并入不改写
})

test('策展:反问候选被拒,不写成世界事实', async () => {
  const lines = [{ speaker: 'A', text: '连茶底都是AI画的吧？这奶茶喝得我直皱眉', action: '' }]
  const report = await curator.curateEpisode(lines, {
    distill: async () =>
      distilled({
        newThreads: [
          {
            text: '甲的奶茶连茶底都是AI画的',
            evidence: ['连茶底都是AI画的吧'],
            assertion: 'question',
          },
        ],
      }),
  })
  assert.ok(report.rejected.some((r) => r.reason.includes('反问')))
  assert.ok(!(await threadTexts()).some((t) => t.includes('茶底')))
})

test('策展:没有台词证据的候选被拒', async () => {
  const lines = [{ speaker: 'A', text: '今天就在家里躺着,哪也不去', action: '' }]
  const report = await curator.curateEpisode(lines, {
    distill: async () =>
      distilled({
        newThreads: [
          {
            text: '甲家里的沙发有一个月没弹起来过',
            evidence: ['沙发有一个月没弹起来过'], // 台词里没有这句,模型编的证据
            assertion: 'established',
          },
        ],
      }),
  })
  assert.ok(report.rejected.some((r) => r.reason.includes('证据')))
  assert.ok(!(await threadTexts()).some((t) => t.includes('沙发')))
})

test('策展:临时甩锅保留模态,补"自称"后入库而非成为事实', async () => {
  const lines = [{ speaker: 'B', text: '别狡辩了,你就是想说房东借走了甲的手机发emo语音', action: '' }]
  const report = await curator.curateEpisode(lines, {
    distill: async () =>
      distilled({
        newThreads: [
          {
            text: '房东借走了甲的手机发emo语音',
            evidence: ['房东借走了甲的手机发emo语音'],
            assertion: 'excuse',
          },
        ],
      }),
  })
  assert.ok(report.addedThreads.length > 0)
  const thread = await threadBy('房东借走了甲的手机')
  assert.equal(thread.text, '甲自称房东借走了甲的手机发emo语音')
})

test('生命周期:newArc 吸收事件线结案;拍满完结后无下一拍、收尾入 ending', async () => {
  await store.mergeStory(patch({ threads: [{ text: '乙还欠甲一整箱肥宅快乐水' }] }))
  const threadId = (await store.getStory()).threads.find((t) => t.text.includes('肥宅快乐水')).id
  await store.mergeStory(
    patch({
      newArc: {
        title: '肥宅水争夺战',
        hook: '甲发现乙把快乐水藏进了值班室,准备半夜突袭',
        closeThreadIds: [threadId],
      },
    }),
  )
  let story = await store.getStory()
  assert.ok(!story.threads.some((t) => t.id === threadId)) // 事件线随剧情线结案
  const arc = story.arcs.find((a) => a.title === '肥宅水争夺战')
  assert.equal(arc.status, 'active')
  const H = [
    '乙在值班室门口装了警报,甲改道通风管道',
    '甲卡在通风管里被乙全程直播,观众打赏助威',
    '甲宣布投降,反而请全组喝了一箱快乐水',
  ]
  for (const hook of H) {
    await store.mergeStory(patch({ arcAdvance: { id: arc.id, nextHook: hook } }))
  }
  story = await store.getStory()
  const done = story.arcs.find((a) => a.id === arc.id)
  assert.equal(done.status, 'done')
  assert.equal(done.nextHook, '')
  assert.equal(done.ending, H[1]) // 刚演完的拍成为结局,最后一拍给出的钩子不再采用
})

test('记账:策展必须拿到全量库存,去重视野完整', async () => {
  await store.mergeStory(
    patch({
      threads: [
        { text: '甲把遥控器焊在了自己手里' },
        { text: '乙的猫只认甲当铲屎官' },
        { text: '甲的泡面必须配冰可乐才够赛博' },
      ],
    }),
  )
  const story = await store.getStory()
  const inv = await store.storyInventory()
  assert.equal(inv.threads.length, story.threads.length) // 全量,不再截 top3
  assert.equal(inv.doneArcs.length, story.arcs.filter((a) => a.status === 'done').length)

  // 策展链路把全量库存交给蒸馏模型(去重视野完整)
  const captured = []
  await curator.curateEpisode([{ speaker: 'A', text: '随便聊两句', action: '' }], {
    distill: async (lines, known) => {
      captured.push(known)
      return distilled()
    },
  })
  assert.equal(captured[0].threads.length, story.threads.length)
  assert.equal(captured[0].doneArcs.length, story.arcs.filter((a) => a.status === 'done').length)
})

test('回放收敛:同一批事件线换说法反复出现,库存不膨胀', async () => {
  await store.mergeStory(patch({ threads: [{ text: '甲自称房东借走了甲的手机发emo语音' }] }))
  const before = await store.getStory()
  const target = before.threads.find((t) => t.text.includes('房东借走了甲的手机'))
  const lines = [{ speaker: 'A', text: '我手机被房东借走发emo语音了,真事,图文并茂', action: '' }]
  // 第 1 集:与库存完全一致的表述
  await curator.curateEpisode(lines, {
    distill: async () =>
      distilled({
        newThreads: [
          {
            text: '甲自称房东借走了甲的手机发emo语音',
            evidence: ['手机被房东借走发emo语音'],
            assertion: 'excuse',
          },
        ],
      }),
  })
  // 第 2 集:模型没认出来,字面高度相似的变体
  await curator.curateEpisode(lines, {
    distill: async () =>
      distilled({
        newThreads: [
          {
            text: '甲自称房东借走了甲的手机发了emo语音',
            evidence: ['手机被房东借走发emo语音'],
            assertion: 'excuse',
          },
        ],
      }),
  })
  const after = await store.getStory()
  assert.equal(after.threads.length, before.threads.length) // 换说法不产生新条目
  const thread = after.threads.find((t) => t.id === target.id)
  assert.equal(thread.text, '甲自称房东借走了甲的手机发emo语音') // 措辞保持最初入库的表述
})

test('策展:情绪余波须过台词证据关才入库,丙同样记账', async () => {
  const lines = [
    { speaker: 'A', text: '我不管，这个月奶茶钱都搭进去了', action: 'sad' },
    { speaker: 'B', text: '所以说你记账能记出花来', action: 'talk' },
    { speaker: 'C', text: '好的，马上把奶茶钱从预算里删掉', action: 'talk' },
  ]
  const applied = []
  const report = await curator.curateEpisode(lines, {
    distill: async () =>
      distilled({
        mood: [
          {
            who: 'A',
            dValence: -1.5,
            dEnergy: -0.5,
            cause: '甲为奶茶钱破防',
            evidence: '这个月奶茶钱都搭进去了',
          },
          { who: 'B', dValence: 0.8, dEnergy: 0.3, cause: '乙拆台得逞', evidence: '台词里根本没有这句' },
        ],
      }),
    applyMood: async (d) => applied.push(...d),
  })
  assert.equal(applied.length, 1) // 乙的假证据被拒,甲入库
  assert.equal(applied[0].who, 'A')
  assert.equal(applied[0].dValence, -1.5)
  assert.equal(applied[0].cause, '甲为奶茶钱破防')
  assert.equal(report.mood?.length, 1)
  assert.deepEqual(
    report.rejected.map((r) => r.reason),
    ['情绪余波无台词证据'],
  )
})
