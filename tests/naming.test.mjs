// 称呼与性别纪律回归:改名/设性别后,各 prompt 通道必须用真名、带映射与代词纪律。
// 沿用仓库测试原则:不碰网络与磁盘(vite ssrLoadModule 直载 TS 源码)。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let setCharacterNames
let setCharacterGenders
let namingDiscipline
let fullPersona
let defaultPersonaText
let buildMessages
let validateStoryText
let getConfig
let DEFAULT_CONFIG

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  ;({ setCharacterNames, setCharacterGenders, namingDiscipline, fullPersona, defaultPersonaText } =
    await server.ssrLoadModule('/src/engine/persona.ts'))
  ;({ buildMessages } = await server.ssrLoadModule('/src/engine/promptBuilder.ts'))
  ;({ validateStoryText } = await server.ssrLoadModule('/src/storage/storyStore.ts'))
  ;({ getConfig, DEFAULT_CONFIG } = await server.ssrLoadModule('/src/storage/configStore.ts'))
})

// 最小合法 TopicPlan(新话题契约:buildMessages 只认话题计划,不再收 topic/topicFixed)
const tp = (title) => ({
  planId: `tp-${title}`,
  createdAt: 0,
  expiresAt: 9e15,
  baseRevision: 0,
  lane: 'dynamic',
  mode: 'daily',
  intent: 'new',
  card: {
    id: `tc-${title}`,
    title,
    hook: title,
    category: 'life',
    tags: [],
    source: 'curated',
    fingerprint: `fp-${title}`,
    sensitivity: 'normal',
    generatedAt: 0,
  },
  policy: 'guided',
  stage: 'open',
  episodeFocus: title,
  allowedBranches: [],
  avoid: [],
  duration: 'once',
  compatibility: { sessionRevision: 0, banHash: '', modeHash: '', plannerVersion: 1 },
})

after(async () => {
  // 还原默认名系,避免模块级状态影响同文件后续断言的可读性
  setCharacterNames('甲', '乙', '丙')
  setCharacterGenders('女', '男', '女')
  await server?.close()
})

test('改名+设性别后:fullPersona 人设条目用真名,纪律块含映射与代词', () => {
  setCharacterNames('小红', '阿强', '妞妞')
  setCharacterGenders('女', '男', '女')
  const p = fullPersona()
  assert.match(p, /- 小红（speaker 用 "A"）：/)
  assert.match(p, /- 阿强（speaker 用 "B"）：/)
  assert.match(p, /- 妞妞（speaker 用 "C"）：/)
  assert.doesNotMatch(p, /- 甲（/)
  assert.match(p, /称呼与性别纪律/)
  assert.match(p, /"甲\/乙\/丙"就是 小红\/阿强\/妞妞/)
  assert.match(p, /禁止再出现"甲""乙""丙"/)
  assert.match(p, /小红是女\(代词用"她"\)/)
  assert.match(p, /阿强是男\(代词用"他"\)/)
  assert.match(p, /妞妞是女\(代词用"她"\)/)
})

test('纪律块:默认名系时不禁止甲乙丙(它们就是名字)', () => {
  setCharacterNames('甲', '乙', '丙')
  const d = namingDiscipline()
  assert.doesNotMatch(d, /禁止再出现/)
  assert.match(d, /即三人本人/)
})

test('buildMessages:protocol/cRule 用真名,模式指令的甲乙丙由映射覆盖', () => {
  setCharacterNames('小红', '阿强', '妞妞')
  setCharacterGenders('女', '男', '女')
  // 相声(喜剧):协议与 cRule 都用配置名
  const xt = buildMessages('crosstalk', tp('周报到底写给谁看'), [])
    .map((m) => m.content)
    .join('\n')
  assert.match(xt, /goalA":"小红想要什么/)
  assert.match(xt, /roleC":"妞妞本集的行动职责/)
  assert.match(xt, /小红和阿强承担主要语言冲突/)
  // 相声模式 prompt 里的"甲是逗哏"属结构性称呼,由纪律块映射,不需要改写
  assert.match(xt, /甲是逗哏/)
  assert.match(xt, /"甲\/乙\/丙"就是 小红\/阿强\/妞妞/)
  // 日常(非喜剧):承担主要对话,参与骨架用配置名,无默认逗弄示例
  const daily = buildMessages('daily', tp('周报到底写给谁看'), [])
    .map((m) => m.content)
    .join('\n')
  assert.match(daily, /小红和阿强承担主要对话/)
  assert.match(daily, /妞妞\(小管家\)是小红阿强身边的常驻伙伴/)
  assert.doesNotMatch(daily, /把我咖啡变成冰的/)
})

