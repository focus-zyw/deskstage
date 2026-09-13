// 自定义模式存储:用户在"模式工坊"里创建的演出模式(DialogMode 纯数据),落盘 appData/data/custom-modes.json。
// 文件读写统一走 Rust 状态中心(data_get/data_set:进程锁串行化 + 原子写 + store-changed
// 广播到两窗),本模块不再直接碰文件——设置窗写入后主窗经广播载荷即时采纳。
// 模式即数据:运行时与内置 MODES 合并后,分段按钮/历史徽标/自然语言路由/LLM 指令自动感知,无需改代码。
// 浏览器预览(无 Tauri 运行时)降级 localStorage,与 configStore 同一套约定。
// 上限 20 个防膨胀;id 强制 custom_ 前缀,永不可能与内置模式撞键。
import { useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { withFileLock } from './writeLock'
import { inTauri } from './configStore'
import { sanitizeDialogLine } from '../performer/dialogSchema'
import type { DialogLine } from '../performer/player'
import type { DialogMode } from '../performer/modes'

const LS_KEY = 'vc-custom-modes'
const STORE_ID = 'custom-modes'

/** 自定义模式数量上限:分段控件宽度有限,防 LLM 批量灌垃圾 */
export const CUSTOM_MODE_LIMIT = 20

/** 自定义模式 = 完整 DialogMode 数据(id 已由存储层保证 custom_ 前缀) */
export type CustomMode = DialogMode

/** 校验并清洗一个自定义模式:任何字段不合法返回 null(绝不静默修坏数据,坏数据宁可拒收)。
 *  动作词经 sanitizeDialogLine 归一(非法动作回 talk),其余字段钳位/裁剪 */
export function sanitizeCustomMode(raw: unknown): Omit<DialogMode, 'id'> & { id: string } | null {
  const o = (raw ?? {}) as Record<string, unknown>
  const id = typeof o.id === 'string' ? o.id.trim() : ''
  if (!/^custom_[a-z0-9_-]{1,40}$/.test(id)) return null
  const label = typeof o.label === 'string' ? o.label.trim().slice(0, 8) : ''
  if (!label) return null
  const prompt = typeof o.prompt === 'string' ? o.prompt.trim().slice(0, 600) : ''
  if (!prompt) return null
  const scriptRaw = Array.isArray(o.script) ? o.script : []
  const script = scriptRaw
    .map(sanitizeDialogLine)
    .filter((l): l is DialogLine => l !== null)
    .slice(0, 20)
  if (script.length < 2) return null
  const gapNum = Number(o.gap)
  const accent = typeof o.accent === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(o.accent.trim()) ? o.accent.trim() : '#7c6cf0'
  const topics = Array.isArray(o.topics)
    ? (o.topics as unknown[]).map((t) => (typeof t === 'string' ? t.trim().slice(0, 40) : '')).filter(Boolean).slice(0, 50)
    : undefined
  const triggers = Array.isArray(o.triggers)
    ? (o.triggers as unknown[]).map((t) => (typeof t === 'string' ? t.trim().slice(0, 12) : '')).filter(Boolean).slice(0, 8)
    : undefined
  const chance = Number(o.interestTopicChance)
  const tone = typeof o.tone === 'string' ? o.tone.trim().slice(0, 20) : ''
  return {
    id,
    label,
    accent,
    gap: Number.isFinite(gapNum) ? Math.min(2000, Math.max(100, Math.round(gapNum))) : 400,
    script,
    prompt,
    topics: topics && topics.length > 0 ? topics : undefined,
    interestTopicChance: Number.isFinite(chance) ? Math.min(1, Math.max(0, chance)) : undefined,
    triggers: triggers && triggers.length > 0 ? triggers : undefined,
    tone: tone && tone !== 'comedy' ? tone : undefined, // 'comedy' 归 undefined(与缺省同义,省一条分支)
  }
}

/** 清洗整份存储:逐条校验、按 id 去重、限量(文件手改坏数据时不会拖垮启动) */
export function sanitizeCustomModes(raw: unknown): CustomMode[] {
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { modes?: unknown } | null)?.modes)
      ? (raw as { modes: unknown[] }).modes
      : []
  const out: CustomMode[] = []
  const seen = new Set<string>()
  for (const item of arr) {
    const mode = sanitizeCustomMode(item)
    if (mode && !seen.has(mode.id)) {
      seen.add(mode.id)
      out.push(mode)
    }
    if (out.length >= CUSTOM_MODE_LIMIT) break
  }
  return out
}

