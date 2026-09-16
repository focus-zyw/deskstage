// 注:本文件依赖 vite 插件内联 mock @tauri-apps/* 等模块,保留 vite 自举;
// scripts/run-tests.mjs 按含 "from 'vite'" 自动分流,勿改为直接 import(会丢 mock)。
// 网页 Actor Adapter · 复用已有窗口行为矩阵:invoke 参数形状/reset 语义/release 时机。
// 核心回归:前端刷新会重建 Adapter,但同键首叫不 reset——Rust Hub 的存活标签页
// 被原样复用(角色接续同一站点会话),只有显式 invalidate/失败恢复才重建。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let createWebchatActorAdapter

const invocations = []

before(async () => {
  globalThis.window = globalThis
  globalThis.__TAURI_INTERNALS__ = {}
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
            export const remove = async () => {}
            export const appDataDir = async () => '/tmp'
            export const join = async (...p) => p.join('/')
            export const emitTo = async () => {}
            export const listen = async () => () => {}
          `
        },
      },
    ],
  })
  globalThis.__hubMock = {
    invoke: (cmd, args) => {
      invocations.push([cmd, args])
      if (cmd === 'webchat_ask_conversation') {
        if (globalThis.__hubMock.onAsk) globalThis.__hubMock.onAsk()
        if (globalThis.__hubMock.failNext) {
          globalThis.__hubMock.failNext = false
          return Promise.reject(new Error('站点超时'))
        }
        return Promise.resolve(
          JSON.stringify({ protocolVersion: 1, batchId: 'A-1-2', ackThrough: 2, decision: 'listen' }),
        )
      }
      if (cmd === 'webchat_release_conversation') {
        // 门控钩子:时序测试用它推迟 release 落定
        if (globalThis.__hubMock.gateRelease) {
          return globalThis.__hubMock.gateRelease().then(() => null)
        }
        return Promise.resolve(null)
      }
      return Promise.resolve(null)
    },
  }
  const mod = await server.ssrLoadModule('/src/groupChat/adapters/webchatActor.ts')
  createWebchatActorAdapter = mod.createWebchatActorAdapter
})

after(async () => {
  delete globalThis.__hubMock
  delete globalThis.__TAURI_INTERNALS__
  await server?.close()
})

const asks = () => invocations.filter(([c]) => c === 'webchat_ask_conversation')
const releases = () => invocations.filter(([c]) => c === 'webchat_release_conversation')

function makeReq() {
  return {
    actor: 'A',
    batch: {
      id: 'A-1-2',
      actor: 'A',
      fromSeq: 1,
      throughSeq: 2,
      messages: [
        { id: 'm1', roomSeq: 1, epoch: 0, author: 'user', kind: 'chat', text: '你好', createdAt: 1, causalRootId: 'm1', depth: 0, replyTo: [] },
        { id: 'm2', roomSeq: 2, epoch: 0, author: 'user', kind: 'chat', text: '在吗', createdAt: 2, causalRootId: 'm1', depth: 0, replyTo: [] },
      ],
      primaryUserMessageId: 'm2',
      epoch: 0,
      inputHash: 'x',
    },
    maySpeak: true,
    prompt: 'p',
    messages: [],
    fullContext: true,
    chainRootId: 'm1',
    rebuildPrompt: () => ({ prompt: 'full', messages: [] }),
  }
}

function makeAdapter() {
  return createWebchatActorAdapter({
    actor: 'A',
    site: 'deepseek',
    roomId: () => 'main',
    bindingRevision: () => 'web:deepseek',
  })
}

const SIGNAL = new AbortController().signal

test('新建实例首叫不 reset(复用 Rust 侧存活标签页),续叫同键', async () => {
  const a = makeAdapter()
  await a.react(makeReq(), SIGNAL)
  assert.equal(asks()[0][1].reset, false, '首叫 reset=false:槽在则复用,槽缺则建,行为一致')
  await a.react(makeReq(), SIGNAL)
  assert.equal(asks()[1][1].reset, false)
  assert.equal(asks()[1][1].conversationKey, asks()[0][1].conversationKey, '同键续聊')
  assert.equal(releases().length, 0, '正常连续对话不释放会话')
})

test('刷新重建 Adapter 后,同键首叫复用旧槽:不 release、不换代', async () => {
  const askCountBefore = asks().length
  const releaseCountBefore = releases().length
  const a1 = makeAdapter()
  await a1.react(makeReq(), SIGNAL)
  const keyBefore = asks().at(-1)[1].conversationKey
  // 模拟前端刷新:旧实例不 dispose(页面卸载不走清理),全新实例同一绑定(键相同)
  const a2 = makeAdapter()
  await a2.react(makeReq(), SIGNAL)
  const ask = asks()[askCountBefore + 1][1]
  assert.equal(ask.conversationKey, keyBefore, '刷新后同键命中旧槽')
  assert.equal(ask.reset, false, '刷新重建不得重建标签页')
  assert.equal(releases().length - releaseCountBefore, 0, '刷新复用路径零释放')
  await a2.dispose()
  assert.equal(releases().length - releaseCountBefore, 1, '显式 dispose 仍释放会话')
})

test('显式 invalidate:release 旧键 + 换代 + 下一叫 reset 重建', async () => {
  const a = makeAdapter()
  const askCountBefore = asks().length
  const releaseCountBefore = releases().length
  await a.react(makeReq(), SIGNAL)
  const oldKey = asks().at(-1)[1].conversationKey
  a.invalidate()
  await a.react(makeReq(), SIGNAL)
  assert.equal(releases().length - releaseCountBefore, 1, '作废必须释放旧会话')
  assert.equal(releases().at(-1)[1].conversationKey, oldKey)
  const ask = asks().at(-1)[1]
  assert.notEqual(ask.conversationKey, oldKey, '换代新键')
  assert.equal(ask.reset, true, '显式作废后重建标签页')
  assert.equal(asks().length - askCountBefore, 2)
})

test('首叫失败:两段式恢复换新键全量重发恰一次', async () => {
  const a = makeAdapter()
  const askCountBefore = asks().length
  globalThis.__hubMock.failNext = true
  await a.react(makeReq(), SIGNAL)
  assert.equal(asks().length - askCountBefore, 2, '首叫失败后恰一次恢复重发')
  const first = asks()[askCountBefore][1]
  const retry = asks()[askCountBefore + 1][1]
  assert.notEqual(retry.conversationKey, first.conversationKey, '恢复换新键')
  assert.equal(retry.reset, true, '恢复重建标签页')
  assert.equal(retry.prompt, 'full', '恢复走 rebuildPrompt 全量形态')
})

test('换代后下一代 ask 等 release 落定才发出(防孤儿标签页竞态)', async () => {
  const a = makeAdapter()
  await a.react(makeReq(), SIGNAL)
  const askCountBefore = asks().length

  // 门住 release 落定:invalidate 触发 invoke 立即,但 promise 挂 30ms 才结算。
  // 若下一代 ask 不等 release,它会在 release 落定前发出 → Rust 侧旧页 claim
  // 未解除 → 认领不到 → 新建,旧页成永久孤儿(豆包"已有标签页还新建"的根因)
  let releaseSettled = false
  let askFiredAfterSettled = true
  globalThis.__hubMock.gateRelease = () =>
    new Promise((res) => {
      setTimeout(() => {
        releaseSettled = true
        res(null)
      }, 30)
    })
  globalThis.__hubMock.onAsk = () => {
    askFiredAfterSettled = releaseSettled
  }
  try {
    a.invalidate()
    await a.react(makeReq(), SIGNAL)
  } finally {
    delete globalThis.__hubMock.gateRelease
    delete globalThis.__hubMock.onAsk
  }
  assert.equal(releaseSettled, true, 'release 应已落定')
  assert.equal(askFiredAfterSettled, true, '下一代 ask 必须 wait release 落定后才发出')
  assert.equal(asks().length - askCountBefore, 1, '恰好一次换代 ask')
})
