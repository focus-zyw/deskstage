// 扫码登录的 crossDomain 链接解析测试:重点保护 SESSDATA 里的特殊字符
// (%2C 转义符、'+' 不得被当空格)与缺字段/坏链接的容错。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let mod

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  ;({ mod } = { mod: await server.ssrLoadModule('/src/live/biliLogin.ts') })
})

after(async () => {
  await server?.close()
})

test('解析完整 crossDomain 链接:cookie 拼接 + uid', () => {
  const url =
    'https://passport.biligame.com/crossDomain?DedeUserID=12345&DedeUserIDxxHash=abc&SESSDATA=' +
    encodeURIComponent('aa%2Cbb+cc,dd*Ce') +
    '&bili_jct=jcttoken&accountType=6&gourl=https%3A%2F%2Fwww.bilibili.com'
  const r = mod.cookieFromCrossUrl(url)
  assert.ok(r)
  assert.equal(r.uid, 12345)
  // SESSDATA 原样保留:'+' 不准变空格,%2C 解码一次成字面逗号
  assert.equal(r.cookie, 'DedeUserID=12345; SESSDATA=aa%2Cbb+cc,dd*Ce; bili_jct=jcttoken')
})

test('缺 SESSDATA / 缺 DedeUserID / 坏链接 返回 null', () => {
  assert.equal(mod.cookieFromCrossUrl('https://x.com/crossDomain?bili_jct=only'), null)
  assert.equal(mod.cookieFromCrossUrl('https://x.com/crossDomain?SESSDATA=only'), null)
  assert.equal(mod.cookieFromCrossUrl('not a url'), null)
  assert.equal(mod.cookieFromCrossUrl(''), null)
})
