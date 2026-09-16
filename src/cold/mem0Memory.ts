// Cold 记忆(Mem0)封装:经历/事件/关系记忆的唯一出入口。mem0ai OSS 提供记忆
// 管线(LLM 抽取 → 与旧记忆比对裁决 ADD/UPDATE/DELETE/NOOP → 向量检索);本模块
// 把它的三个外部依赖全部换成项目自有通道:
//   LLM        → llmGateway.complete(主对话档案;Key 在 Rust 凭据库,走端点代理)
//   embeddings → 按来源分发:云端端点代理 /embeddings(独立可配置档案)或本地
//                llama-server(localEmbeddingService,手动启动;见
//                docs/经历记忆本地嵌入设计方案.md);浏览器预览走原生 fetch
//   向量库     → data/mem0-vectors.json(vectorFileStore,替代 better-sqlite3)
// mem0ai 的工厂是封闭 switch,注入靠初始化时对静态 create 打补丁(marker 路由);
// better-sqlite3 是模块顶层静态导入,webview 无法执行——vite alias 指向桩
// (src/shims/better-sqlite3.ts),配合 disableHistory + 自定义向量库它永不执行。
// 换嵌入来源/模型 = 换向量空间:向量库带嵌入器指纹(vectorFileStore),不匹配即重开。
//
// fail-open 纪律:embedder 未配置 / 模块加载失败 / 初始化探测失败 / 任何调用失败
// → 整体停用(检索返回空、写入记 false),Warm 摘要照常工作,绝不影响聊天。
import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import { getConfig, inTauri } from '../storage/configStore'
import { complete } from '../engine/llmGateway'
import { requestEndpoint } from '../engine/endpointProxy'
import { withFileLock } from '../storage/writeLock'
import { createFileVectorStore, sanitizeVectorsFile, type VectorStoreIO, type VectorsFile } from './vectorFileStore'
import { localEmbedding } from '../engine/localEmbedding'

/** 单用户应用:全部经历记忆挂同一 scope */
export const MEM0_USER_ID = 'audience'
/** 检索分数下限(余弦);低于此不入注入,避免语义无关的经历混进上下文 */
export const SEARCH_MIN_SCORE = 0.3

export interface ExperienceTurn {
  /** 'user' | 'A' | 'B' | 'C' */
  who: string
  text: string
  ts: number
}

type FactoryLike = { create: (provider: string, config: unknown) => unknown }

interface Mem0Client {
  add(messages: Array<{ role: string; content: string }>, opts: Record<string, unknown>): Promise<{ results?: Array<{ memory?: string; score?: number }> }>
  search(query: string, opts: Record<string, unknown>): Promise<{ results?: Array<{ memory?: string; score?: number }> }>
}

interface Mem0ModuleLike {
  Memory: new (config: unknown) => Mem0Client
  LLMFactory: FactoryLike
  EmbedderFactory: FactoryLike
  VectorStoreFactory: FactoryLike
}

export interface ColdMemorySettings {
  /** 嵌入来源:'endpoint' 云端档案(缺省);'local' 本地 llama-server(手动启动) */
  provider?: 'endpoint' | 'local'
  /** endpoint 模式:embeddings 走哪个模型档案(Rust 按 modelProfiles 解析地址与 Key) */
  embedProfile?: string
  /** endpoint 必填(如 text-embedding-3-small);local 选填(llama-server 单模型) */
  embedModel?: string
  /** local 模式:llama-server 服务地址;空则用缺省(http://127.0.0.1:8080/v1) */
  localUrl?: string
}

export interface Mem0Memory {
  /** 折叠批次写入(抽帧裁决全交 Mem0);false = 未启用或失败 */
  addExperienceTurns(turns: readonly ExperienceTurn[]): Promise<boolean>
  /** 经历检索;失败/未启用返回 [] */
  searchExperiences(query: string, limit?: number): Promise<string[]>
  /** 设置页状态:off=未配置,error=配置了但初始化失败,ready=可用 */
  probeStatus(): Promise<'off' | 'error' | 'ready'>
  /** 配置变更后重置(下次使用时按新配置重新初始化) */
  dispose(): void
}

export interface Mem0MemoryDeps {
  /** 默认 () => import('mem0ai/oss');测试注入假模块零依赖 */
  loadModule?: () => Promise<Mem0ModuleLike>
  /** 网关补全;默认走 llmGateway.complete */
  completeLLM?: (input: { messages: Array<{ role: string; content: string }>; jsonMode: boolean }) => Promise<string>
  /** 批量嵌入;默认走端点代理 /embeddings */
  embedBatch?: (texts: string[], settings: ColdMemorySettings) => Promise<number[][]>
  /** 向量库持久化;默认 data/mem0-vectors.json */
  vectorIO?: VectorStoreIO
  /** Cold 记忆设置;null/缺字段 = 未配置不启用 */
  settings?: () => Promise<ColdMemorySettings | null>
}

