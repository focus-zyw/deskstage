// 注:本文件依赖 vite 插件内联 mock @tauri-apps/* 等模块,保留 vite 自举;
// scripts/run-tests.mjs 按含 "from 'vite'" 自动分流,勿改为直接 import(会丢 mock)。
// ChatSession 网页绑定 · 清空换代与热切换释放行为矩阵(真适配器 + invoke 假件)。
// 核心回归:① 统一清空必须作废网页会话代(release 旧键标签页 + 下轮 reset 全量重建)
// ——曾因 runtime.reset() 不碰适配器,清空后旧站点线程与增量 prompt 两头错位;
// ② 绑定热切换立即 dispose 旧适配器(旧键标签页当场回收,不等 30 分钟闲置清扫)。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let mod

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
        name: 'chat-session-webchat-mocks',
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
  // 网页适配器按协议回显 ACK(listen):batchId/ackThrough 逐字取自 prompt 协议块
  globalThis.__hubMock = {
    invoke: (cmd, args) => {
      invocations.push([cmd, args])
      if (cmd === 'webchat_ask_conversation') {
        const prompt = String(args?.prompt ?? '')
        const batchId = prompt.match(/"batchId":"([^"]+)"/)?.[1] ?? 'unknown'
        const ackThrough = Number(prompt.match(/"ackThrough":(\d+)/)?.[1] ?? 1)
        return Promise.resolve(
          JSON.stringify({ protocolVersion: 1, batchId, ackThrough, decision: 'listen' }),
        )
      }
      return Promise.resolve(null)
    },
  }
  mod = await server.ssrLoadModule('/src/session/ChatSession.ts')
})

after(async () => {
  delete globalThis.__hubMock
  delete globalThis.__TAURI_INTERNALS__
  await server?.close()
})

const asks = () => invocations.filter(([c]) => c === 'webchat_ask_conversation')
const releases = () => invocations.filter(([c]) => c === 'webchat_release_conversation')

async function waitFor(fn, timeoutMs = 3000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 5))
  }
}

function makeConfig(bindingA = { kind: 'web', site: 'deepseek' }) {
  return {
    names: { a: '甲', b: '乙', c: '丙' },
    userProfile: { userName: '你' },
    characters: { C: { enabled: false } },
    model: 'test-model',
    groupChatActors: {
      engine: 'actors',
      A: { binding: bindingA, autonomy: 'natural' },
      B: { binding: { kind: 'disabled' }, autonomy: 'natural' },
      C: { binding: { kind: 'disabled' }, autonomy: 'natural' },
    },
  }
}

function makeHost() {
  return {
    names: () => ({ A: '甲', B: '乙', C: '丙' }),
    isPerforming: () => false,
    queueInterjection: () => {},
    presentTurn: () => {},
    presentUser: () => {},
    clearUser: () => {},
    presentFallback: () => {},
    onUserActive: () => {},
    onTurnSpeechStart: () => {},
  }
}

/** 受控配置源:热切换测试在两次 send 之间原地改绑定 */
let currentConfig

function makeSession() {
  const engine = {
    prepareMemory: async () => ({ selected: [], candidates: [], queriedAt: 0, promptFacts: [], refs: [] }),
    tts: { speakTracked: () => ({ started: Promise.resolve('silent'), ended: Promise.resolve(), stop: () => {} }), prefetch: () => {} },
  }
  return mod.createChatSession(makeHost(), engine, {
    config: async () => currentConfig,
  })
}

test('统一清空:网页会话作废——release 旧键标签页,下轮 reset 全量重建', async () => {
  invocations.length = 0
  currentConfig = makeConfig()
  const session = makeSession()

  await session.send('你好')
  await waitFor(() => asks().length >= 1)
  await session.whenIdle() // 等 react 收尾:invalidate 的 release 依赖已设置的 lastKey
  assert.equal(asks()[0][1].reset, false, '首轮正常续用已有会话')
  const firstKey = asks()[0][1].conversationKey

  session.reset()
  await waitFor(() => releases().length >= 1, '清空应 release 旧键')
  assert.equal(releases()[0][1].conversationKey, firstKey)

  await session.send('清空后的新话题')
  await waitFor(() => asks().length >= 2)
  assert.equal(asks()[1][1].reset, true, '换代后首轮应 reset 重建')
  assert.notEqual(asks()[1][1].conversationKey, firstKey, '会话键必须换代')
})

test('绑定热切换:旧网页适配器立即 dispose 释放,不等闲置清扫', async () => {
  invocations.length = 0
  currentConfig = makeConfig()
  const session = makeSession()

  await session.send('你好')
  await waitFor(() => asks().length >= 1)
  await session.whenIdle()
  const firstKey = asks()[0][1].conversationKey
  assert.equal(asks()[0][1].site, 'deepseek')

  currentConfig = makeConfig({ kind: 'web', site: 'qianwen' })
  await session.send('换到千问聊')
  await waitFor(() => asks().length >= 2)
  assert.equal(asks()[1][1].site, 'qianwen')
  assert.equal(releases().length >= 1, true, '换绑时应已 dispose 旧适配器')
  assert.equal(
    releases().some(([, args]) => args.conversationKey === firstKey),
    true,
    '释放的正是旧绑定的会话键',
  )
})
