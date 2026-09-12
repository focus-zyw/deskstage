import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let buildMessages
let cRuleFor
let renderAudienceContext
let renderViewerBrief
let renderStoryContext
let persona
let selectStoryItems
let storyContext

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  ;({
    buildMessages,
    cRuleFor,
    renderAudienceContext,
    renderViewerBrief,
    renderStoryContext,
  } = await server.ssrLoadModule('/src/engine/promptBuilder.ts'))
  persona = await server.ssrLoadModule('/src/engine/persona.ts')
  ;({ selectStoryItems, storyContext } = await server.ssrLoadModule('/src/storage/storyStore.ts'))
})

after(async () => {
  await server?.close()
})

const story = (gags, threads = []) => ({
  version: 1,
  gags,
  threads,
  arcs: [],
  bond: { trust: 1, rivalry: 0, updatedAt: 0 },
})

function finalPrompt({ recentLines = [], storyContext, continueFromPrevious = false, moodNote } = {}) {
  return buildMessages(
    'crosstalk',
    '周报到底写给谁看',
    recentLines,
    false,
    undefined,
    storyContext ? { story: storyContext } : undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    moodNote,
    continueFromPrevious,
  )
    .map((message) => message.content)
    .join('\n')
}

test('周报主题的最终提示词不会注入无关的满减记忆', () => {
  const selection = selectStoryItems(
    story([
      {
        id: 'shopping',
        text: '凑奶茶满减退17单叫精准凑单',
        hits: 10,
        lastSeen: 300,
        lastInjectedAt: 0,
      },
      {
        id: 'weekly-report',
        text: '甲把周报写成了连续剧预告',
        hits: 0,
        lastSeen: 100,
        lastInjectedAt: 0,
      },
    ]),
    '周报到底写给谁看',
    2,
  )
  const prompt = finalPrompt({
    storyContext: {
      gags: selection.gags.map((item) => item.text),
      threads: selection.threads.map((item) => item.text),
    },
  })

  assert.match(prompt, /周报写成了连续剧预告/)
  assert.doesNotMatch(prompt, /满减|凑单/)
})

test('冷却时间优先于 hits，近期高频老梗不会继续霸榜', () => {
  const selection = selectStoryItems(
    story([
      {
        id: 'hot-recent',
        text: '周报写成八百回连续剧',
        hits: 99,
        lastSeen: 300,
        lastInjectedAt: 300,
      },
      {
        id: 'cool',
        text: '周报最后一页其实是请假条',
        hits: 0,
        lastSeen: 100,
        lastInjectedAt: 100,
      },
    ]),
    '周报到底写给谁看',
    1,
  )

  assert.equal(selection.gags[0]?.id, 'cool')
})

test('每次注入后记录冷却时间并轮换到下一个相关老梗', async () => {
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
  localStorage.setItem(
    'vc-story',
    JSON.stringify(
      story([
        {
          id: 'first',
          text: '周报写成了一部长篇小说',
          hits: 0,
          lastSeen: 200,
          lastInjectedAt: 0,
        },
        {
          id: 'second',
          text: '周报最后一页藏着请假条',
          hits: 0,
          lastSeen: 100,
          lastInjectedAt: 0,
        },
      ]),
    ),
  )

  const first = await storyContext('周报到底写给谁看', 1)
  const second = await storyContext('周报到底写给谁看', 1)

  assert.deepEqual(first.gags, ['周报写成了一部长篇小说'])
  assert.deepEqual(second.gags, ['周报最后一页藏着请假条'])
  delete globalThis.localStorage
})

test('新主题默认不携带上一段原始结尾', () => {
  const prompt = finalPrompt({
    recentLines: [{ speaker: 'A', text: '要不再凑一单满减？', action: 'talk' }],
  })

  assert.doesNotMatch(prompt, /要不再凑一单满减/)
})

test('显式续聊时才携带上一段原始结尾', () => {
  const prompt = finalPrompt({
    recentLines: [{ speaker: 'A', text: '这份周报还没写完。', action: 'talk' }],
    continueFromPrevious: true,
  })

  assert.match(prompt, /这份周报还没写完/)
})

test('C 分工规则(cRuleFor):喜剧默认保留逗弄分工,字面反击改偶发且不强制', () => {
  const rule = cRuleFor({ isComedy: true, isCrosstalk: false, cCustomized: false })
  assert.match(rule, /甲爱用夸张的吹牛和离谱的请求逗她/)
  assert.match(rule, /乙爱用毒舌反问/)
  assert.match(rule, /不许刻薄嘲笑/)
  assert.match(rule, /1~4 句/)
  assert.match(rule, /偶尔出现的特点/, '字面理解是偶发特点')
  assert.match(rule, /不安排固定的"字面反击"桥段/)
  assert.doesNotMatch(rule, /中后段安排一次/, '不再强制每集安排字面反击')
})