const COLLECTION = 'vc_experiences'

/** 工厂补丁:provider 命中 marker 返回注入实例,否则走原实现 */
function patchFactory(factory: FactoryLike, marker: string, instance: unknown): void {
  const original = factory.create.bind(factory)
  factory.create = (provider: string, config: unknown) =>
    provider === marker ? instance : original(provider, config)
}

// ---------- 生产接线(默认依赖) ----------

async function gatewayLLMComplete(input: { messages: Array<{ role: string; content: string }>; jsonMode: boolean }): Promise<string> {
  return await complete({
    messages: input.messages,
    jsonMode: input.jsonMode,
    temperature: 0,
    maxTokens: 2000,
    timeoutMs: 30_000,
  })
}

async function endpointEmbedBatch(texts: string[], settings: ColdMemorySettings): Promise<number[][]> {
  const body = JSON.stringify({ model: settings.embedModel, input: texts })
  let raw: string
  if (!inTauri) {
    // 浏览器预览:原生 fetch(开发调试用;靠对方 CORS 头)
    const cfg = await getConfig()
    const profile = settings.embedProfile && settings.embedProfile !== 'main' ? cfg.modelProfiles?.[settings.embedProfile] : undefined
    const baseUrl = profile?.baseUrl || cfg.baseUrl
    const res = await fetch(`${baseUrl}/embeddings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    raw = await res.text()
    if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`)
  } else {
    // 桌面端:配置端点代理(地址/Key 由 Rust 按 profile 解析,前端不碰密钥)
    const { status, body: bytes } = await requestEndpoint('llm', '/embeddings', {
      body,
      timeoutMs: 30_000,
      profile: settings.embedProfile,
    })
    if (status < 200 || status >= 300) throw new Error(`embeddings HTTP ${status}`)
    raw = new TextDecoder().decode(bytes)
  }
  const data = (JSON.parse(raw) as { data?: { index?: number; embedding?: number[] }[] })?.data
  if (!Array.isArray(data) || data.length === 0) throw new Error('embeddings 响应不合法')
  return [...data]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((d) => d.embedding ?? [])
}

/** 嵌入来源路由:'local' 走本地 llama-server,其余(含缺省)走云端档案 */
export function embedderFor(settings: ColdMemorySettings): 'endpoint' | 'local' {
  return settings.provider === 'local' ? 'local' : 'endpoint'
}

/** 启用门槛:local 模式选了即启用(localUrl 空时有缺省地址);endpoint(缺省)需
 *  档案 + 模型名齐全才启用,缺任一整体停用 */
export function coldMemoryEnabled(settings: ColdMemorySettings | null | undefined): settings is ColdMemorySettings {
  if (!settings) return false
  if (embedderFor(settings) === 'local') return true
  return Boolean(settings.embedProfile && settings.embedModel)
}

/** 嵌入器指纹:换来源/模型 = 换向量空间,向量库凭它识别并重开(vectorFileStore 守卫)。
 *  local 模式 llama-server 忽略 model 名,指纹只能按填写的名字——同地址悄悄换 gguf
 *  检测不到,设置页提示换模型后自行清空经历记忆 */
export function embedderFingerprintOf(settings: ColdMemorySettings): string {
  if (embedderFor(settings) === 'local') return `local:${settings.embedModel ?? ''}`
  return `endpoint:${settings.embedProfile ?? ''}/${settings.embedModel ?? ''}`
}

/** 生产嵌入分发:按 settings.provider 路由到本地服务或云端档案通道 */
async function productionEmbedBatch(texts: string[], settings: ColdMemorySettings): Promise<number[][]> {
  if (embedderFor(settings) === 'local') return await localEmbedding.embedBatch(texts, settings)
  return await endpointEmbedBatch(texts, settings)
}

const VECTOR_FILE = 'mem0-vectors.json'
const VECTOR_LS_KEY = 'vc-mem0-vectors'

const productionVectorIO: VectorStoreIO = {
  async read(): Promise<VectorsFile | null> {
    if (!inTauri) {
      try {
        const raw = localStorage.getItem(VECTOR_LS_KEY)
        return raw ? sanitizeVectorsFile(JSON.parse(raw)) : null
      } catch {
        return null
      }
    }
    try {
      const base = await appDataDir()
      const file = await join(base, 'data', VECTOR_FILE)
      if (await exists(file)) return sanitizeVectorsFile(JSON.parse(await readTextFile(file)))
    } catch {
      // 坏档按空库处理
    }
    return null
  },
  async write(file: VectorsFile): Promise<void> {
    await withFileLock('mem0-vectors', async () => {
      if (!inTauri) {
        try {
          localStorage.setItem(VECTOR_LS_KEY, JSON.stringify(file))
        } catch {
          /* ignore */
        }
        return
      }
      try {
        const base = await appDataDir()
        const dir = await join(base, 'data')
        if (!(await exists(dir))) await mkdir(dir, { recursive: true })
        await writeTextFile(await join(dir, VECTOR_FILE), JSON.stringify(file))
      } catch (e) {
        console.warn('Mem0 向量库落盘失败(静默)', e)
      }
    })
  },
}

