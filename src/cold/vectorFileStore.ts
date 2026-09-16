// 文件型向量库:mem0ai VectorStore 接口的纯 TS 实现,落盘 data/mem0-vectors.json。
// 作用:替代 mem0 默认的 better-sqlite3 向量库(Node 原生模块,webview 无法执行)。
// 实现按接口契约(index.d.ts):insert/search(keywordSearch 可选不实现)/get/
// update/delete/deleteCol/list/getUserId/setUserId/initialize;检索是暴力余弦
// (记忆量级 ≤ 千条,毫秒级),filters 只支持 user_id/agent_id/run_id 等值匹配
// (mem0 自身只按这三键过滤)。持久化 IO 可注入:测试用内存 Map,生产走
// withFileLock + localStorage 降级(与 moodStore 同一套约定)。
// 嵌入器指纹:换嵌入模型 = 换向量空间,旧向量与新 query 余弦不可比(混用的结果是
// 检索永远低于阈值、冷记忆悄悄失效),故 createFileVectorStore 可传入指纹,init 时
// 不匹配即重开空库。

export interface VectorRecord {
  id: string
  vector: number[]
  payload: Record<string, unknown>
}

export interface VectorsFile {
  version: 1
  collections: Record<string, { userId?: string; embedder?: string; items: VectorRecord[] }>
}

export interface VectorStoreIO {
  read(): Promise<VectorsFile | null>
  write(file: VectorsFile): Promise<void>
}

/** mem0ai VectorStore 接口的结构子集(结构化类型,不 import mem0ai 类型——测试零依赖) */
export interface FileVectorStore {
  insert(vectors: number[][], ids: string[], payloads: Record<string, unknown>[]): Promise<void>
  search(query: number[], topK?: number, filters?: Record<string, unknown>): Promise<Array<{ id: string; payload: Record<string, unknown>; score?: number }>>
  get(vectorId: string): Promise<{ id: string; payload: Record<string, unknown>; score?: number } | null>
  update(vectorId: string, vector: number[], payload: Record<string, unknown>): Promise<void>
  delete(vectorId: string): Promise<void>
  deleteCol(): Promise<void>
  list(filters?: Record<string, unknown>, topK?: number): Promise<[Array<{ id: string; payload: Record<string, unknown>; score?: number }>, number]>
  getUserId(): Promise<string>
  setUserId(userId: string): Promise<void>
  initialize(): Promise<void>
}

function emptyFile(): VectorsFile {
  return { version: 1, collections: {} }
}

/** 余弦相似度;零向量保守给 0(不参与召回) */
export function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / Math.sqrt(na * nb)
}

/** mem0 只按 user_id/agent_id/run_id 等值过滤 payload;这里照抄该语义 */
function payloadMatches(payload: Record<string, unknown> | undefined, filters?: Record<string, unknown>): boolean {
  if (!filters) return true
  for (const key of ['user_id', 'agent_id', 'run_id']) {
    const want = filters[key]
    if (want !== undefined && payload?.[key] !== want) return false
  }
  return true
}

/** 幂等清洗:坏档归空(测试与生产读档共用) */
export function sanitizeVectorsFile(raw: unknown): VectorsFile {
  const out = emptyFile()
  if (!raw || typeof raw !== 'object') return out
  const cols = (raw as Record<string, unknown>).collections
  if (!cols || typeof cols !== 'object') return out
  for (const [name, col] of Object.entries(cols as Record<string, unknown>)) {
    if (!col || typeof col !== 'object') continue
    const c = col as Record<string, unknown>
    const items = Array.isArray(c.items)
      ? c.items.filter(
          (it): it is VectorRecord =>
            !!it && typeof it === 'object' &&
            typeof (it as VectorRecord).id === 'string' &&
            Array.isArray((it as VectorRecord).vector) &&
            !!(it as VectorRecord).payload &&
            typeof (it as VectorRecord).payload === 'object',
        )
      : []
    out.collections[name] = {
      ...(typeof c.userId === 'string' ? { userId: c.userId } : {}),
      ...(typeof c.embedder === 'string' && c.embedder ? { embedder: c.embedder } : {}),
      items,
    }
  }
  return out
}

export function createFileVectorStore(io: VectorStoreIO, collectionName: string, embedder?: string): FileVectorStore {
  let file: VectorsFile | null = null

  const ensure = async (): Promise<VectorsFile> => {
    if (!file) file = (await io.read()) ?? emptyFile()
    let c = file.collections[collectionName]
    if (!c) c = file.collections[collectionName] = { items: [] }
    // 指纹守卫:不一致 = 嵌入模型换过了,旧向量全部不可比,重开空库;
    // 老档无指纹(升级存量)则补盖当前指纹,不激进重置,下次落盘带上
    if (embedder) {
      if (c.embedder && c.embedder !== embedder) {
        console.warn(`向量库嵌入器指纹变化(${c.embedder} → ${embedder}),${collectionName} 重开空库`)
        c = file.collections[collectionName] = { embedder, items: [] }
        await io.write(file)
      } else if (!c.embedder) {
        c.embedder = embedder
      }
    }
    return file
  }
  const col = (f: VectorsFile) => f.collections[collectionName]

  return {
    async initialize() {
      await ensure()
    },
    async insert(vectors, ids, payloads) {
      const f = await ensure()
      const c = col(f)
      for (let i = 0; i < ids.length; i++) {
        // 同 id 覆盖(mem0 的 upsert 语义)
        const idx = c.items.findIndex((it) => it.id === ids[i])
        const rec: VectorRecord = { id: ids[i], vector: [...(vectors[i] ?? [])], payload: { ...(payloads[i] ?? {}) } }
        if (idx >= 0) c.items[idx] = rec
        else c.items.push(rec)
      }
      await io.write(f)
    },
    async search(query, topK = 10, filters) {
      const f = await ensure()
      const scored = col(f)
        .items
        .filter((it) => payloadMatches(it.payload, filters))
        .map((it) => ({ id: it.id, payload: { ...it.payload }, score: cosineSim(query, it.vector) }))
      scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      return scored.slice(0, Math.max(topK, 0))
    },
    async get(vectorId) {
      const f = await ensure()
      const it = col(f).items.find((r) => r.id === vectorId)
      return it ? { id: it.id, payload: { ...it.payload } } : null
    },
    async update(vectorId, vector, payload) {
      const f = await ensure()
      const it = col(f).items.find((r) => r.id === vectorId)
      if (!it) return
      it.vector = [...vector]
      it.payload = { ...payload }
      await io.write(f)
    },
    async delete(vectorId) {
      const f = await ensure()
      const c = col(f)
      const idx = c.items.findIndex((r) => r.id === vectorId)
      if (idx < 0) return
      c.items.splice(idx, 1)
      await io.write(f)
    },
    async deleteCol() {
      const f = await ensure()
      // 清集合不清指纹:空集合仍属于当前嵌入器
      const embedderOf = col(f).embedder
      f.collections[collectionName] = { ...(embedderOf ? { embedder: embedderOf } : {}), items: [] }
      await io.write(f)
    },
    async list(filters, topK) {
      const f = await ensure()
      const matched = col(f)
        .items
        .filter((it) => payloadMatches(it.payload, filters))
        .map((it) => ({ id: it.id, payload: { ...it.payload } }))
      const limit = typeof topK === 'number' && topK >= 0 ? matched.slice(0, topK) : matched
      return [limit, matched.length]
    },
    async getUserId() {
      const f = await ensure()
      return col(f).userId ?? ''
    },
    async setUserId(userId) {
      const f = await ensure()
      col(f).userId = userId
      await io.write(f)
    },
  }
}
