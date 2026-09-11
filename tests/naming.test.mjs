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
  const messages = buildMessages('daily', '周报到底写给谁看', [])
  const joined = messages.map((m) => m.content).join('\n')
  assert.match(joined, /goalA":"小红想要什么/)
  assert.match(joined, /roleC":"妞妞本集的行动职责/)
  assert.match(joined, /小红和阿强承担主要语言冲突/)
  assert.match(joined, /妞妞,把我咖啡变成冰的/, 'cRule 示例台词用配置名')
  // 相声模式 prompt 里的"甲是逗哏"属结构性称呼,由纪律块映射,不需要改写
  const xt = buildMessages('crosstalk', '周报到底写给谁看', []).map((m) => m.content).join('\n')
  assert.match(xt, /甲是逗哏/)
  assert.match(xt, /"甲\/乙\/丙"就是 小红\/阿强\/妞妞/)
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
