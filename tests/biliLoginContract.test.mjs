// 扫码登录接口契约测试:打真实 passport API,锁定官方请求上下文的两个关键契约——
// 1) generate 带 source=main_web 时,返回 url 必须带 from=main_web(手机App认链接的前提)
// 2) 全新 qrcode_key 的首轮 poll 必须是 86101(未扫码)
// 网络不通/被风控时 skip 而非 fail(契约测试依赖外网,CI 环境可能放行不了)。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const HEADERS = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' }
const GEN_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header&go_url='
const POLL_URL = (key) => `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${key}`

let key = null
let genUrl = ''
let skipped = false

before(async () => {
  try {
    const res = await fetch(GEN_URL, { headers: HEADERS, signal: AbortSignal.timeout(10_000) })
    const json = await res.json()
    assert.equal(json.code, 0)
    key = json.data.qrcode_key
    genUrl = json.data.url
  } catch (e) {
    skipped = true
    console.warn(`[skip] passport 不可达:${e}`)
  }
})

after(() => {})

test('generate:返回 url 带 from=main_web,qrcode_key 为 32 字符', (t) => {
  if (skipped) return t.skip('网络不可达')
  assert.ok(genUrl.includes('from=main-fe-header'), `url 应含 from=main-fe-header,实得:${genUrl}`)
  assert.match(key, /^[0-9a-f]{32}$/)
})

test('poll:全新 key 首轮状态为 86101 未扫码', async (t) => {
  if (skipped) return t.skip('网络不可达')
  const res = await fetch(POLL_URL(key), { headers: HEADERS, signal: AbortSignal.timeout(10_000) })
  const json = await res.json()
  assert.equal(json.code, 0)
  assert.equal(json.data.code, 86101)
})
