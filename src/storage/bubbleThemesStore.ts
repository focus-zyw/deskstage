// 气泡主题存储:用户在"气泡工坊"里自建的气泡外观主题,落盘 appData/data/bubble-themes.json。
// 文件读写统一走 Rust 状态中心(data_get/data_set:进程锁串行化 + 原子写 + store-changed
// 广播到两窗);落盘恒为 version:2 的 V2 主题,旧 V1 扁平主题(含最早期无 shape 字段的)
// 只在读取时经引擎 normalize 就地迁移,颜色零丢失。
// 浏览器预览(无 Tauri 运行时)降级 localStorage,与 configStore 同一套约定。
// 上限 10 个防膨胀;id 强制 custom_ 前缀(内置 comic/glass 永不可能被存成自定义主题);
// 坏数据拒收不静默修。
import { useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { withFileLock } from './writeLock'
import { inTauri } from './configStore'
import {
  isBuiltinBubbleThemeId,
  normalizeBubbleThemeAny,
  type BubbleThemeV2,
} from '../bubble'

const LS_KEY = 'vc-bubble-themes'
const STORE_ID = 'bubble-themes'

/** 自定义气泡主题数量上限 */
export const BUBBLE_THEME_LIMIT = 10

/** 归一化一个主题输入(V2 直收,V1 迁移);自定义主题 id 必须 custom_ 前缀,坏数据返回 null */
function toV2(raw: unknown): BubbleThemeV2 | null {
  const v2 = normalizeBubbleThemeAny(raw)
  // 引擎层放行内置 id(内置 V2 数据也要过 normalize),存储层只收自定义主题
  if (!v2 || isBuiltinBubbleThemeId(v2.id)) return null
  return v2
}

// ---------- 存取:文件(localStorage)+ 内存快照 + 订阅,三件套同 configStore ----------

let snapshot: BubbleThemeV2[] = []
const listeners = new Set<() => void>()

function publish(next: BubbleThemeV2[]): void {
  snapshot = next
  listeners.forEach((l) => l())
}

/** 同步读当前快照(V2 真身,非 React 侧用;React 组件请用 useBubbleThemesV2) */
export function getBubbleThemesV2Snapshot(): BubbleThemeV2[] {
  return snapshot
}

/** 订阅自定义主题变化;首次订阅触发一次异步加载(磁盘晚于订阅者时补发通知) */
export function subscribeBubbleThemes(l: () => void): () => void {
  listeners.add(l)
  void ensureBubbleThemesLoaded()
  return () => {
    listeners.delete(l)
  }
}

/** React 侧读取:自定义主题列表(V2;增删改触发重渲染) */
export function useBubbleThemesV2(): BubbleThemeV2[] {
  return useSyncExternalStore(subscribeBubbleThemes, getBubbleThemesV2Snapshot)
}

let loaded = false

export async function ensureBubbleThemesLoaded(): Promise<void> {
  if (loaded) return
  loaded = true
  if (!inTauri) {
    try {
      const raw = localStorage.getItem(LS_KEY)
      publish(raw ? loadAll(JSON.parse(raw)) : [])
    } catch (e) {
      console.warn('气泡主题读取失败，按空处理', e)
      publish([])
    }
    return
  }
  try {
    // Rust 状态中心:进程锁串行 + 内存缓存,坏数据按空仓处理
    publish(loadAll(await invoke<unknown>('data_get', { store: STORE_ID })))
  } catch (e) {
    console.warn('气泡主题读取失败，按空处理', e)
    publish([])
  }
}

/** 文件载荷 → V2 列表(兼容 version:1 旧文件、无 shape 的最早期主题与 { themes: [...] } 包装) */
function loadAll(raw: unknown): BubbleThemeV2[] {
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { themes?: unknown } | null)?.themes)
      ? (raw as { themes: unknown[] }).themes
      : []
  const out: BubbleThemeV2[] = []
  const seen = new Set<string>()
  for (const item of arr) {
    const theme = toV2(item)
    if (theme && !seen.has(theme.id)) {
      seen.add(theme.id)
      out.push(theme)
    }
    if (out.length >= BUBBLE_THEME_LIMIT) break
  }
  return out
}

/** 写型操作共用:全量替换落盘(Rust 原子写 + 广播),返回归一化后的 V2 全量列表 */
async function persistThemes(merged: BubbleThemeV2[]): Promise<BubbleThemeV2[]> {
  if (!inTauri) {
    localStorage.setItem(LS_KEY, JSON.stringify({ version: 2, themes: merged }))
    publish(merged)
    return merged
  }
  const saved = await invoke<unknown>('data_set', {
    store: STORE_ID,
    value: { version: 2, themes: merged },
  })
  const next = loadAll(saved)
  loaded = true
  publish(next)
  return next
}

/** 新增或更新一个主题(按 id upsert;接受 V1/V2,超限抛错由调用方提示)。
 *  入口统一走 toV2:V2 输入同样受"自定义主题必须 custom_ 前缀"约束,
 *  防止把内置 comic/glass 存成伪自定义主题挤占名额且无法正常应用 */
export async function saveBubbleTheme(theme: BubbleThemeV2): Promise<BubbleThemeV2[]> {
  const clean = toV2(theme)
  if (!clean) throw new Error('主题数据不合法(自定义主题 id 必须为 custom_ 前缀)')
  return withFileLock(STORE_ID, async () => {
    const current = snapshot
    const idx = current.findIndex((t) => t.id === clean.id)
    const merged =
      idx >= 0
        ? current.map((t, i) => (i === idx ? clean : t))
        : current.length >= BUBBLE_THEME_LIMIT
          ? null
          : [...current, clean]
    if (merged === null) throw new Error(`自定义气泡主题最多 ${BUBBLE_THEME_LIMIT} 个`)
    return persistThemes(merged)
  })
}

/** 删除一个主题;id 不存在时静默(幂等) */
export async function removeBubbleTheme(id: string): Promise<BubbleThemeV2[]> {
  return withFileLock(STORE_ID, async () => persistThemes(snapshot.filter((t) => t.id !== id)))
}

if (inTauri) {
  // Rust 状态中心的广播(store_set 成功后发给全部窗口,含写者,幂等采纳):
  // 设置窗写入后主窗即时拿到新主题,不再依赖"通知后回磁盘重读"的旧通路
  void listen<{ store?: string; value?: unknown }>('store-changed', (e) => {
    if (e.payload?.store !== STORE_ID || e.payload.value === undefined) return
    loaded = true
    publish(loadAll(e.payload.value))
  })
}
