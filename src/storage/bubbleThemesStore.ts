// 气泡主题存储:用户在"气泡工坊"里自建的气泡外观主题,落盘 appData/data/bubble-themes.json。
// 文件读写统一走 Rust 状态中心(data_get/data_set:进程锁串行化 + 原子写 + store-changed
// 广播到两窗);落盘恒为 version:2 的 V2 主题,旧 V1 扁平主题只在读取时迁移。
// 浏览器预览(无 Tauri 运行时)降级 localStorage,与 configStore 同一套约定。
//
// 双视图约定(工坊 UI 迁移期):内部快照与落盘都是 V2(模板/材质/配色派生);
// 对外的 BubbleTheme 类型与 useBubbleThemes 列表暂时保留 V1 扁平投影,让尚未
// 重写的旧编辑表单继续工作——投影由引擎双向转换(颜色零丢失),工坊 UI 重写后移除。
// 上限 10 个防膨胀;id 强制 custom_ 前缀,永不可能与内置主题撞键;坏数据拒收不静默修。
import { useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { withFileLock } from './writeLock'
import { inTauri } from './configStore'
import {
  isBuiltinBubbleThemeId,
  normalizeBubbleTheme,
  normalizeBubbleThemeAny,
  resolveBubbleAppearance,
  type BubbleThemeV2,
  type LegacyBubbleThemeV1,
} from '../bubble'

const LS_KEY = 'vc-bubble-themes'
const STORE_ID = 'bubble-themes'

/** 自定义气泡主题数量上限 */
export const BUBBLE_THEME_LIMIT = 10

export const BUBBLE_SHAPES = ['rounded', 'pill', 'square', 'cloud'] as const
export type BubbleShape = (typeof BUBBLE_SHAPES)[number]

export const BUBBLE_TAIL_STYLES = ['droplet', 'sharp', 'round', 'none'] as const
export type BubbleTailStyle = (typeof BUBBLE_TAIL_STYLES)[number]

export const BUBBLE_SHADOWS = ['none', 'soft', 'strong'] as const
export type BubbleShadow = (typeof BUBBLE_SHADOWS)[number]

/** hex 颜色(#RRGGBB);统一 6 位,透明度单独用 bgOpacity 字段表达 */

/**
 * V1 扁平主题(过渡期对外视图):字段与旧版逐一对应,仅作读写投影。
 * 新代码请使用 BubbleThemeV2(自 ../bubble 导入);工坊 UI 重写后本接口删除。
 */
export interface BubbleTheme extends LegacyBubbleThemeV1 {}

// ---------- V2 ↔ V1 投影(过渡期桥,工坊 UI 重写后删除) ----------

/** V2 → V1 扁平投影:颜色经引擎派生补全,字段一一拉平 */
export function projectV2ToLegacy(v2: BubbleThemeV2): BubbleTheme {
  const ap = resolveBubbleAppearance(v2, { speaker: 'A', placement: 'above', tailSide: 'center', emphasis: 'normal', length: 'normal' })
  const sp = ap.speakers
  const hexOf = (rgba: string, fallback: string): string => {
    const m = rgba.match(/rgba?\((\d+), (\d+), (\d+)/)
    if (!m) return fallback
    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])]
    return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`
  }
  const templateShape: Record<BubbleThemeV2['templateId'], BubbleShape> = {
    'soft-chat': 'rounded',
    pill: 'pill',
    'comic-burst': 'square',
    cloud: 'cloud',
    sticker: 'rounded',
    rpg: 'square',
    caption: 'rounded',
  }
  const tailTail: Record<BubbleThemeV2['tail']['style'], BubbleTailStyle> = {
    droplet: 'droplet',
    triangle: 'sharp',
    curve: 'round',
    bubbles: 'round',
    none: 'none',
  }
  const ov = v2.palette.overrides ?? {}
  return {
    id: v2.id,
    label: v2.label,
    bg: ov.surface ?? hexOf(sp.A.surface, '#faf7f2'),
    text: ov.text ?? ap.text,
    stroke: ov.outline ?? hexOf(sp.A.edge, '#92887e'),
    accA: ov.accA ?? sp.A.accent,
    accB: ov.accB ?? sp.B.accent,
    accC: ov.accC ?? sp.C.accent,
    bgA: ov.surfaceA ?? hexOf(sp.A.surface, '#fff4eb'),
    bgB: ov.surfaceB ?? hexOf(sp.B.surface, '#edf5ff'),
    bgC: ov.surfaceC ?? hexOf(sp.C.surface, '#f5f0ff'),
    strokeA: ov.outlineA ?? hexOf(sp.A.edge, '#dd8b62'),
    strokeB: ov.outlineB ?? hexOf(sp.B.edge, '#688fd5'),
    strokeC: ov.outlineC ?? hexOf(sp.C.edge, '#8974d0'),
    bgOpacity: v2.material.opacity,
    strokeW: Math.min(3, Math.max(1, v2.frame.outlineWidth)),
    blurPx: v2.material.blur,
    fontSize: v2.typography.size,
    maxWidth: v2.layout.maxWidth,
    radius: v2.frame.radius,
    shape: templateShape[v2.templateId],
    tailStyle: tailTail[v2.tail.style],
    shadow: v2.effects.shadow,
    fontWeight: v2.typography.weight,
    lineHeight: v2.typography.lineHeight,
    paddingX: v2.layout.paddingX,
    paddingY: v2.layout.paddingY,
  }
}

/** V1 扁平主题 → V2(迁移规则见引擎 normalize.migrateBubbleThemeV1) */
function promoteLegacy(raw: BubbleTheme): BubbleThemeV2 | null {
  return normalizeBubbleThemeAny(raw)
}

/** 归一化一个主题输入(V2 直收,V1 迁移);自定义主题 id 必须 custom_ 前缀,坏数据返回 null */
function toV2(raw: unknown): BubbleThemeV2 | null {
  const v2 = normalizeBubbleThemeAny(raw)
  // 引擎层放行内置 id(内置 V2 数据也过 normalize),存储层只收自定义主题
  if (!v2 || isBuiltinBubbleThemeId(v2.id)) return null
  return v2
}

/** 校验并清洗一个自定义主题(过渡期兼容入口):输出 V1 投影,坏数据返回 null */
export function sanitizeBubbleTheme(raw: unknown): BubbleTheme | null {
  const v2 = toV2(raw)
  return v2 ? projectV2ToLegacy(v2) : null
}

/** 清洗整份存储(V1/V2 混合输入):逐条归一化、按 id 去重、限量(文件手改坏数据不拖垮启动) */
export function sanitizeBubbleThemes(raw: unknown): BubbleTheme[] {
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { themes?: unknown } | null)?.themes)
      ? (raw as { themes: unknown[] }).themes
      : []
  const out: BubbleTheme[] = []
  const seen = new Set<string>()
  for (const item of arr) {
    const theme = sanitizeBubbleTheme(item)
    if (theme && !seen.has(theme.id)) {
      seen.add(theme.id)
      out.push(theme)
    }
    if (out.length >= BUBBLE_THEME_LIMIT) break
  }
  return out
}

// ---------- 存取:文件(localStorage)+ 内存快照 + 订阅,三件套同 configStore ----------

let snapshot: BubbleThemeV2[] = []
let legacyCache: BubbleTheme[] = []
const listeners = new Set<() => void>()

function publish(next: BubbleThemeV2[]): void {
  snapshot = next
  legacyCache = next.map(projectV2ToLegacy)
  listeners.forEach((l) => l())
}

/** 同步读当前快照(V2 真身,非 React 侧用;React 组件请用 useBubbleThemesV2) */
export function getBubbleThemesV2Snapshot(): BubbleThemeV2[] {
  return snapshot
}

/** 同步读 V1 投影快照(过渡期兼容;React 侧用 useBubbleThemes) */
export function getBubbleThemesSnapshot(): BubbleTheme[] {
  return legacyCache
}

/** 订阅自定义主题变化;首次订阅触发一次异步加载(磁盘晚于订阅者时补发通知) */
export function subscribeBubbleThemes(l: () => void): () => void {
  listeners.add(l)
  void ensureBubbleThemesLoaded()
  return () => {
    listeners.delete(l)
  }
}

/** React 侧读取:自定义主题列表(V1 投影视图;增删改触发重渲染) */
export function useBubbleThemes(): BubbleTheme[] {
  return useSyncExternalStore(subscribeBubbleThemes, getBubbleThemesSnapshot)
}

/** React 侧读取:自定义主题列表(V2 真身;舞台应用链路使用) */
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

/** 文件载荷 → V2 列表(兼容 version:1 旧文件与 { themes: [...] } 包装) */
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

/** 新增或更新一个主题(按 id upsert;接受 V1/V2,超限抛错由调用方提示) */
export async function saveBubbleTheme(theme: BubbleTheme | BubbleThemeV2): Promise<BubbleThemeV2[]> {
  const clean =
    (typeof theme === 'object' && theme !== null && (theme as { version?: unknown }).version === 2)
      ? normalizeBubbleTheme(theme)
      : promoteLegacy(theme as BubbleTheme)
  if (!clean) throw new Error('主题数据不合法')
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
