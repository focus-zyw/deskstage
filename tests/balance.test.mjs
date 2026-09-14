// 余额查询与当日消费记账的行为测试:供应商识别、响应解析、差值记账(日期翻转/
// 充值重置)、60s 节流。全部纯函数驱动,不发真实网络请求。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let mod

before(async () => {
  const mem = new Map()
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
    clear: () => mem.clear(),
  }
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  mod = await server.ssrLoadModule('/src/engine/balance.ts')
})

after(async () => {
  await server?.close()
})

test('balanceVendorOf:按 baseUrl 识别,自定义端点返回 null', () => {
  assert.equal(mod.balanceVendorOf('https://api.deepseek.com/v1'), 'deepseek')
  assert.equal(mod.balanceVendorOf('https://api.deepseek.com'), 'deepseek')
  assert.equal(mod.balanceVendorOf('https://api.moonshot.cn/v1'), 'moonshot')
  assert.equal(mod.balanceVendorOf('https://open.bigmodel.cn/api/paas/v4'), null)
  assert.equal(mod.balanceVendorOf('https://my-proxy.example.com/v1'), null)
  assert.equal(mod.balanceVendorOf('不是URL'), null)
})

test('balanceEndpoint:DeepSeek 在域根(去 /v1),Kimi 在 /v1 之下', () => {
  assert.equal(mod.balanceEndpoint('https://api.deepseek.com/v1', 'deepseek'), 'https://api.deepseek.com/user/balance')
  assert.equal(mod.balanceEndpoint('https://api.moonshot.cn/v1', 'moonshot'), 'https://api.moonshot.cn/v1/users/me/balance')
})

test('parseBalanceResponse:DeepSeek 正常解析(balance_infos 复数形,选条 CNY 且>0 优先)', () => {
  const info = mod.parseBalanceResponse('deepseek', {
    is_available: true,
    balance_infos: [
      { currency: 'USD', total_balance: '5.00', granted_balance: '0', topped_up_balance: '5.00' },
      { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
      { currency: 'CNY', total_balance: '0.00', granted_balance: '0', topped_up_balance: '0' },
    ],
  })
  assert.deepEqual(info, {
    vendorId: 'deepseek',
    isAvailable: true,
    currency: 'CNY',
    total: 110,
    granted: 10,
    toppedUp: 100,
  })
})

test('parseBalanceResponse:Kimi 读 data.available_balance', () => {
  const info = mod.parseBalanceResponse('moonshot', {
    code: 0,
    data: { currency: 'CNY', available_balance: '88.50', granted_balance: '8.50', topped_up_balance: '80' },
  })
  assert.equal(info.vendorId, 'moonshot')
  assert.equal(info.total, 88.5)
  assert.equal(info.granted, 8.5)
  assert.equal(info.toppedUp, 80)
  assert.equal(info.currency, 'CNY')
})

test('parseBalanceResponse:坏结构抛带响应摘要的可读错误,不返回半成品', () => {
  assert.throws(() => mod.parseBalanceResponse('deepseek', {}), /接口结构异常/)
  assert.throws(
    () => mod.parseBalanceResponse('deepseek', { error: 'quota' }, '{"error":"quota"}'),
    /接口结构异常.*quota/,
    '未知结构带上响应原文摘要,便于诊断',
  )
  // 旧文档别名 balance_information(单数)仍兼容
  const alias = mod.parseBalanceResponse('deepseek', {
    is_available: true,
    balance_information: [{ currency: 'CNY', total_balance: '9.90' }],
  })
  assert.equal(alias.total, 9.9)
  assert.throws(
    () => mod.parseBalanceResponse('deepseek', { balance_information: [] }, '{"balance_information":[]}'),
    /暂无余额明细/,
    '空余额明细(未产生计费)是独立场景,有专门文案',
  )
  // 形状宽容:balance_information 为单对象(非数组)时直接使用
  const asObject = mod.parseBalanceResponse('deepseek', {
    is_available: true,
    balance_information: { currency: 'CNY', total_balance: '42.00', granted_balance: '2', topped_up_balance: '40' },
  })
  assert.equal(asObject.total, 42)
  assert.equal(asObject.granted, 2)
  // 顶层直挂形态
  const topLevel = mod.parseBalanceResponse('deepseek', { is_available: true, total_balance: '7', currency: 'CNY' })
  assert.equal(topLevel.total, 7)
  // 余额字段回落:total_balance 缺失时依次试 available_balance/balance
  const fallback = mod.parseBalanceResponse('deepseek', {
    balance_information: [{ available_balance: '33' }],
  })
  assert.equal(fallback.total, 33)
  assert.throws(() => mod.parseBalanceResponse('deepseek', { balance_information: [{}] }), /接口结构异常/)
  // 网关/风控层返回的中文 message 原样透传(比"结构异常"有用)
  assert.throws(
    () => mod.parseBalanceResponse('deepseek', { message: '请求过于频繁' }, '{"message":"请求过于频繁"}'),
    /供应商返回:请求过于频繁/,
  )
  assert.throws(
    () => mod.parseBalanceResponse('deepseek', { error: { message: '无可用渠道' } }),
    /供应商返回:无可用渠道/,
  )
  assert.throws(() => mod.parseBalanceResponse('moonshot', { code: 1, message: 'invalid key' }), /invalid key/)
  assert.throws(() => mod.parseBalanceResponse('moonshot', {}), /接口结构异常/)
  // Kimi 字段宽容提取:available_balance 缺失时依次回落 total_balance/balance
  const viaTotal = mod.parseBalanceResponse('moonshot', { data: { total_balance: '50', currency: 'CNY' } })
  assert.equal(viaTotal.total, 50)
  const viaBalance = mod.parseBalanceResponse('moonshot', { data: { balance: '30' } })
  assert.equal(viaBalance.total, 30)
})

test('queryVendorBalance:未支持供应商/空 Key 直接抛错,不发请求', async () => {
  let called = 0
  const fetchImpl = () => {
    called++
    throw new Error('不应发起请求')
  }
  await assert.rejects(
    () => mod.queryVendorBalance('https://my-proxy.example.com/v1', 'sk-x', { fetchImpl }),
    /公开的余额接口/,
  )
  await assert.rejects(
    () => mod.queryVendorBalance('https://api.deepseek.com/v1', '  ', { fetchImpl }),
    /未配置 API Key/,
  )
  assert.equal(called, 0)
})

test('queryVendorBalance:带 Bearer 头发起 GET,401 转成可读文案', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push({ url, init })
    return { ok: false, status: 401, json: async () => ({}) }
  }
  await assert.rejects(
    () => mod.queryVendorBalance('https://api.deepseek.com/v1', 'sk-secret', { fetchImpl }),
    /鉴权失败/,
  )
  assert.equal(seen[0].url, 'https://api.deepseek.com/user/balance')
  assert.equal(seen[0].init.headers.Authorization, 'Bearer sk-secret')
  assert.equal(seen[0].init.method, 'GET')
})

