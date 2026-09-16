// Mem0 封装层回归(假模块零依赖,不 import mem0ai):
// 工厂补丁路由 / 未配置整体停用 / 模块加载失败 fail-open / 初始化探测失败停用 /
// 写入的 role 映射与空文本过滤 / 检索的分数过滤与 limit / 配置变更后 dispose 重启 /
// 嵌入来源(云端/本地)路由与启用门槛、嵌入器指纹(纯函数)。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { createMem0Memory, MEM0_USER_ID, SEARCH_MIN_SCORE, embedderFor, coldMemoryEnabled, embedderFingerprintOf } =
  await import('../src/cold/mem0Memory.ts')

/** 假 mem0ai 模块:工厂能被补丁命中,Memory 记录调用并可编排失败。
 *  真实 Memory 的公开方法会先 _ensureInitialized(探测嵌入);假件照此模拟——
 *  search/add 前先经 EmbedderFactory 跑一次探测嵌入,embedder 挂 = 初始化失败 */
function createFakeModule(over = {}) {
  const calls = { created: [], adds: [], searches: [], llmCalls: [], embedCalls: [] }
  const mod = {
    calls,
    Memory: class {
      constructor(config) {
        calls.created.push(config)
        this._init = undefined
      }
      async ensureInit() {
        if (this._init !== undefined) return this._init
        this._init = (async () => {
          const emb = mod.EmbedderFactory.create('vcGatewayEmbedder', {})
          await emb.embed('dimension probe')
        })()
        try {
          await this._init
        } catch (e) {
          this._init = undefined
          throw e
        }
      }
      async add(messages, opts) {
        await this.ensureInit()
        if (over.addError) throw new Error('add 炸了')
        calls.adds.push({ messages, opts })
        return { results: [] }
      }
      async search(query, opts) {
        await this.ensureInit()
        if (over.searchError) throw new Error('search 炸了')
        calls.searches.push({ query, opts })
        return {
          results: [
            { memory: '用户在准备电脑维修', score: 0.72 },
            { memory: '无关记忆', score: SEARCH_MIN_SCORE - 0.01 },
            { memory: '', score: 0.9 },
          ],
        }
      }
    },
    LLMFactory: {
      create(provider) {
        calls.llmCalls.push(provider)
        if (provider === 'vcGatewayLlm') {
          return {
            generateResponse: async (messages, responseFormat) => {
              calls.llmInvoke = { messages, jsonMode: responseFormat?.type === 'json_object' }
              return '{"memory":[]}'
            },
            generateChat: async () => ({ content: 'ok', role: 'assistant' }),
          }
        }
        return {}
      },
    },
    EmbedderFactory: {
      create(provider) {
        if (provider === 'vcGatewayEmbedder') {
          return {
            embed: async (text) => {
              if (over.embedError) throw new Error('embed 炸了')
              calls.embedCalls.push(text)
              return [1, 0]
            },
            embedBatch: async (texts) => {
              if (over.embedError) throw new Error('embed 炸了')
              calls.embedCalls.push(...texts)
              return texts.map(() => [1, 0])
            },
          }
        }
        return {}
      },
    },
    VectorStoreFactory: {
      create() {
        return {
          initialize: async () => {},
          insert: async () => {},
          search: async () => [],
          get: async () => null,
          update: async () => {},
          delete: async () => {},
          deleteCol: async () => {},
          list: async () => [[], 0],
          getUserId: async () => '',
          setUserId: async () => {},
        }
      },
    },
    ...(over.moduleError ? {} : {}),
  }
  if (over.moduleError) mod.Memory = undefined // 加载即失败的情形由 loadModule 抛错模拟
  return mod
}
const SETTINGS = { embedProfile: 'embed', embedModel: 'text-embedding-3-small' }

function create(mem0Over = {}, settings = SETTINGS) {
  const mem0 = createFakeModule(mem0Over)
  const llmInput = []
  const embedInput = []
  const store = createMem0Memory({
    loadModule: async () => (mem0Over.loadError ? Promise.reject(new Error('模块加载失败')) : mem0),
    completeLLM: async (input) => {
      llmInput.push(input)
      return '{}'
    },
    embedBatch: async (texts, cfg) => {
      embedInput.push({ texts, cfg })
      if (mem0Over.embedTransportError) throw new Error('embeddings 端点挂了')
      return texts.map(() => [1, 0])
    },
    vectorIO: (() => {
      let f = null
      return { read: async () => f, write: async (x) => void (f = x) }
    })(),
    settings: async () => settings,
  })
  return { store, mem0, llmInput, embedInput }
}

test('未配置 embedder:整体停用(off),读写都是 no-op', async () => {
  const { store, mem0 } = create({}, null)
  assert.equal(await store.probeStatus(), 'off')
  assert.equal(await store.addExperienceTurns([{ who: 'user', text: '明天去修电脑', ts: 1 }]), false)
  assert.deepEqual(await store.searchExperiences('修电脑'), [])
  assert.equal(mem0.calls.created.length, 0) // Memory 从未被构造
})