test('模式风格最高优先级块:相声解绑后缀在场(题材自由,装置退场)', () => {
  setCharacterNames('甲', '乙', '丙')
  const xt = buildMessages('crosstalk', tp('周报到底写给谁看'), [])[0].content
  assert.match(xt, /【模式风格（本集最高创作优先级）】/)
  assert.match(xt, /secret\/callback 不使用/, '相声解绑:装置退场后缀')
  assert.match(xt, /题材、人物、情境完全自由/, '题材自由宣告')
  assert.match(xt, /若模式风格指令与本节/, 'cRule 逗弄规则带让位条款')
  // 模式指令包裹在优先级块内(以【模式风格 开头块紧跟其内容)
  const idx = xt.indexOf('【模式风格（本集最高创作优先级）】')
  assert.ok(xt.slice(idx, idx + 200).includes('相声'), '块内紧跟模式指令本体')
  // 非喜剧:让位条款换成"主旋律"措辞,同样压制默认喜剧件
  const daily = buildMessages('daily', tp('周报到底写给谁看'), [])[0].content
  assert.match(daily, /模式风格是本集的主旋律/)
  assert.doesNotMatch(daily, /一律以模式风格为准/)
})

// ---------- 基调(tone):非喜剧分支裁掉默认喜剧件 ----------

/** 种入一个非喜剧自定义模式(与用户机上夸夸同构) */
async function seedNonComedyMode() {
  const { ensureCustomModesLoaded } = await server.ssrLoadModule('/src/storage/customModesStore.ts')
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
  values.set(
    'vc-custom-modes',
    JSON.stringify({
      version: 1,
      modes: [
        {
          id: 'custom_praise',
          label: '夸夸',
          accent: '#f0c040',
          gap: 350,
          prompt: '当前是【夸夸】模式:三个角色轮流真诚夸赞使用者,温柔收尾。',
          script: [
            { speaker: 'A', text: '你刚才那个想法真妙。', action: 'talk' },
            { speaker: 'B', text: '你说话的时候眼睛亮亮的。', action: 'talk' },
          ],
          tone: '温暖治愈',
          topics: ['今天做成的一件小事'],
        },
      ],
    }),
  )
  await ensureCustomModesLoaded()
}

test('非喜剧分支:prompt 裁掉默认喜剧件,tone 注入为基调语境', async () => {
  setCharacterNames('甲', '乙', '丙')
  await seedNonComedyMode()
  const sys = buildMessages('custom_praise', tp('今天做成的一件小事'), [])[0].content
  // 开场定位不再是喜剧编剧;基调值注入
  assert.doesNotMatch(sys, /资深喜剧编剧/)
  assert.match(sys, /本集基调:温暖治愈/)
  // craft 换中性版:无"这是喜剧/包袱收束/secret 是反转的底气"
  assert.doesNotMatch(sys, /这是喜剧/)
  assert.doesNotMatch(sys, /好笑比什么都重要/)
  assert.doesNotMatch(sys, /secret 是反转的底气/)
  // 场景卡 secret/callback 降为可选
  assert.match(sys, /secret.*可选/)
  assert.doesNotMatch(sys, /secret 在结尾反转揭晓/)
  assert.doesNotMatch(sys, /callback 必须回收/)
  // 互怼关系卡不注入:即使调用方传了 relationship,非喜剧分支也裁掉
  const rel = { label: '欢喜冤家', desc: '互怼但默契' }
  const praiseWithRel = buildMessages('custom_praise', tp('今天做成的一件小事'), [], undefined, undefined, rel)[0].content
  assert.doesNotMatch(praiseWithRel, /关系只改变本集攻守/, '非喜剧模式连传参的关系卡也不注入')
  // cRule 只留骨架:无逗弄叙述,有按模式风格参与
  assert.doesNotMatch(sys, /把我咖啡变成冰的/)
  assert.match(sys, /的参与方式完全按模式风格走/)
  // 优先级块改为"主旋律"措辞
  assert.match(sys, /模式风格是本集的主旋律/)
})

