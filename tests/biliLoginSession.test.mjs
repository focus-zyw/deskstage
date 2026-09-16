// 扫码登录会话回归测试:mock fetch 驱动真实 startQrLogin,锁定信封解包契约——
// 1) generate 的 data.url 必须原样交给 onQr(此前把信封当数据用,画出去的是字符串 "undefined")
// 2) 外层 code=0 而内层 data.code=86101(未扫码)时,必须继续轮询,不能误进成功分支
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

// biliLogin 用 window.setTimeout 做轮询间隔,Node 下补 shim
globalThis.window = globalThis

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const GEN_ENVELOPE = {
  code: 0,
  message: 'OK',
  data: {
    url: 'https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key=abc123def456&from=main-fe-header',
    qrcode_key: 'abc123def456',
  },
}
const POLL_PENDING_ENVELOPE = {
  code: 0,
  message: 'OK',
  data: { url: '', qrcode_key: 'abc123def456', code: 86101, message: '未扫码', timestamp: 0 },
}

let mod
let fetchCalls = []

before(async () => {
  ;({ mod } = { mod: await import('../src/live/biliLogin.ts') })
  // stub fetch:generate → 信封 gen;poll/其余(finger/spi 等)→ 恒未扫码信封
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url))
    const body = String(url).includes('/qrcode/generate') ? GEN_ENVELOPE : POLL_PENDING_ENVELOPE
    const text = JSON.stringify(body)
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => text,
      headers: { get: () => null },
    }
  }
})


test('generate 的 data.url 原样交给 onQr(信封正确解包)', async () => {
  const seen = []
  const h = mod.startQrLogin({
    onQr: (round, url) => seen.push({ round, url }),
    onPhase: () => {},
    onSuccess: () => {},
  })
  await sleep(150)
  h.cancel()
  assert.equal(seen.length, 1, '应收到一次 onQr')
  assert.equal(seen[0].round, 0)
  assert.equal(seen[0].url, GEN_ENVELOPE.data.url, 'url 必须是 data.url 原样,不能是 "undefined"')
  assert.ok(
    fetchCalls.some((u) => u.includes('generate?source=main-fe-header&go_url=')),
    'generate 应带官方参数',
  )
})

test('外层 code=0 且内层 86101 时继续轮询,不进成功分支', async () => {
  let success = 0
  const h = mod.startQrLogin({
    onQr: () => {},
    onPhase: () => {},
    onSuccess: () => success++,
  })
  await sleep(2000) // 至少经历一轮 1.5s 间隔的 poll(86101 未扫码)
  h.cancel()
  assert.equal(success, 0, '未扫码状态绝不能触发 onSuccess')
  assert.ok(
    fetchCalls.some((u) => u.includes('/qrcode/poll?qrcode_key=abc123def456&source=main-fe-header')),
    'poll 应带 qrcode_key 与 source',
  )
})
