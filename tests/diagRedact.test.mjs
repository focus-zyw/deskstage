// 诊断脱敏层(diag/redact)行为测试。回归目标:链路诊断的隐私底线——
// 已登记密钥精确替换、Bearer/Cookie/URL 凭证/高熵兜底、实体掩码、截断记原长、
// 会话盐指纹稳定、语言探测。任何档位(含"含原文导出")都必经 scrubSecrets。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let redact

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  redact = await server.ssrLoadModule('/src/diag/redact.ts')
})

after(async () => {
  await server?.close()
})

test('scrubSecrets:已登记密钥精确替换优先于一切格式猜测', () => {
  redact.registerSecretValue('my-actual-key-98765')
  redact.registerSecretValue('SESSDATA=dangerous-cookie-value')
  const out = redact.scrubSecrets('请求用 my-actual-key-98765 失败了')
  assert.ok(!out.includes('my-actual-key-98765'))
  assert.ok(out.includes('[SECRET]'))
  const cookieOut = redact.scrubSecrets('带 SESSDATA=dangerous-cookie-value 的请求')
  assert.ok(!cookieOut.includes('dangerous-cookie-value'))
  redact.clearRegisteredSecrets()
})

test('scrubSecrets:已知格式(Bearer/sk-/Cookie 头/凭证参数)', () => {
  redact.clearRegisteredSecrets()
  let out = redact.scrubSecrets('Authorization: Bearer abc123def456ghi789')
  assert.ok(!out.includes('abc123def456ghi789'))
  assert.ok(out.includes('[AUTH]'))
  out = redact.scrubSecrets('key 是 sk-abcdef1234567890xyz')
  assert.ok(!out.includes('sk-abcdef1234567890xyz'))
  out = redact.scrubSecrets('Cookie: SESSDATA=xxx; bili_jct=yyy')
  assert.ok(!out.includes('SESSDATA=xxx'))
  // URL 查询参数整体抹除
  out = redact.scrubSecrets('访问 https://api.example.com/v1/chat?api_key=zzz123456&foo=bar 失败')
  assert.ok(!out.includes('zzz123456'))
  assert.ok(out.includes('[QUERY_STRIPPED]'))
})

test('scrubSecrets:高熵字符串兜底', () => {
  redact.clearRegisteredSecrets()
  const out = redact.scrubSecrets('token: Qz9xk2mVb7Np4rTsWvYz1234ABCD')
  assert.ok(!out.includes('Qz9xk2mVb7Np4rTsWvYz1234ABCD'))
  assert.ok(out.includes('[ENTROPY]'))
})

test('redactText:实体掩码(手机号/邮箱/身份证/银行卡/路径/URL/健康词/称呼)', () => {
  redact.clearRegisteredSecrets()
  redact.setKnownUserName('小王')
  const out = redact.redactText(
    '小王你好,我手机 13812345678,邮箱 a.b@x.com,身份证 110101199003074258,卡号 6222020200112233445,在 C:\\Users\\小王\\doc.txt 看到说明,我刚确诊抑郁症。',
    2000,
  )
  assert.ok(!out.includes('小王'))
  assert.ok(!out.includes('13812345678'))
  assert.ok(!out.includes('a.b@x.com'))
  assert.ok(!out.includes('110101199003074258'))
  assert.ok(!out.includes('6222020200112233445'))
  assert.ok(!out.includes('C:\\Users'))
  assert.ok(!out.includes('抑郁症'))
  assert.ok(out.includes('[USER_NAME]'))
  assert.ok(out.includes('[PHONE]'))
  assert.ok(out.includes('[EMAIL]'))
  assert.ok(out.includes('[IDENTITY_NUMBER]'))
  assert.ok(out.includes('[BANK_CARD]'))
  assert.ok(out.includes('[LOCAL_PATH]'))
  assert.ok(out.includes('[HEALTH_INFO]'))
  redact.setKnownUserName('')
})

test('redactText:截断并记录原长', () => {
  const out = redact.redactText('好'.repeat(900), 500)
  assert.ok(out.length < 900)
  assert.ok(out.includes('原长 900'))
})

test('fingerprintOf:会话内稳定、不同文本不同、带 fp: 前缀(不可反推原文)', () => {
  const a1 = redact.fingerprintOf('今天天气怎么样')
  const a2 = redact.fingerprintOf('今天天气怎么样')
  assert.equal(a1, a2)
  assert.ok(a1.startsWith('fp:'))
  assert.notEqual(a1, redact.fingerprintOf('明天吃什么'))
})

test('detectLanguage:中/英/日', () => {
  assert.equal(redact.detectLanguage('今天天气怎么样'), 'zh')
  assert.equal(redact.detectLanguage('hello world'), 'en')
  assert.equal(redact.detectLanguage('こんにちは'), 'ja')
})