// ---------- 存取:文件(localStorage)+ 内存快照 + 订阅,同 configStore 三件套 ----------

let snapshot: CustomMode[] = []
const listeners = new Set<() => void>()

function publish(next: CustomMode[]): void {
  snapshot = next
  listeners.forEach((l) => l())
}

/** 同步读当前快照(非 React 侧用;React 组件请用 useCustomModes) */
export function getCustomModesSnapshot(): CustomMode[] {
  return snapshot
}

/** 订阅自定义模式变化;首次订阅触发一次异步加载(磁盘晚于订阅者时补发通知) */
export function subscribeCustomModes(l: () => void): () => void {
  listeners.add(l)
  void ensureCustomModesLoaded()
  return () => {
    listeners.delete(l)
  }
}

/** React 侧读取:自定义模式列表(变化触发重渲染) */
export function useCustomModes(): CustomMode[] {
  return useSyncExternalStore(subscribeCustomModes, getCustomModesSnapshot)
}

let loaded = false

/** 确保磁盘(或 localStorage)已读入内存;测试与 App 启动路径用 */
export async function ensureCustomModesLoaded(): Promise<void> {
  if (loaded) return
  loaded = true
  if (!inTauri) {
    try {
      const raw = localStorage.getItem(LS_KEY)
      publish(raw ? sanitizeCustomModes(JSON.parse(raw)) : [])
    } catch (e) {
      console.warn('自定义模式读取失败，按空处理', e)
      publish([])
    }
    return
  }
  try {
    // Rust 状态中心:进程锁串行 + 内存缓存,坏数据按空仓处理
    publish(sanitizeCustomModes(await invoke<unknown>('data_get', { store: STORE_ID })))
  } catch (e) {
    console.warn('自定义模式读取失败，按空处理', e)
    publish([])
  }
}

/** 写型操作共用:全量替换落盘(Rust 原子写 + 广播),返回清洗后的全量列表 */
async function persistModes(merged: CustomMode[]): Promise<CustomMode[]> {
  if (!inTauri) {
    localStorage.setItem(LS_KEY, JSON.stringify({ version: 1, modes: merged }))
    publish(merged)
    return merged
  }
  const saved = await invoke<unknown>('data_set', {
    store: STORE_ID,
    value: { version: 1, modes: merged },
  })
  const next = sanitizeCustomModes(saved)
  loaded = true
  publish(next)
  return next
}

/** 新增或更新一个自定义模式(按 id upsert);超限抛错,由调用方提示。返回更新后的全量列表 */
export async function saveCustomMode(mode: CustomMode): Promise<CustomMode[]> {
  const clean = sanitizeCustomMode(mode)
  if (!clean) throw new Error('模式数据不合法')
  return withFileLock(STORE_ID, async () => {
    const current = snapshot
    const idx = current.findIndex((m) => m.id === clean.id)
    const merged =
      idx >= 0
        ? current.map((m, i) => (i === idx ? (clean as CustomMode) : m))
        : current.length >= CUSTOM_MODE_LIMIT
          ? null
          : [...current, clean as CustomMode]
    if (merged === null) throw new Error(`自定义模式最多 ${CUSTOM_MODE_LIMIT} 个`)
    return persistModes(merged)
  })
}

/** 删除一个自定义模式;id 不存在时静默(幂等) */
export async function removeCustomMode(id: string): Promise<CustomMode[]> {
  return withFileLock(STORE_ID, async () => persistModes(snapshot.filter((m) => m.id !== id)))
}

if (inTauri) {
  // Rust 状态中心的广播(store_set 成功后发给全部窗口,含写者,幂等采纳):
  // 设置窗写入后主窗即时拿到新模式,不再依赖"通知后回磁盘重读"的旧通路
  void listen<{ store?: string; value?: unknown }>('store-changed', (e) => {
    if (e.payload?.store !== STORE_ID || e.payload.value === undefined) return
    loaded = true
    publish(sanitizeCustomModes(e.payload.value))
  })
}
