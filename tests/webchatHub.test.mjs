// 网页会话 Hub 前端薄封装验收:invoke 参数形状、取消语义(abort → webchat_cancel
// →「已取消」还原 AbortError)、「发送后页面丢失」typed error 原样透传、release。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let mod

before(async () => {
  // webchatHub 依赖 configStore 的 inTauri(检测 __TAURI_INTERNALS__):测试里装一个
  globalThis.window = globalThis
  globalThis.__TAURI_INTERNALS__ = {}
  globalThis.__hubMock = { invocations: [], byRequest: new Map() }
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
    ssr: { noExternal: ['@tauri-apps/api'] },
    plugins: [
      {
        name: 'hub-mocks',
        enforce: 'pre',
        resolveId(id) {
          if (id.startsWith('@tauri-apps/')) return `\0mock:${id}`
        },
        load(id) {
          if (!id.startsWith('\0mock:@tauri-apps/')) return undefined
          return `
            export const invoke = (...a) => globalThis.__hubMock.invoke(...a)
            export const getCurrentWindow = () => ({ hide: async () => {}, show: async () => {} })
            export const readTextFile = async () => ''
            export const writeTextFile = async () => {}
            export const exists = async () => false
            export const mkdir = async () => {}
            export const appDataDir = async () => '/tmp'
            export const join = async (...p) => p.join('/')
            export const emitTo = async () => {}
            export const listen = async () => () => {}
          `
        },
      },
    ],
  })
  globalThis.__hubMock.invoke = (cmd, args) => {
    const m = globalThis.__hubMock
    m.invocations.push([cmd, args])
    if (cmd === 'webchat_ask_conversation') {
      const pending = m.byRequest.get('script')
      if (pending) return pending(args)
    }
    if (cmd === 'webchat_cancel') {
      const cancel = m.byRequest.get('cancel')
      if (cancel) cancel(args)
      return Promise.resolve()
    }
    return Promise.resolve(null)
  }
  mod = await server.ssrLoadModule('/src/engine/webchatHub.ts')
})

after(async () => {
  delete globalThis.__hubMock
  await server?.close()
})

const ask = (over = {}) =>
  mod.askConversation({
    conversationKey: 'relay:e1:A',
    site: 'deepseek',
    prompt: '开场',
    timeoutMs: 5_000,
    ...over,
  })

test('参数形状与 requestId 形态', async () => {
  const m = globalThis.__hubMock
  m.byRequest.set('script', () => Promise.resolve('台词'))
  const out = await ask({ reset: false })
  assert.equal(out, '台词')
  const [cmd, args] = m.invocations.find((x) => x[0] === 'webchat_ask_conversation')
  assert.equal(cmd, 'webchat_ask_conversation')
  assert.equal(args.conversationKey, 'relay:e1:A')
  assert.equal(args.site, 'deepseek')
  assert.equal(args.prompt, '开场')
  assert.equal(args.timeoutMs, 5000)
  assert.equal(args.reset, false)
  assert.match(args.requestId, /^conv-/)
})

test('reset 显式传递', async () => {
  const m = globalThis.__hubMock
  m.byRequest.set('script', () => Promise.resolve('恢复'))
  m.invocations.length = 0
  await ask({ reset: true })
  assert.equal(m.invocations.find((x) => x[0] === 'webchat_ask_conversation')[1].reset, true)
})

test('abort → webchat_cancel;「已取消」还原为 AbortError', async () => {
  const m = globalThis.__hubMock
  const ctrl = new AbortController()
  m.byRequest.set('script', () => {
    m.byRequest.set('cancel', () => {
      const c = m.byRequest.get('reject')
      if (c) c('已取消')
    })
    return new Promise((_, reject) => m.byRequest.set('reject', reject))
  })
  m.invocations.length = 0
  const p = ask({ signal: ctrl.signal })
  ctrl.abort() // 模拟用户停止:signal 触发 → 前端通知 Rust → Rust 回「已取消」
  const r = await p.then(
    () => 'ok',
    (e) => ({ name: e.name, message: e.message }),
  )
  assert.equal(r.name, 'AbortError')
  assert.ok(m.invocations.some(([cmd]) => cmd === 'webchat_cancel'), 'abort 必须通知 Rust 取消')
})

test('「发送后页面丢失」原样透传(调用方按 typed error 恢复)', async () => {
  const m = globalThis.__hubMock
  m.byRequest.set('script', () => Promise.reject(new Error('发送后页面丢失')))
  await assert.rejects(ask(), /发送后页面丢失/)
})

test('releaseConversation 走 webchat_release_conversation', async () => {
  const m = globalThis.__hubMock
  m.invocations.length = 0
  mod.releaseConversation('relay:e1:A')
  await new Promise((r) => setTimeout(r, 10))
  const rel = m.invocations.find(([cmd]) => cmd === 'webchat_release_conversation')
  assert.equal(rel[1].conversationKey, 'relay:e1:A')
})
