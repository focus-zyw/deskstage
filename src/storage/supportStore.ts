// 支持作者账本持久化:data/support.json。与 config.json(设置)分开:
// 这是"账本/进度"型数据,关注点是流水与收集,不是用户偏好——与 mood.json 同一理由。
// 写入走 withFileLock(连抽的滚动+保底计数在锁内一次完成,保证 pity 一致);
// 浏览器预览降级 localStorage,与 moodStore 同一套约定。

import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import { withFileLock } from './writeLock'
import { inTauri } from './configStore'
import {
  defaultLedger,
  drawFromLedger,
  foldSupport,
  sanitizeLedger,
  type SupportLedger,
} from '../features/support/gacha'
import type { SupportPrize } from '../features/support/pool'

const LS_KEY = 'vc-support'
const FILE_NAME = 'support.json'

let cache: SupportLedger | null = null

const shape = (ledger: SupportLedger) => ({ version: 1, ledger })

async function readFile(): Promise<SupportLedger> {
  if (!inTauri) {
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (raw) return sanitizeLedger((JSON.parse(raw) as { ledger?: unknown }).ledger)
    } catch {
      // 坏数据按默认处理
    }
    return defaultLedger()
  }
  try {
    const base = await appDataDir()
    const file = await join(base, 'data', FILE_NAME)
    if (await exists(file)) {
      return sanitizeLedger((JSON.parse(await readTextFile(file)) as { ledger?: unknown }).ledger)
    }
  } catch (e) {
    console.warn('支持账本读取失败(按默认处理)', e)
  }
  return defaultLedger()
}

async function writeFile(ledger: SupportLedger): Promise<void> {
  cache = ledger
  if (!inTauri) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(shape(ledger)))
    } catch {
      /* ignore */
    }
    return
  }
  try {
    const base = await appDataDir()
    const dir = await join(base, 'data')
    if (!(await exists(dir))) await mkdir(dir, { recursive: true })
    await writeTextFile(await join(dir, FILE_NAME), JSON.stringify(shape(ledger), null, 2))
  } catch (e) {
    console.warn('支持账本落盘失败(静默)', e)
  }
}

/** 读账本(设置页挂载时拉一次;之后经写路径同步缓存) */
export async function getSupport(): Promise<SupportLedger> {
  if (!cache) cache = await readFile()
  return cache
}

/** 自愿支持落账:金额记入流水,按 1 元 1 抽增加次数;返回新账本 */
export async function addSupport(yuan: number): Promise<SupportLedger> {
  await withFileLock('support', async () => {
    if (!cache) cache = await readFile()
    await writeFile(foldSupport(cache, yuan))
  })
  return cache!
}

/** 消耗次数抽 n 发:滚动与保底在锁内依次推进;返回新账本与本轮奖品(可能少于 n,被剩余次数钳住) */
export async function drawPrizes(
  n: number,
): Promise<{ ledger: SupportLedger; prizes: SupportPrize[] }> {
  let prizes: SupportPrize[] = []
  await withFileLock('support', async () => {
    if (!cache) cache = await readFile()
    const r = drawFromLedger(cache, n)
    cache = r.ledger
    prizes = r.prizes
    await writeFile(cache)
  })
  return { ledger: cache!, prizes }
}

/** 设置页复位:清空流水/次数/图鉴/保底(图鉴集齐不挽留,彩蛋看缘分) */
export async function resetSupport(): Promise<void> {
  await withFileLock('support', async () => {
    await writeFile(defaultLedger())
  })
}
