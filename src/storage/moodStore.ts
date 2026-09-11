// 情绪余波持久化:data/mood.json。与 story.json(策展后的角色世界)分开:
// mood 是易变瞬时态,关注点不同,也避免 StoryData 结构迁移。
// 读时惰性衰减(getMoods 算衰减但不回写,与 getBond 同策略)——隔天开机自动回中性;
// 写入走 withFileLock;浏览器预览降级 localStorage,与 configStore 同一套约定。

import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import { withFileLock } from './writeLock'
import { inTauri } from './configStore'
import {
  applyMoodDeltas as foldDeltas,
  decayTable,
  defaultMood,
  defaultMoodTable,
  sanitizeMoodTable,
  type Mood,
  type MoodDelta,
  type MoodTable,
} from '../engine/moodState'
import type { Speaker } from '../performer/dialogSchema'

const LS_KEY = 'vc-mood'
const FILE_NAME = 'mood.json'
const VERSION = 1

let cache: MoodTable | null = null

const shape = (mood: MoodTable) => ({ version: VERSION, mood })

async function readFile(): Promise<MoodTable> {
  if (!inTauri) {
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (raw) return sanitizeMoodTable((JSON.parse(raw) as { mood?: unknown }).mood)
    } catch {
      // 坏数据按默认处理
    }
    return defaultMoodTable()
  }
  try {
    const base = await appDataDir()
    const file = await join(base, 'data', FILE_NAME)
    if (await exists(file)) {
      return sanitizeMoodTable((JSON.parse(await readTextFile(file)) as { mood?: unknown }).mood)
    }
  } catch (e) {
    console.warn('情绪状态读取失败(按默认处理)', e)
  }
  return defaultMoodTable()
}

async function writeFile(mood: MoodTable): Promise<void> {
  cache = mood
  if (!inTauri) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(shape(mood)))
    } catch {
      /* ignore */
    }
    return
  }
  try {
    const base = await appDataDir()
    const dir = await join(base, 'data')
    if (!(await exists(dir))) await mkdir(dir, { recursive: true })
    await writeTextFile(await join(dir, FILE_NAME), JSON.stringify(shape(mood), null, 2))
  } catch (e) {
    console.warn('情绪状态落盘失败(静默)', e)
  }
}

/** 启动预载:呈现侧要同步读 moodOf,App 启动时调用一次 */
export async function ensureMoodLoaded(): Promise<void> {
  if (!cache) cache = await readFile()
}

/** 读全部情绪:读时先惰性衰减并刷新内存缓存(不回写磁盘,与 getBond 同策略——
 *  衰减值随下次写入自然落盘);同步读 moodOf 因此也能拿到衰减后的值 */
export async function getMoods(): Promise<MoodTable> {
  if (!cache) cache = await readFile()
  cache = decayTable(cache)
  return cache
}

/** 同步读单角色(App/呈现侧用);未加载时回默认中性 */
export function moodOf(who: Speaker): Mood {
  return cache?.[who] ?? defaultMood()
}

/** 应用增量(蒸馏余波/互动小步):先把存量衰减到当下再叠加,单笔钳位由 moodState 保证 */
export async function applyMoodDeltas(deltas: readonly MoodDelta[]): Promise<void> {
  const valid = deltas.filter(
    (d) => (d.who === 'A' || d.who === 'B' || d.who === 'C') && (d.dValence !== 0 || d.dEnergy !== 0),
  )
  if (valid.length === 0) return
  await withFileLock('mood', async () => {
    if (!cache) cache = await readFile()
    await writeFile(foldDeltas(decayTable(cache), valid))
  })
}

// ---------- 观众互动确定性小步(不经 LLM,单步幅度都在 ±0.5 内) ----------

const POKE_WINDOW_MS = 60_000
const pokeTimes: Record<Speaker, number[]> = { A: [], B: [], C: [] }

/** 被戳的情绪记账:窗口内头一戳是开心(被关注),连戳开始烦(爱是有限度的) */
export async function notePoked(who: Speaker): Promise<void> {
  const now = Date.now()
  const arr = (pokeTimes[who] = pokeTimes[who].filter((t) => now - t < POKE_WINDOW_MS))
  const repeat = arr.length > 0
  arr.push(now)
  await applyMoodDeltas(
    repeat
      ? [{ who, dValence: -0.25, dEnergy: 0.15, cause: '被观众连戳,有点烦' }]
      : [{ who, dValence: 0.15, dEnergy: 0.2, cause: '被观众戳了一下,挺开心' }],
  )
}

/** 演出被中途掐断(没看完就走):台上最后说话的角色心情小幅变差 */
export async function noteEpisodeAbandoned(lastSpeaker: Speaker): Promise<void> {
  await applyMoodDeltas([{ who: lastSpeaker, dValence: -0.2, dEnergy: 0, cause: '演出被中途掐断' }])
}

/** 设置页复位:三人情绪全部回中性 */
export async function resetMoods(): Promise<void> {
  await withFileLock('mood', async () => {
    await writeFile(defaultMoodTable())
  })
}