test('模块加载失败:fail-open,不抛不炸', async () => {
  const { store } = create({ loadError: true })
  assert.equal(await store.probeStatus(), 'error')
  assert.equal(await store.addExperienceTurns([{ who: 'user', text: 'x', ts: 1 }]), false)
  assert.deepEqual(await store.searchExperiences('x'), [])
})

test('embedder 端点失败(初始化探测不过):停用;配置修正后 dispose 可重试', async () => {
  const { store } = create({ embedTransportError: true })
  assert.equal(await store.probeStatus(), 'error')
  assert.deepEqual(await store.searchExperiences('x'), [])
})

test('正常初始化:工厂补丁命中 marker,Memory 拿到网关配置且 disableHistory', async () => {
  const { store, mem0 } = create()
  assert.equal(await store.probeStatus(), 'ready')
  const cfg = mem0.calls.created[0]
  assert.equal(cfg.disableHistory, true)
  assert.equal(cfg.llm.provider, 'vcGatewayLlm')
  assert.equal(cfg.embedder.provider, 'vcGatewayEmbedder')
  assert.equal(cfg.vectorStore.provider, 'vcFileVector')
  assert.ok(mem0.calls.searches.length >= 1) // 初始化探测发生过
})

test('写入:who→role 映射、空文本过滤、挂 user scope', async () => {
  const { store, mem0 } = create()
  await store.addExperienceTurns([
    { who: 'user', text: '明天我要去修电脑', ts: 1 },
    { who: 'A', text: '祝顺利!', ts: 2 },
    { who: 'B', text: '   ', ts: 3 },
  ])
  assert.equal(mem0.calls.adds.length, 1)
  const { messages, opts } = mem0.calls.adds[0]
  assert.deepEqual(messages, [
    { role: 'user', content: '明天我要去修电脑' },
    { role: 'assistant', content: '祝顺利!' },
  ])
  assert.equal(opts.userId, MEM0_USER_ID)
})

test('写入失败与全空批次:返回 false 不抛', async () => {
  const { store } = create({ addError: true })
  assert.equal(await store.addExperienceTurns([{ who: 'user', text: 'x', ts: 1 }]), false)
  const { store: store2, mem0 } = create()
  assert.equal(await store2.addExperienceTurns([{ who: 'user', text: '  ', ts: 1 }]), false)
  assert.equal(mem0.calls.adds.length, 0)
})

test('检索:分数过滤 + 空文本剔除 + limit 透传', async () => {
  const { store, mem0 } = create()
  const out = await store.searchExperiences('电脑修得怎么样了', 3)
  assert.deepEqual(out, ['用户在准备电脑维修']) // 低分与空文本都被滤掉
  assert.equal(mem0.calls.searches.at(-1).opts.topK, 3)
  assert.equal(mem0.calls.searches.at(-1).opts.filters.user_id, MEM0_USER_ID)
})

test('检索失败:返回 [] 不抛', async () => {
  const { store } = create({ searchError: true })
  assert.deepEqual(await store.searchExperiences('x'), [])
})

// ---- 嵌入来源(云端/本地)路由、启用门槛、嵌入器指纹(纯函数) ----

test('嵌入来源路由:provider=local 命中本地,其余(含缺省)走云端', () => {
  assert.equal(embedderFor({ provider: 'local' }), 'local')
  assert.equal(embedderFor({ provider: 'endpoint', embedProfile: 'p', embedModel: 'm' }), 'endpoint')
  assert.equal(embedderFor({}), 'endpoint')
  assert.equal(embedderFor({ embedProfile: 'p', embedModel: 'm' }), 'endpoint')
})

test('启用门槛:local 选了即启用(localUrl 空时有缺省地址);endpoint 需档案+模型名齐全', () => {
  assert.equal(coldMemoryEnabled({ provider: 'local' }), true)
  assert.equal(coldMemoryEnabled({ provider: 'local', localUrl: 'http://127.0.0.1:9990/v1' }), true)
  assert.equal(coldMemoryEnabled({}), false)
  assert.equal(coldMemoryEnabled({ embedProfile: 'p' }), false)
  assert.equal(coldMemoryEnabled({ embedModel: 'm' }), false)
  assert.equal(coldMemoryEnabled({ embedProfile: 'p', embedModel: 'm' }), true)
  assert.equal(coldMemoryEnabled(null), false)
})

test('嵌入器指纹:local 与云端格式不同,来源/模型变化即换指纹', () => {
  assert.equal(embedderFingerprintOf({ provider: 'local', embedModel: 'bge' }), 'local:bge')
  assert.equal(embedderFingerprintOf({ provider: 'local' }), 'local:')
  assert.equal(embedderFingerprintOf({ embedProfile: 'p', embedModel: 'm' }), 'endpoint:p/m')
  assert.notEqual(
    embedderFingerprintOf({ provider: 'local', embedModel: 'bge' }),
    embedderFingerprintOf({ embedProfile: 'p', embedModel: 'bge' }),
  )
})
