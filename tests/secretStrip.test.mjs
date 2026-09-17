// 密钥不落盘契约:stripSecrets 移除全部七个密钥字段(含嵌套),非密钥字段原样保留;
// sanitize 层仍读历史明文——迁移失败/浏览器预览的兜底读取路径,读取后由凭据库覆盖。
// stripSecrets 导出自 configStore(与 sanitizeCharacters 同惯例),在此做 SSR 直测。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let configStore

before(async () => {
  configStore = await import('../src/storage/configStore.ts')
})


test('stripSecrets 移除五个密钥字段,非密钥字段保留', () => {
  const cfg = {
    apiKey: 'sk-main',
    apiKeys: { deepseek: 'sk-a' },
    model: 'deepseek-chat',
    voice: {
      apiKey: 'sk-tts',
      provider: 'siliconflow',
      minimax: { apiKey: 'sk-mm', groupId: 'g' },
    },
    ocr: { apiKey: 'sk-ocr', model: 'glm-4.6v-flash' },
  }
  const out = configStore.stripSecrets(structuredClone(cfg))
  assert.equal(out.apiKey, undefined)
  assert.equal(out.apiKeys, undefined)
  assert.equal(out.model, 'deepseek-chat')
  assert.equal(out.voice.apiKey, undefined)
  assert.equal(out.voice.provider, 'siliconflow')
  assert.equal(out.voice.minimax.apiKey, undefined)
  assert.equal(out.voice.minimax.groupId, 'g')
  assert.equal(out.ocr.apiKey, undefined)
  assert.equal(out.ocr.model, 'glm-4.6v-flash')
})

test('stripSecrets 深拷贝:入参对象不被改动', () => {
  const cfg = { apiKey: 'sk', voice: { apiKey: 'sk2' } }
  const out = configStore.stripSecrets(cfg)
  assert.equal(cfg.apiKey, 'sk')
  assert.equal(cfg.voice.apiKey, 'sk2')
  assert.equal(out.apiKey, undefined)
  assert.equal(out.voice.apiKey, undefined)
})

test('sanitize 层保留历史明文(迁移失败时的兜底读取路径)', () => {
  const legacy = { apiKey: 'sk-legacy', ocr: { apiKey: 'sk-ocr-old' } }
  const cfg = configStore.sanitizeConfig(legacy)
  assert.equal(cfg.apiKey, 'sk-legacy')
  assert.equal(cfg.ocr.apiKey, 'sk-ocr-old')
})
