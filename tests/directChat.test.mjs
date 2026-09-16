// 单聊(direct)会话行为矩阵:1对1直答房间——只该角色参与、原始文本直答(无
// decision 协议)、sessionId 落盘可按房间取回、历史引导按房间过滤、面板模式零 TTS。
// mock 文件系统模拟 chatlog.jsonl:append/read 走真实 chatLogStore 代码路径。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let mod
let createFakeActorAdapter
let schema
let store

const files = new Map()

before(async () => {
  globalThis.window = globalThis
  // 直接 mock Tauri IPC 面(真实 @tauri-apps api/plugin 都走它):plugin:fs 命令落到内存文件表
  globalThis.__TAURI_INTERNALS__ = {
    transformCallback: (cb) => cb,
    metadata: { currentWindow: { label: 'main' } },
    invoke: (cmd, args, meta) => globalThis.__dcMock.invoke(cmd, args ?? {}, meta ?? {}),
  }
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
    ssr: { noExternal: ['@tauri-apps/api'] },
  })
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  globalThis.__dcMock = {
    invoke: (cmd, args, meta) => {
      const arg = args ?? {}
      // plugin:path:目录解析/join 退化为本地拼串(真实 Rust 端在 mock 里不可用)
      if (cmd === 'plugin:path|resolve_directory') return 'C:/mock/data'
      if (cmd === 'plugin:path|join') return (arg.paths ?? []).filter((x) => typeof x === 'string').join('/')
      // plugin:fs 的路径位置按命令分叉(与真实 plugin-fs 2.5 传输一致):
      // write 走 meta.headers.path(URI 编码)+ 正文=字节 array;read/exists/remove 走 args.path
      const pathOf = () => {
        const hp = meta?.headers?.path
        if (hp !== undefined) return decodeURIComponent(hp)
        return String(arg.path ?? '')
      }
      if (cmd === 'plugin:fs|write_text_file') {
        const path = pathOf()
        const opts = meta?.headers?.options ? JSON.parse(meta.headers.options) : {}
        const append = opts.append === true
        const text = decoder.decode(Uint8Array.from(args ?? []))
        files.set(path, (append ? (files.get(path) ?? '') : '') + text)
        return null
      }
      if (cmd === 'plugin:fs|read_text_file') return [...encoder.encode(files.get(pathOf() ?? '') ?? '')]
      if (cmd === 'plugin:fs|exists') return files.has(pathOf())
      if (cmd === 'plugin:fs|remove') {
        files.delete(pathOf())
        return null
      }
      return null
    },
  }
  mod = await server.ssrLoadModule('/src/session/directSession.ts')
  const fake = await server.ssrLoadModule('/src/groupChat/adapters/fakeActor.ts')
  createFakeActorAdapter = fake.createFakeActorAdapter
  schema = await server.ssrLoadModule('/src/groupChat/actorSchema.ts')
  store = await server.ssrLoadModule('/src/storage/chatLogStore.ts')
})

after(async () => {
  delete globalThis.__dcMock
  delete globalThis.__TAURI_INTERNALS__
  await server?.close()
})

function deferred() {
  let resolve
  const promise = new Promise((res) => {
    resolve = res
  })
  return { promise, resolve }
}

