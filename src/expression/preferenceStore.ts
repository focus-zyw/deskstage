// 表达偏好存储(方案 §八):每个(角色,动作)一对 up/down 计数,不上机器学习。
// score = (up+1)/(up+down+2) 拉普拉斯平滑(零反馈 = 0.5 = 乘数 1,不偏不倚);
// multiplier = clamp(0.6, 1.5, score*2) —— 任何单一动作的权重至多 ±50%。
//
// 安全纪律:direct 永不可学(它是回退与任务通道,绝不能被踩没);任务优先、
// maySpeak、用户指令权同样不在可学习集合(policy/worker 层另行保证)。
// 持久化照 feedbackStore 模式 B:withFileLock + 浏览器降级 localStorage + 静默失败;
// IO 整体可注入,行为测试零磁盘。阶段一没有写入端(赞踩 UI 属阶段三),
// multiplier 恒 1,行为与未学习完全一致。

import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import { withFileLock } from '../storage/writeLock'
import { inTauri } from '../storage/configStore'
import type { ExpressionMove } from './types'
import type { Speaker } from '../performer/dialogSchema'

export interface FeaturePreference {
  up: number
  down: number
}

export type PreferenceTable = Record<string, FeaturePreference>

const LS_KEY = 'vc-expression-prefs'
const FILE_NAME = 'expression-preferences.json'
const VERSION = 1
/** 上限 = 3 角色 × 10 动作,留一倍余量防脏键膨胀 */
const MAX_KEYS = 60

export function keyOf(actor: Speaker, move: ExpressionMove): string {
  return `${actor}:${move}`
}

/** 单偏好乘数(纯函数,单测覆盖);无记录 = 1 */
export function preferenceMultiplier(p: FeaturePreference | undefined): number {
  if (!p) return 1
  const up = Number.isFinite(p.up) ? Math.max(0, p.up) : 0
  const down = Number.isFinite(p.down) ? Math.max(0, p.down) : 0
  const score = (up + 1) / (up + down + 2)
  return Math.min(1.5, Math.max(0.6, score * 2))
}

/** 表清洗:非法键/非有限计数丢弃,计数钳到 [0, 5000];超限丢最旧没有时间戳,
 *  直接按键序截断(计数器表,顺序无语义) */
export function sanitizePreferenceTable(raw: unknown): PreferenceTable {
  const out: PreferenceTable = {}
  if (!raw || typeof raw !== 'object') return out
  const o = raw as Record<string, unknown>
  for (const [k, v] of Object.entries(o)) {
    if (!/^[ABC]:(direct|tease|challenge|absurd-leap|literalize|callback|deflect|vulnerable|pivot|close)$/.test(k)) continue
    if (k.endsWith(':direct')) continue // direct 不可学,存了也不生效,直接剔
    const p = (v ?? {}) as Record<string, unknown>
    const up = Math.min(5000, Math.max(0, Math.floor(Number(p.up)) || 0))
    const down = Math.min(5000, Math.max(0, Math.floor(Number(p.down)) || 0))
    out[k] = { up, down }
    if (Object.keys(out).length >= MAX_KEYS) break
  }
  return out
}

/** 可注入 IO(测试用内存实现;默认实现 = Tauri data 目录 / localStorage) */
export interface PreferenceIo {
  read(): Promise<string | null>
  write(json: string): Promise<void>
}

export interface PreferenceStoreDeps {
  io: PreferenceIo
}

const defaultIo: PreferenceIo = {
  async read() {
    if (!inTauri) {
      try {
        return localStorage.getItem(LS_KEY)
      } catch {
        return null
      }
    }
    try {
      const base = await appDataDir()
      const file = await join(base, 'data', FILE_NAME)
      if (await exists(file)) return await readTextFile(file)
    } catch (e) {
      console.warn('表达偏好读取失败(按空表处理)', e)
    }
    return null
  },
  async write(json) {
    if (!inTauri) {
      try {
        localStorage.setItem(LS_KEY, json)
      } catch {
        /* ignore */
      }
      return
    }
    try {
      const base = await appDataDir()
      const dir = await join(base, 'data')
      if (!(await exists(dir))) await mkdir(dir, { recursive: true })
      await writeTextFile(await join(dir, FILE_NAME), json)
    } catch (e) {
      console.warn('表达偏好落盘失败(静默)', e)
    }
  },
}

export interface PreferenceStore {
  /** 该(角色,动作)的当前权重乘数(同步读缓存;direct 恒 1) */
  multiplier(actor: Speaker, move: ExpressionMove): number
  /** 记一次赞/踩(direct 拒记);重复评价会重复计数,去重属阶段三 UI 职责 */
  learn(actor: Speaker, move: ExpressionMove, rating: 'up' | 'down'): Promise<void>
  snapshot(): PreferenceTable
  reset(): Promise<void>
}

export function createPreferenceStore(depsInput?: Partial<PreferenceStoreDeps>): PreferenceStore {
  const io = depsInput?.io ?? defaultIo
  let cache: PreferenceTable | null = null

  async function ensure(): Promise<PreferenceTable> {
    if (cache) return cache
    try {
      const raw = await io.read()
      cache = raw
        ? sanitizePreferenceTable((JSON.parse(raw) as { table?: unknown }).table)
        : {}
    } catch {
      cache = {}
    }
    return cache
  }

  function persist(table: PreferenceTable): Promise<void> {
    return io.write(JSON.stringify({ version: VERSION, table }))
  }

  return {
    multiplier(actor, move) {
      if (move === 'direct') return 1
      return preferenceMultiplier(cache?.[keyOf(actor, move)])
    },
    async learn(actor, move, rating) {
      if (move === 'direct') return
      const table = await withFileLock('expression-preferences', async () => {
        const t = await ensure()
        const key = keyOf(actor, move)
        const cur = t[key] ?? { up: 0, down: 0 }
        t[key] =
          rating === 'up'
            ? { ...cur, up: cur.up + 1 }
            : { ...cur, down: cur.down + 1 }
        await persist(t)
        return t
      })
      cache = table
    },
    snapshot() {
      return cache ?? {}
    },
    async reset() {
      await withFileLock('expression-preferences', async () => {
        cache = {}
        await persist(cache)
      })
    },
  }
}