test('内建回归锁:crosstalk 恒走喜剧分支,daily 固定走非喜剧闲聊分支', async () => {
  setCharacterNames('甲', '乙', '丙')
  const { MODES } = await server.ssrLoadModule('/src/performer/modes/index.ts')
  assert.equal(MODES.crosstalk.tone, 'comedy')
  assert.equal(MODES.daily.tone, '日常闲聊', '日常是非喜剧闲聊,不再套用互怼喜剧骨架')
  assert.equal(MODES.live.tone, undefined, 'live 不锁死,弹幕回复按其 tone 声明走')

  const xt = buildMessages('crosstalk', tp('周报到底写给谁看'), [])[0].content
  assert.match(xt, /资深喜剧编剧/, '相声开场仍是喜剧编剧')
  assert.match(xt, /这是相声/, '解绑版 craft 基调')
  assert.match(xt, /不需要秘密反转/, '装置整体退场(用户裁决:解绑版无 secret/callback)')
  assert.match(xt, /这两个字段一律省略/, '协议同步省略 secret/callback')
  assert.match(xt, /14~22 句/)
  assert.match(xt, /若模式风格指令与本节/, '保留逗弄让位条款')

  const daily = buildMessages('daily', tp('周报到底写给谁看'), [])[0].content
  assert.doesNotMatch(daily, /资深喜剧编剧/)
  assert.doesNotMatch(daily, /这是喜剧/)
  assert.doesNotMatch(daily, /把我咖啡变成冰的/)
  assert.doesNotMatch(daily, /互怼但有默契/, '喜剧动态不注入日常')
  assert.doesNotMatch(daily, /14~22 句/)
  assert.match(daily, /8~16 句/)
  assert.match(daily, /像熟人随口聊天/)

  // 关系卡:喜剧分支传入 relationship 时注入;非喜剧连传参的关系卡也不注入
  const rel = { label: '欢喜冤家', desc: '互怼但默契' }
  assert.match(buildMessages('crosstalk', tp('周报'), [], undefined, undefined, rel)[0].content, /关系只改变本集攻守/)
  assert.doesNotMatch(buildMessages('daily', tp('周报'), [], undefined, undefined, rel)[0].content, /关系只改变本集攻守/)
})

test('sanitizeCustomMode:tone 透传(非 comedy 保留,comedy/空归 undefined)', async () => {
  const { sanitizeCustomMode } = await server.ssrLoadModule('/src/storage/customModesStore.ts')
  const base = {
    id: 'custom_x',
    label: '夸夸',
    prompt: '夸',
    script: [
      { speaker: 'A', text: '一', action: 'talk' },
      { speaker: 'B', text: '二', action: 'talk' },
    ],
  }
  assert.equal(sanitizeCustomMode({ ...base, tone: '温暖治愈' }).tone, '温暖治愈')
  assert.equal(sanitizeCustomMode({ ...base, tone: 'comedy' }).tone, undefined)
  assert.equal(sanitizeCustomMode({ ...base, tone: '' }).tone, undefined)
  assert.equal(sanitizeCustomMode(base).tone, undefined)
})

test('弹幕回复基调:live 非喜剧时措辞按 tone 走(直接断言 liveMode 声明与 prompt 生成素材)', async () => {
  // live 未锁死:改 live.ts 的 tone 声明即切换直播风格
  const { liveMode } = await server.ssrLoadModule('/src/performer/modes/index.ts')
  assert.equal(liveMode.tone, undefined)
  const liveIsComedy = !liveMode.tone?.trim() || liveMode.tone.trim() === 'comedy'
  assert.ok(liveIsComedy, '当前 live 未声明非 comedy,弹幕回复走现有捧场接梗文案')
})

test('defaultPersonaText:内置模板里的甲乙丙就地替换为配置名', () => {
  setCharacterNames('小红', '阿强', '妞妞')
  const c = defaultPersonaText('C')
  assert.match(c, /小红阿强都宠着都爱逗/)
  assert.doesNotMatch(c, /甲乙|丙/)
})

test('validateStoryText:接受配置名主体(旧甲乙丙仍兼容)', () => {
  setCharacterNames('小红', '阿强', '妞妞')
  assert.equal(validateStoryText('gag', '小红的冰箱是阿强的健身器材'), null)
  assert.equal(validateStoryText('gag', '妞妞把甲乙的泡面种进花盆等它发芽'), null, '旧名系仍兼容')
  assert.match(validateStoryText('gag', '冰箱其实是健身器材'), /主体/)
})

test('genders 配置:非法值回默认,合法值透传,缺省各角色对齐出厂音色', async () => {
  assert.deepEqual(DEFAULT_CONFIG.genders, { a: '女', b: '男', c: '女' })
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
  values.set('vc-config', JSON.stringify({ genders: { a: '男', b: '不男不女' } }))
  const cfg = await getConfig()
  assert.equal(cfg.genders.a, '男')
  assert.equal(cfg.genders.b, '男', '非法值回落默认')
  assert.equal(cfg.genders.c, '女', '缺省回落默认')
  delete globalThis.localStorage
})