test('queryVendorBalance:200 非 JSON 与结构异常都带响应摘要', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => 'gateway html <html>' })
  await assert.rejects(
    () => mod.queryVendorBalance('https://api.deepseek.com/v1', 'sk-x', { fetchImpl }),
    /接口返回非 JSON.*gateway/,
  )
  const fetchHtml = async () => ({ ok: true, status: 200, text: async () => '<html>登录页</html>' })
  await assert.rejects(
    () => mod.queryVendorBalance('https://api.deepseek.com/v1', 'sk-x', { fetchImpl: fetchHtml }),
    /网络返回了网页/,
  )
  const fetchImpl2 = async () => ({
    ok: true,
    status: 200,
    text: async () => '{"warning":"rate"}',
  })
  await assert.rejects(
    () => mod.queryVendorBalance('https://api.deepseek.com/v1', 'sk-x', { fetchImpl: fetchImpl2 }),
    /接口结构异常.*rate/,
  )
})

test('updateBalanceTrack:当日首次记基准,同日二次算差值,跨日重置', () => {
  const t1 = mod.updateBalanceTrack(mod.emptyBalanceTrack(), { total: 100 }, Date.UTC(2026, 8, 14, 9))
  assert.equal(t1.note, 'no-baseline')
  assert.equal(t1.todayUsage, null)
  assert.equal(t1.track.baseline, 100)

  const t2 = mod.updateBalanceTrack(t1.track, { total: 97.3 }, Date.UTC(2026, 8, 14, 15))
  assert.equal(t2.note, 'ok')
  assert.equal(t2.todayUsage, 2.7)

  const t3 = mod.updateBalanceTrack(t2.track, { total: 96 }, Date.UTC(2026, 8, 15, 8))
  assert.equal(t3.note, 'no-baseline', '日期翻转重置基准')
  assert.equal(t3.todayUsage, null)
  assert.equal(t3.track.baseline, 96)
})

test('updateBalanceTrack:余额上涨(充值)重置基准,不报负数消费', () => {
  const t1 = mod.updateBalanceTrack(mod.emptyBalanceTrack(), { total: 100 }, Date.UTC(2026, 8, 14, 9))
  const t2 = mod.updateBalanceTrack(t1.track, { total: 60 }, Date.UTC(2026, 8, 14, 12))
  assert.equal(t2.todayUsage, 40)
  const t3 = mod.updateBalanceTrack(t2.track, { total: 160 }, Date.UTC(2026, 8, 14, 13))
  assert.equal(t3.note, 'topup')
  assert.equal(t3.todayUsage, null, '充值后旧差值失真,不报')
  assert.equal(t3.track.baseline, 160, '基准重置为充值后余额')
  const t4 = mod.updateBalanceTrack(t3.track, { total: 158 }, Date.UTC(2026, 8, 14, 14))
  assert.equal(t4.todayUsage, 2)
})

test('localStorage 记账往返 + 60s 节流:窗口内复用缓存台词,过期重新查', () => {
  mod.saveBalanceTrack({ date: '2026-9-14', baseline: 100, last: 98, lastTs: 1_000 })
  const loaded = mod.loadBalanceTrack()
  assert.equal(loaded.baseline, 100)

  mod.rememberBalance(
    { vendorId: 'deepseek', isAvailable: true, currency: 'CNY', total: 98, granted: 0, toppedUp: 98 },
    '查到啦~余额 CNY 98,今天用了 2',
    5_000,
  )
  assert.equal(mod.cachedBalanceLine(5_500), '查到啦~余额 CNY 98,今天用了 2', '60s 窗口内复用')
  assert.equal(mod.cachedBalanceLine(65_000), null, '过期后需要真的发请求')
})