async function waitFor(fn, timeoutMs = 3000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const CFG = () => ({
  names: { a: '小哀', b: '柯南', c: '大肥鱼' },
  userProfile: { userName: 'focus' },
  characters: { C: { enabled: true } },
  model: 'test-model',
  groupChatActors: {
    engine: 'actors',
    A: { binding: { kind: 'api' }, autonomy: 'natural' },
    B: { binding: { kind: 'api' }, autonomy: 'natural' },
    C: { binding: { kind: 'api' }, autonomy: 'natural' },
  },
})

/** plain 模式适配器:模型原始文本直答,适配层包成 speak(与真实 apiActor plain 语义一致) */
function plainAdapter(calls) {
  return {
    prefersFullContext: () => true,
    async react(req) {
      calls.push(req)
      return schema.plainSpeakReaction(`收到:${req.batch.messages.at(-1).text}`, req.batch)
    },
  }
}

function makeSession(slot, adapters, over = {}) {
  const host = { fallbacks: [], presentFallback: (line) => host.fallbacks.push(line) }
  const engine = {
    ttsCalls: [],
    prepareMemory: async () => ({ selected: [], candidates: [], queriedAt: 0, promptFacts: [], refs: [] }),
    tts: {
      speakTracked: (who, text) => {
        engine.ttsCalls.push({ who, text })
        const gate = deferred()
        return { started: Promise.resolve('audible'), ended: gate.promise, stop: () => gate.resolve() }
      },
      prefetch: () => {},
    },
    ...over.engine,
  }
  const session = mod.createDirectSession(slot, {
    clock: { now: () => Date.now(), setTimeout(fn) { const id = setTimeout(fn); return () => clearTimeout(id) } },
    config: async () => CFG(),
    adapters,
    presentFallback: host.presentFallback,
    ...over.opts,
  })
  return { session, host, engine }
}

test('单聊只该角色参与:其余角色适配器零调用', async () => {
  const calls = []
  const adA = plainAdapter(calls)
  const adB = createFakeActorAdapter([])
  const adC = createFakeActorAdapter([])
  const { session } = makeSession('A', { A: adA, B: adB, C: adC })
  assert.equal(await session.send('在吗'), 'accepted')
  await waitFor(() => calls.length >= 1)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(adB.calls.length, 0, '单聊里柯南必须零调用')
  assert.equal(adC.calls.length, 0, '单聊里大肥鱼必须零调用')
  await session.whenIdle()
})

test('原始文本直答:无协议块、一次成功,prompt 标明 1对1', async () => {
  const calls = []
  const adA = plainAdapter(calls)
  const { session } = makeSession('A', { A: adA })
  await session.send('今天好累')
  await waitFor(() => calls.length >= 1)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(calls.length, 1, '直答一次成功,无重试')
  const msgs = JSON.stringify(calls[0].messages)
  assert.ok(!msgs.includes('protocolVersion'), '单聊 prompt 无输出协议块')
  assert.ok(!msgs.includes('batchId'), '单聊 prompt 无 batchId 回显要求')
  assert.ok(msgs.includes('单独聊天'), '单聊 prompt 标明 1对1 语境')
  await session.whenIdle()
})

test('sessionId 落盘 direct:<slot>:用户消息与回复均可按房间取回', async () => {
  const calls = []
  const adA = plainAdapter(calls)
  const { session } = makeSession('B', { B: adA })
  await session.send('柯南在吗')
  await waitFor(() => calls.length >= 1)
  await new Promise((r) => setTimeout(r, 60))
  const roomTurns = await store.listChatTurns(100, 'direct:B')
  assert.ok(roomTurns.length >= 2, '用户消息与回复都已按房间落盘')
  assert.equal(roomTurns.at(-2).who, 'user')
  assert.equal(roomTurns.at(-1).who, 'B')
  // 群聊房间过滤取不到单聊消息(房间隔离)
  const groupTurns = await store.listChatTurns(100, 'group:main')
  assert.equal(
    groupTurns.some((t) => t.text === '柯南在吗'),
    false,
    '单聊消息不得混入群聊房间',
  )
  await session.whenIdle()
})

test('面板模式:回复零 TTS 调用', async () => {
  const calls = []
  const adA = plainAdapter(calls)
  const { engine, session } = makeSession('A', { A: adA })
  await session.send('说句悄悄话')
  await waitFor(() => calls.length >= 1)
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(engine.ttsCalls.length, 0, '面板模式回复不朗读')
  await session.whenIdle()
})

test('bootstrap 按房间过滤:单聊上下文不含群聊消息', async () => {
  // 预置:群聊房间一条 + direct:C 房间一条
  await store.appendChatTurns([
    { who: 'user', text: '群里的消息大家好', ts: 1, sessionId: 'group:main', roomSeq: 1 },
    { who: 'C', text: '单聊历史大肥鱼说过的话', ts: 2, sessionId: 'direct:C', roomSeq: 1 },
  ])
  const calls = []
  const adC = plainAdapter(calls)
  const { session } = makeSession('C', { C: adC })
  // 等工厂的历史引导(异步 listChatTurns)先落定——真实使用中打开面板到发送远大于一次读
  await new Promise((r) => setTimeout(r, 60))
  await session.send('新的一句话')
  await waitFor(() => calls.length >= 1)
  const ctx = JSON.stringify(calls[0].messages)
  assert.ok(ctx.includes('单聊历史大肥鱼说过的话'), '引导历史含本房间消息')
  assert.ok(!ctx.includes('群里的消息大家好'), '引导历史不含群聊房间消息')
  assert.deepEqual(
    calls[0].batch.messages.map((m) => m.text),
    ['新的一句话'],
    '新批次只含新消息',
  )
  await session.whenIdle()
})

test('apiActor plain 模式必须关闭 JSON 模式(守卫)', async () => {
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(
    new URL('../src/groupChat/adapters/apiActor.ts', import.meta.url),
    'utf8',
  )
  assert.match(
    src,
    /jsonMode:\s*opts\.protocol !== 'plain'/,
    'response_format json_object 会逼模型自造 JSON,plain 直答必须关闭',
  )
})