test('C 分工规则:C 自定义人设时,逗弄示例与默认人格描述全部让位', () => {
  const rule = cRuleFor({ isComedy: true, isCrosstalk: false, cCustomized: true })
  assert.doesNotMatch(rule, /把我咖啡变成冰的/)
  assert.doesNotMatch(rule, /团宠/)
  assert.match(rule, /按她的自定义人设参与喜剧/)
  const xt = cRuleFor({ isComedy: true, isCrosstalk: true, cCustomized: true })
  assert.doesNotMatch(xt, /字面执行制造实体包袱/)
  assert.doesNotMatch(xt, /团宠/)
  assert.match(xt, /按她的自定义人设参与,用她自身的特点制造实体包袱/)
  assert.match(xt, /本场只占 0~2 句/, '舞台职责恒在')
})

test('C 分工规则:非喜剧骨架与相声默认分支各归各', () => {
  const casual = cRuleFor({ isComedy: false, isCrosstalk: false, cCustomized: false, tone: '日常闲聊' })
  assert.match(casual, /参与方式完全按模式风格走/)
  assert.match(casual, /1~4 句/)
  assert.doesNotMatch(casual, /把我咖啡变成冰的/)
  const xt = cRuleFor({ isComedy: true, isCrosstalk: true, cCustomized: false })
  assert.match(xt, /本场只占 0~2 句/)
  assert.match(xt, /拿丙垫梗/)
  assert.match(xt, /仍是逗哏-捧哏主轴/)
  assert.match(xt, /字面执行制造实体包袱/)
})

test('日常模式非喜剧化:无喜剧件,句数 8~16,喜剧动态不注入', () => {
  const sys = buildMessages('daily', '点外卖还是自己做饭', [])[0].content
  assert.doesNotMatch(sys, /资深喜剧编剧/)
  assert.doesNotMatch(sys, /这是喜剧/)
  assert.doesNotMatch(sys, /好笑比什么都重要/)
  assert.doesNotMatch(sys, /要有喜剧感/)
  assert.doesNotMatch(sys, /笑点素材/)
  assert.doesNotMatch(sys, /段子/)
  assert.doesNotMatch(sys, /互怼但有默契/)
  assert.match(sys, /8~16 句/)
  assert.match(sys, /像熟人随口聊天/)
  assert.match(sys, /熟悉的长期伙伴/)
  assert.match(sys, /本集的场景和情绪/, 'timeCtx 不再写"段子的场景"')
})

test('renderStoryContext:非喜剧只带共同经历,不注入老梗与笑点素材', () => {
  const s = { gags: ['老梗A'], threads: ['没还的扳手'] }
  const casual = renderStoryContext(s, { comedy: false })
  assert.match(casual, /共同经历\/未了结事件/)
  assert.match(casual, /没还的扳手/)
  assert.doesNotMatch(casual, /老梗A/)
  assert.doesNotMatch(casual, /笑点素材/)
  const comedy = renderStoryContext(s, { comedy: true })
  assert.match(comedy, /老梗A/)
  assert.match(comedy, /笑点素材/)
})

test('相声模式丙只占 0~2 句,保留逗哏-捧哏主轴', () => {
  const prompt = buildMessages('crosstalk', '周报到底写给谁看', [])
    .map((message) => message.content)
    .join('\n')
  assert.match(prompt, /本场只占 0~2 句/)
  assert.match(prompt, /甲乙拿丙垫梗/)
  assert.match(prompt, /甲乙仍是逗哏-捧哏主轴/)
})

test('使用者称呼纪律:注入用户名时明确禁止加"们"等后缀', () => {
  const prompt = buildMessages('daily', '点外卖还是自己做饭', [], false, undefined, {
    profile: { userName: '小张', occupation: '', likes: '', dislikes: '', banTopics: '' },
  })
    .map((message) => message.content)
    .join('\n')
  assert.match(prompt, /称呼永远只用"小张"/)
  assert.match(prompt, /禁止"小张们""小张你们"/)
})

test('抉择点分档:喜剧中段站队收同底,非喜剧自然停顿征询各自收束', () => {
  const xtChoice = buildMessages(
    'crosstalk',
    '周报到底写给谁看',
    [],
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    true, // allowChoice
  )[0].content
  assert.match(xtChoice, /恰好在剧情冲突最激烈的中段安排一次/)
  assert.match(xtChoice, /站队问题/)
  assert.match(xtChoice, /两个分支结尾收同一个底包袱/)
  assert.match(xtChoice, /对被选方向做口语反应/)

  const dailyChoice = buildMessages(
    'daily',
    '点外卖还是自己做饭',
    [],
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    true,
  )[0].content
  assert.match(dailyChoice, /在对话的自然停顿处进行/)
  assert.match(dailyChoice, /意见征询/)
  assert.match(dailyChoice, /各自自然收束/)
  assert.doesNotMatch(dailyChoice, /底包袱/)
  assert.doesNotMatch(dailyChoice, /剧情冲突最激烈/)
  assert.match(dailyChoice, /对所选方向做口语反应/)
  assert.match(dailyChoice, /禁止出现"观众选择了""大家投了""投票结果""站队"/)

  const withLast = buildMessages(
    'daily',
    '点外卖还是自己做饭',
    [],
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    '帮甲',
  )
    .map((m) => m.content)
    .join('\n')
  assert.match(withLast, /上集观众的选择是:"帮甲"/)
  assert.match(withLast, /别说"上集观众选择了"这类播报腔/)
})