function productionSettings(): () => Promise<ColdMemorySettings | null> {
  return async () => {
    const cfg = await getConfig()
    const cold = (cfg as { coldMemory?: ColdMemorySettings }).coldMemory
    return coldMemoryEnabled(cold) ? cold : null
  }
}

// ---------- 核心创建 ----------

export function createMem0Memory(deps: Mem0MemoryDeps = {}): Mem0Memory {
  const loadModule = deps.loadModule ?? (async () => (await import('mem0ai/oss')) as unknown as Mem0ModuleLike)
  const completeLLM = deps.completeLLM ?? gatewayLLMComplete
  const embedBatch = deps.embedBatch ?? productionEmbedBatch
  const vectorIO = deps.vectorIO ?? productionVectorIO
  const settingsOf = deps.settings ?? productionSettings()

  let initPromise: Promise<Mem0Client | null> | null = null

  async function initOnce(): Promise<Mem0Client | null> {
    if (initPromise) return initPromise
    initPromise = (async () => {
      const settings = await settingsOf()
      if (!settings) return null
      const mod = await loadModule()
      // 嵌入器指纹:来源/模型变化时向量库自动重开(换空间旧向量不可比)
      const store = createFileVectorStore(vectorIO, COLLECTION, embedderFingerprintOf(settings))
      patchFactory(mod.LLMFactory, 'vcGatewayLlm', {
        generateResponse: async (messages: Array<{ role: string; content: string }>, responseFormat?: { type: string }) =>
          await completeLLM({ messages, jsonMode: responseFormat?.type === 'json_object' }),
        generateChat: async (messages: Array<{ role: string; content: string }>) => ({
          content: await completeLLM({ messages, jsonMode: false }),
          role: 'assistant',
        }),
      })
      patchFactory(mod.EmbedderFactory, 'vcGatewayEmbedder', {
        embed: async (text: string) => (await embedBatch([text], settings))[0] ?? [],
        embedBatch: (texts: string[]) => embedBatch(texts, settings),
      })
      patchFactory(mod.VectorStoreFactory, 'vcFileVector', store)
      const mem = new mod.Memory({
        disableHistory: true,
        customInstructions: '观众是桌宠应用的玩家;记录关于观众本人、共同经历与角色经历的事实。',
        llm: { provider: 'vcGatewayLlm', config: {} },
        embedder: { provider: 'vcGatewayEmbedder', config: {} },
        vectorStore: { provider: 'vcFileVector', config: { collectionName: COLLECTION } },
      })
      // 初始化探测:走一遍 嵌入→检索,embedder/端点/向量库任一失败在此暴露
      await mem.search('初始化探测', { filters: { user_id: MEM0_USER_ID }, topK: 1, threshold: SEARCH_MIN_SCORE })
      return mem
    })()
    try {
      return await initPromise
    } catch (e) {
      console.warn('Mem0 初始化失败(经历记忆停用,Warm 不受影响)', e)
      initPromise = null // 允许配置修正后重试
      return null
    }
  }

  return {
    async addExperienceTurns(turns) {
      const mem = await initOnce()
      if (!mem) return false
      const messages = turns
        .filter((t) => t.text.trim())
        .map((t) => ({ role: t.who === 'user' ? 'user' : 'assistant', content: t.text }))
      if (messages.length === 0) return false
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const guard = new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error('Mem0 写入超时')), 120_000)
        })
        try {
          await Promise.race([mem.add(messages, { userId: MEM0_USER_ID }), guard])
        } finally {
          clearTimeout(timer) // 守护不外溢:race 结束即清,避免悬挂定时器拖住进程/未处理拒绝
        }
        return true
      } catch (e) {
        console.warn('Mem0 写入失败(静默)', e)
        return false
      }
    },

    async searchExperiences(query, limit = 3) {
      const mem = await initOnce()
      if (!mem || !query.trim()) return []
      try {
        const res = await mem.search(query, {
          filters: { user_id: MEM0_USER_ID },
          topK: Math.max(limit, 1),
          threshold: SEARCH_MIN_SCORE,
        })
        return (res?.results ?? [])
          .filter((r) => (r.score ?? 0) >= SEARCH_MIN_SCORE)
          .map((r) => (r.memory ?? '').trim())
          .filter(Boolean)
      } catch {
        return []
      }
    },

    async probeStatus() {
      if (!(await settingsOf())) return 'off'
      const mem = await initOnce()
      return mem ? 'ready' : 'error'
    },

    dispose() {
      initPromise = null
    },
  }
}

/** 生产单例:所有聊天链路共用 */
export const mem0Memory: Mem0Memory = createMem0Memory()
