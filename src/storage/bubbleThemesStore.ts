// 气泡主题存储:用户在"气泡工坊"里自建的气泡外观主题,落盘 appData/data/bubble-themes.json。
// 文件读写统一走 Rust 状态中心(data_get/data_set:进程锁串行化 + 原子写 + store-changed
// 广播到两窗),本模块不再直接碰文件——设置窗写入后主窗经广播载荷即时采纳。
// 主题即数据:全部字段落到 CSS 变量,应用时经 applyBubbleThemeTo 注入根节点;
// 内置 comic/glass 走 :root[data-bubble] 变量集,自定义主题走 inline style 变量(优先级更高)。
// 浏览器预览(无 Tauri 运行时)降级 localStorage,与 configStore 同一套约定。
// 上限 10 个防膨胀;id 强制 custom_ 前缀,永不可能与内置主题撞键;坏数据拒收不静默修。
import { useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { withFileLock } from './writeLock'
import { inTauri } from './configStore'

const LS_KEY = 'vc-bubble-themes'
const STORE_ID = 'bubble-themes'

/** 自定义气泡主题数量上限 */
export const BUBBLE_THEME_LIMIT = 10

/** hex 颜色(#RRGGBB);统一 6 位,透明度单独用 bgOpacity 字段表达 */
const HEX = /^#[0-9a-fA-F]{6}$/

/** 用户自定义气泡主题 = 全部外观字段的纯数据(id 已由存储层保证 custom_ 前缀) */
export interface BubbleTheme {
  id: string
  label: string
  bg: string
  text: string
  stroke: string
  accA: string
  accB: string
  accC: string
  bgA: string
  bgB: string
  bgC: string
  strokeA: string
  strokeB: string
  strokeC: string
  /** 底色统一透明度 0.5~1(默认 0.93) */
  bgOpacity: number
  /** 描边宽 1~3 px(默认 1) */
  strokeW: number
  /** 背景模糊 0~24 px,0 = 无(默认 0) */
  blurPx: number
  /** 台词基准字号 12~22(默认 16;长句 -2/加粗 +1 由 CSS calc 派生) */
  fontSize: number
  /** 气泡最大宽度 240~480(默认 320) */
  maxWidth: number
  /** 圆角 6~28(默认 18) */
  radius: number
}

/** 校验并清洗一个自定义主题:任何关键字段不合法返回 null(坏数据宁可拒收) */
export function sanitizeBubbleTheme(raw: unknown): BubbleTheme | null {
  const o = (raw ?? {}) as Record<string, unknown>
  const id = typeof o.id === 'string' ? o.id.trim() : ''
  if (!/^custom_[a-z0-9_-]{1,32}$/.test(id)) return null
  const label = typeof o.label === 'string' ? o.label.trim().slice(0, 10) : ''
  if (!label) return null
  const color = (v: unknown, fb: string): string => (typeof v === 'string' && HEX.test(v.trim()) ? v.trim() : fb)
  const theme: BubbleTheme = {
    id,
    label,
    bg: color(o.bg, '#faf7f2'),
    text: color(o.text, '#26232f'),
    stroke: color(o.stroke, '#92887e'),
    accA: color(o.accA, '#e98050'),
    accB: color(o.accB, '#5f86da'),
    accC: color(o.accC, '#8572d8'),
    bgA: color(o.bgA, '#fff4eb'),
    bgB: color(o.bgB, '#edf5ff'),
    bgC: color(o.bgC, '#f5f0ff'),
    strokeA: color(o.strokeA, '#dd8b62'),
    strokeB: color(o.strokeB, '#688fd5'),
    strokeC: color(o.strokeC, '#8974d0'),
    bgOpacity: clamp(o.bgOpacity, 0.5, 1, 0.93),
    strokeW: clamp(o.strokeW, 1, 3, 1),
    blurPx: clamp(o.blurPx, 0, 24, 0),
    fontSize: clamp(o.fontSize, 12, 22, 16),
    maxWidth: clamp(o.maxWidth, 240, 480, 320),
    radius: clamp(o.radius, 6, 28, 18),
  }
  return theme
}

function clamp(v: unknown, lo: number, hi: number, fb: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n * 100) / 100)) : fb
}

/** 清洗整份存储:逐条校验、按 id 去重、限量(文件手改坏数据时不会拖垮启动) */
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

let snapshot: BubbleTheme[] = []
const listeners = new Set<() => void>()

function publish(next: BubbleTheme[]): void {
  snapshot = next
  listeners.forEach((l) => l())
}