test('互动回执中性化:不责怪观众,可提可不提', () => {
  const msgs = buildMessages('daily', '点外卖还是自己做饭', [], false, undefined, undefined, undefined, '观众戳了甲 3 次')
  const user = msgs[1].content
  assert.match(user, /最近有过一次观众互动/)
  assert.match(user, /不得责怪观众/)
  assert.doesNotMatch(user, /捣乱/)
  assert.doesNotMatch(user, /抱怨/)
})

test('viewerFields/renderViewerBrief:短通道简报带雷区行为说明,与画像块共用底层', () => {
  const p = { userName: '小张', occupation: '设计师', likes: '咖啡', dislikes: '香菜', banTopics: '裁员' }
  const brief = renderViewerBrief(p, ['养了只猫'])
  assert.match(brief, /关于观众:/)
  assert.match(brief, /需要称呼时直接叫"小张",不加"们";不必每句重复称呼/)
  assert.match(brief, /雷区\(绝对不要聊\):裁员,命中时不复述、不展开,简短转开话题/)
  assert.match(brief, /记住的观众的事:养了只猫/)
  assert.equal(renderViewerBrief(undefined, []), '')
  const full = renderAudienceContext({ profile: p })
  assert.match(full, /称呼永远只用"小张"/, 'full 风格保留强称呼纪律')
  assert.match(full, /雷区\(绝对不要聊\):裁员。/)
})

test('自定义人设接管:行为四维按角色裁剪,中性伙伴线与口头禅纪律恒在', () => {
  const { fullPersona, setPersonaOverride, isPersonaCustomized } = persona
  setPersonaOverride('', '', '')
  const base = fullPersona()
  assert.match(base, /行为底色/)
  assert.match(base, /甲\(speaker "A"\):注意力/)
  assert.doesNotMatch(base, /互怼但有默契/, '喜剧动态不再默认注入')
  // 全自定义:四维块消失,口头禅纪律与中性伙伴线恒在
  setPersonaOverride('A 自己的人设', 'B 自己的人设', 'C 自己的人设')
  const custom = fullPersona()
  assert.doesNotMatch(custom, /行为底色\(/, '四维块整块消失(口头禅纪律行里的提法不算)')
  assert.doesNotMatch(custom, /便宜可占/)
  assert.match(custom, /口头禅\/标志性语气词每集合计最多 1~2 次/)
  assert.match(custom, /熟悉的长期伙伴/)
  assert.ok(isPersonaCustomized('C'))
  // 部分自定义:默认角色保留四维行
  setPersonaOverride('只有 A 换人', '', '')
  const partial = fullPersona()
  assert.doesNotMatch(partial, /甲\(speaker "A"\):注意力/)
  assert.match(partial, /乙\(speaker "B"\):注意力/)
  // 喜剧动态:C 自定义时团宠半句不强加
  setPersonaOverride('', '', '')
  const dynDefault = fullPersona({ comedyDynamics: true })
  assert.match(dynDefault, /互怼但有默契/)
  assert.match(dynDefault, /团宠/)
  setPersonaOverride('', '', 'C 换成一个严肃管家')
  const dynCustomC = fullPersona({ comedyDynamics: true })
  assert.match(dynCustomC, /互怼但有默契/)
  assert.doesNotMatch(dynCustomC, /团宠/)
  setPersonaOverride('', '', '')
})

test('bondNoteFor:负面关系按基调分档,非喜剧不含互怼措辞', async () => {
  const { bondNoteFor } = await server.ssrLoadModule('/src/engine/llmClient.ts')
  const bond = { trust: -2, rivalry: 4 }
  assert.match(bondNoteFor(bond, true), /看不顺眼|较劲/)
  const casual = bondNoteFor(bond, false)
  assert.doesNotMatch(casual, /看不顺眼|拿旧账试探/)
  assert.match(casual, /保持基本尊重/)
  assert.equal(bondNoteFor({ trust: 0, rivalry: 0 }, true), undefined)
})

test('心情余波注入:位于长期关系之后,空缺时不出现占位文字', () => {
  const withMood = finalPrompt({ moodNote: '当前心情余波:\n- 乙情绪稍紧绷(有点来气)' })
  assert.match(withMood, /当前心情余波/)
  assert.match(withMood, /乙情绪稍紧绷/)
  const withoutMood = finalPrompt()
  assert.doesNotMatch(withoutMood, /心情余波/)
})
