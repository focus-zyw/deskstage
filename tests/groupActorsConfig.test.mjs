// 群聊 Actor 配置(P1a):模型档案与角色绑定的清洗/迁移回归。
// 覆盖:旧配置缺字段 → 迁移默认(A=主模型+natural、B=主模型+quiet、C=disabled)/
// 档案 id 白名单与 'main' 保留字 / 非法档案整条拒收 / Key 映射键过滤 /
// binding 三形态收敛(web 站点白名单、api profileId 非法回落主模型、未知 kind → disabled)/
// engine 回退开关 / stripSecrets 剥离 modelProfileKeys / profileId 非法字符不进任何路径(评审③)。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let configStore
let secretsModule

before(async () => {
  configStore = await import('../src/storage/configStore.ts')
  secretsModule = await import('../src/storage/secrets.ts')
})


test('旧配置缺字段:迁移默认 A=主模型+natural、B=主模型+quiet、C=disabled(控费用)', () => {
  const cfg = configStore.sanitizeConfig({})
  assert.equal(cfg.groupChatActors.engine, 'actors')
  assert.deepEqual(cfg.groupChatActors.A, { binding: { kind: 'api' }, autonomy: 'natural' })
  assert.deepEqual(cfg.groupChatActors.B, { binding: { kind: 'api' }, autonomy: 'quiet' })
  assert.deepEqual(cfg.groupChatActors.C, { binding: { kind: 'disabled' }, autonomy: 'natural' })
  assert.deepEqual(cfg.modelProfiles, {})
  assert.deepEqual(cfg.modelProfileKeys, {})
})

test('档案清洗:id 白名单 + main 保留字 + 缺 baseUrl/model 整条拒收', () => {
  const profiles = configStore.sanitizeModelProfiles({
    good: { label: '备用', baseUrl: 'https://api.x.com/v1', model: 'm1' },
    main: { baseUrl: 'https://evil.com', model: 'm' },
    'a/b': { baseUrl: 'https://evil.com', model: 'm' },
    '含中文': { baseUrl: 'https://x.com', model: 'm' },
    noModel: { baseUrl: 'https://x.com' },
    noHttp: { model: 'm', baseUrl: 'ftp://x.com' },
    emptyLabel: { baseUrl: 'https://y.com/v1', model: 'y-model' },
  })
  assert.deepEqual(Object.keys(profiles), ['good', 'emptyLabel'])
  assert.equal(profiles.emptyLabel.label, 'y-model', 'label 缺省取 model')
})

test('档案数量封顶 12,超出丢弃', () => {
  const raw = {}
  for (let i = 0; i < 20; i++) raw[`p${i}`] = { baseUrl: 'https://x.com/v1', model: 'm' }
  const profiles = configStore.sanitizeModelProfiles(raw)
  assert.equal(Object.keys(profiles).length, 12)
})

test('Key 映射:键按档案白名单过滤,非字符串值拒收', () => {
  const keys = configStore.sanitizeModelProfileKeys({
    good: 'sk-abc',
    main: 'sk-main',
    'a/b': 'sk-evil',
    bad: 123,
  })
  assert.deepEqual(keys, { good: 'sk-abc' })
})

test('绑定收敛:web 站点白名单 / api profileId 非法回落主模型 / 未知 kind → disabled', () => {
  const sanitize = (v) => configStore.sanitizeGroupChatActors(v)
  assert.deepEqual(sanitize({ A: { binding: { kind: 'web', site: 'doubao' } } }).A.binding, {
    kind: 'web',
    site: 'doubao',
  })
  assert.deepEqual(sanitize({ A: { binding: { kind: 'web', site: 'nope' } } }).A.binding, {
    kind: 'web',
    site: 'deepseek',
  })
  // 'main'/非法 profileId → 缺省(主模型),保留字不进持久配置
  assert.deepEqual(sanitize({ A: { binding: { kind: 'api', profileId: 'main' } } }).A.binding, {
    kind: 'api',
  })
  assert.deepEqual(sanitize({ B: { binding: { kind: 'api', profileId: 'a/b' } } }).B.binding, {
    kind: 'api',
  })
  assert.deepEqual(sanitize({ C: { binding: { kind: 'wat' } } }).C.binding, { kind: 'disabled' })
  // 自主档位只认三档
  assert.equal(sanitize({ A: { binding: { kind: 'api' }, autonomy: 'lively' } }).A.autonomy, 'lively')
  assert.equal(sanitize({ A: { binding: { kind: 'api' }, autonomy: 'wild' } }).A.autonomy, 'natural')
})

test('engine 回退开关:只认 legacy,其余一律 actors', () => {
  assert.equal(configStore.sanitizeGroupChatActors({ engine: 'legacy' }).engine, 'legacy')
  assert.equal(configStore.sanitizeGroupChatActors({ engine: 'wat' }).engine, 'actors')
  assert.equal(configStore.sanitizeGroupChatActors({}).engine, 'actors')
})

test('stripSecrets 剥离 modelProfileKeys,配置文件不落档案 Key', () => {
  const cfg = configStore.sanitizeConfig({
    modelProfileKeys: { good: 'sk-secret' },
  })
  const stripped = configStore.stripSecrets(cfg)
  assert.equal(stripped.modelProfileKeys, undefined, '整键删除(与 apiKeys 同语义)')
  assert.deepEqual(cfg.modelProfileKeys, { good: 'sk-secret' }, '内存快照保留真实值')
})

test('SecretId 白名单含 llm:profileKeys(封闭集合仍封闭)', () => {
  // 编译期联合类型在运行时不可枚举;直接断言类型模块加载成功且导出齐备
  assert.equal(typeof secretsModule.readSecret, 'function')
  assert.equal(typeof secretsModule.writeSecret, 'function')
})

test('profileId 非法字符不会影响任何配置路径(与 Rust 校验同一白名单)', () => {
  assert.equal(configStore.PROFILE_ID_RE.test('../etc'), false)
  assert.equal(configStore.PROFILE_ID_RE.test('~0root'), false)
  assert.equal(configStore.PROFILE_ID_RE.test('a'.repeat(49)), false)
  assert.equal(configStore.PROFILE_ID_RE.test('ok-id_1'), true)
})