/** 同步读当前快照(非 React 侧用;React 组件请用 useBubbleThemes) */
export function getBubbleThemesSnapshot(): BubbleTheme[] {
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

/** React 侧读取:自定义主题列表(增删改触发重渲染) */
export function useBubbleThemes(): BubbleTheme[] {
  return useSyncExternalStore(subscribeBubbleThemes, getBubbleThemesSnapshot)
}

let loaded = false

export async function ensureBubbleThemesLoaded(): Promise<void> {
  if (loaded) return
  loaded = true
  if (!inTauri) {
    try {
      const raw = localStorage.getItem(LS_KEY)
      publish(raw ? sanitizeBubbleThemes(JSON.parse(raw)) : [])
    } catch (e) {
      console.warn('气泡主题读取失败，按空处理', e)
      publish([])
    }
    return
  }
  try {
    // Rust 状态中心:进程锁串行 + 内存缓存,坏数据按空仓处理
    publish(sanitizeBubbleThemes(await invoke<unknown>('data_get', { store: STORE_ID })))
  } catch (e) {
    console.warn('气泡主题读取失败，按空处理', e)
    publish([])
  }
}

/** 写型操作共用:全量替换落盘(Rust 原子写 + 广播),返回清洗后的全量列表 */
async function persistThemes(merged: BubbleTheme[]): Promise<BubbleTheme[]> {
  if (!inTauri) {
    localStorage.setItem(LS_KEY, JSON.stringify({ version: 1, themes: merged }))
    publish(merged)
    return merged
  }
  const saved = await invoke<unknown>('data_set', {
    store: STORE_ID,
    value: { version: 1, themes: merged },
  })
  const next = sanitizeBubbleThemes(saved)
  loaded = true
  publish(next)
  return next
}

/** 新增或更新一个主题(按 id upsert);超限抛错由调用方提示 */
export async function saveBubbleTheme(theme: BubbleTheme): Promise<BubbleTheme[]> {
  const clean = sanitizeBubbleTheme(theme)
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
export async function removeBubbleTheme(id: string): Promise<BubbleTheme[]> {
  return withFileLock(STORE_ID, async () => persistThemes(snapshot.filter((t) => t.id !== id)))
}

if (inTauri) {
  // Rust 状态中心的广播(store_set 成功后发给全部窗口,含写者,幂等采纳):
  // 设置窗写入后主窗即时拿到新主题,不再依赖"通知后回磁盘重读"的旧通路
  void listen<{ store?: string; value?: unknown }>('store-changed', (e) => {
    if (e.payload?.store !== STORE_ID || e.payload.value === undefined) return
    loaded = true
    publish(sanitizeBubbleThemes(e.payload.value))
  })
}

// ---------- 应用:主题数据 → 根节点 CSS 变量 ----------

/** hex(#RRGGBB) + 透明度 → rgba() 串 */
function withAlpha(hex: string, opacity: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${opacity})`
}

/** applyBubbleThemeTo 写入的全部变量名(切回内置主题时逐个清理) */
const APPLIED_VARS = [
  '--bubble-bg',
  '--bubble-text',
  '--bubble-stroke',
  '--bubble-stroke-w',
  '--bubble-blur',
  '--bubble-acc-a',
  '--bubble-acc-b',
  '--bubble-acc-c',
  '--bubble-bg-a',
  '--bubble-bg-b',
  '--bubble-bg-c',
  '--bubble-stroke-a',
  '--bubble-stroke-b',
  '--bubble-stroke-c',
  '--bubble-font-size',
  '--bubble-max-w',
  '--bubble-radius',
] as const

/** 把主题应用到根节点:theme=null 时清掉全部注入变量(回落 :root[data-bubble] 的内置变量集)。
 *  内联变量优先级高于 :root 规则,所以内置/自定义切换必须先清后写,不能只改 data 属性 */
export function applyBubbleThemeTo(root: HTMLElement, theme: BubbleTheme | null): void {
  for (const v of APPLIED_VARS) root.style.removeProperty(v)
  if (!theme) return
  const op = theme.bgOpacity
  const style = root.style
  style.setProperty('--bubble-bg', withAlpha(theme.bg, op))
  style.setProperty('--bubble-text', theme.text)
  style.setProperty('--bubble-stroke', withAlpha(theme.stroke, 0.42))
  style.setProperty('--bubble-stroke-w', `${theme.strokeW}px`)
  style.setProperty('--bubble-blur', theme.blurPx > 0 ? `blur(${theme.blurPx}px)` : 'none')
  style.setProperty('--bubble-acc-a', theme.accA)
  style.setProperty('--bubble-acc-b', theme.accB)
  style.setProperty('--bubble-acc-c', theme.accC)
  style.setProperty('--bubble-bg-a', withAlpha(theme.bgA, op))
  style.setProperty('--bubble-bg-b', withAlpha(theme.bgB, op))
  style.setProperty('--bubble-bg-c', withAlpha(theme.bgC, op))
  style.setProperty('--bubble-stroke-a', withAlpha(theme.strokeA, 0.5))
  style.setProperty('--bubble-stroke-b', withAlpha(theme.strokeB, 0.5))
  style.setProperty('--bubble-stroke-c', withAlpha(theme.strokeC, 0.5))
  style.setProperty('--bubble-font-size', `${theme.fontSize}px`)
  style.setProperty('--bubble-max-w', `${theme.maxWidth}px`)
  style.setProperty('--bubble-radius', `${theme.radius}px`)
}
