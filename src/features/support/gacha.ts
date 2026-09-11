// 支持作者:抽奖纯逻辑(金额换算、稀有度落档、硬保底、图鉴合并、账本结构)。
// 与 UI/存储完全分离:node --test 直载;rng 参数注入,测试可复现。
// 不变量(有单测钉死,改实现前先读):
//   1. PITY_EPIC 抽内必出史诗+,PITY_LEGENDARY 抽内必出传说,抽出即归零对应计数
//   2. drawsLeft 永不为负;foldDraw 恰好消耗 1 抽、图鉴计数 +1、总抽数 +1
//   3. sanitizeLedger 对任意脏输入都返回合法账本(陌生 prizeId 按"未收集"丢弃)
import {
  RARITY_META,
  RARITY_ORDER,
  THANKS_POOL,
  prizeById,
  type Rarity,
  type SupportPrize,
} from './pool'

// ---------- 金额 → 次数 ----------

/** 单笔金额上限(元):防手滑多敲一个 0,真想多支持可以分多笔 */
export const MAX_SINGLE_YUAN = 2000

/** 1 元 = 1 抽,向下取整;非正数/非数值一律 0 抽 */
export function amountToDraws(yuan: number): number {
  if (!Number.isFinite(yuan) || yuan <= 0) return 0
  return Math.min(Math.floor(yuan), MAX_SINGLE_YUAN)
}

// ---------- 抽取与保底 ----------

/** 保底计数:距上次史诗+ / 传说的抽数(抽出对应档即归零) */
export interface PityState {
  sinceEpic: number
  sinceLegendary: number
}

/** 10 抽内必出史诗+(第 10 抽强制升档);40 抽内必出传说 */
export const PITY_EPIC = 10
export const PITY_LEGENDARY = 40

export const isEpicPlus = (r: Rarity) => r === 'epic' || r === 'legendary'

/** 按权重表落一个稀有度:cum = rng()*总权重 落进哪段就是哪档 */
function rollRarity(rng: () => number): Rarity {
  let cum = rng() * 100
  for (const r of RARITY_ORDER) {
    cum -= RARITY_META[r].weight
    if (cum < 0) return r
  }
  return 'common' // 权重表合计 100,理论不可达;兜底防浮点越界
}

/** 史诗保底的落点:在 epic/legendary 间按全池相对权重(8:2)再落一次 */
function epicOrLegendary(rng: () => number): Rarity {
  return rng() * 10 < RARITY_META.legendary.weight ? 'legendary' : 'epic'
}

/** 硬保底检查:传说保底优先于史诗保底 */
function forcedRarity(pity: PityState, rng: () => number): Rarity | null {
  if (pity.sinceLegendary >= PITY_LEGENDARY - 1) return 'legendary'
  if (pity.sinceEpic >= PITY_EPIC - 1) return epicOrLegendary(rng)
  return null
}

export interface RollResult {
  prize: SupportPrize
  /** 本抽后的保底计数(下一次抽取的输入) */
  pity: PityState
}

/** 单抽:先查硬保底,再按权重落档,档内均匀取条 */
export function rollOnce(pity: PityState, rng: () => number = Math.random): RollResult {
  const forced = forcedRarity(pity, rng)
  const rarity = forced ?? rollRarity(rng)
  const pool = THANKS_POOL.filter((p) => p.rarity === rarity)
  const prize = pool[Math.floor(rng() * pool.length)] ?? THANKS_POOL[0]
  return {
    prize,
    pity: {
      sinceEpic: isEpicPlus(rarity) ? 0 : pity.sinceEpic + 1,
      sinceLegendary: rarity === 'legendary' ? 0 : pity.sinceLegendary + 1,
    },
  }
}

// ---------- 账本(存储层负责落盘,这里只管折叠) ----------

export interface CollectionEntry {
  count: number
  firstAt: number
}

export interface SupportLedger {
  version: 1
  /** 累计支持金额(元,自报值;抽奖次数由 amountToDraws 决定,两者不必相等) */
  totalSupportedYuan: number
  /** 剩余可抽次数 */
  drawsLeft: number
  /** 历史总抽数 */
  totalDraws: number
  pity: PityState
  /** 图鉴:prizeId → 抽中次数与首次时间 */
  collection: Record<string, CollectionEntry>
}

export function defaultLedger(): SupportLedger {
  return {
    version: 1,
    totalSupportedYuan: 0,
    drawsLeft: 0,
    totalDraws: 0,
    pity: { sinceEpic: 0, sinceLegendary: 0 },
    collection: {},
  }
}

/** 支持落账:金额记入流水,按换算加次数(单笔超额由 MAX_SINGLE_YUAN 钳住) */
export function foldSupport(ledger: SupportLedger, yuan: number): SupportLedger {
  const valid = Number.isFinite(yuan) && yuan > 0 ? Math.min(yuan, MAX_SINGLE_YUAN) : 0
  return {
    ...ledger,
    totalSupportedYuan: Math.round((ledger.totalSupportedYuan + valid) * 100) / 100,
    drawsLeft: ledger.drawsLeft + amountToDraws(valid),
  }
}

/** 消耗 1 折叠一抽结果:次数-1、总抽数+1、保底推进、图鉴合并 */
function foldDraw(ledger: SupportLedger, result: RollResult): SupportLedger {
  if (ledger.drawsLeft <= 0) return ledger // 不变量 2:没次数时原样返回(调用方已钳,这里是保险)
  const prev = ledger.collection[result.prize.id]
  return {
    ...ledger,
    drawsLeft: ledger.drawsLeft - 1,
    totalDraws: ledger.totalDraws + 1,
    pity: result.pity,
    collection: {
      ...ledger.collection,
      [result.prize.id]: {
        count: (prev?.count ?? 0) + 1,
        firstAt: prev?.firstAt ?? Date.now(),
      },
    },
  }
}

/** 连抽 n 发:实际抽数被剩余次数钳住;滚动与保底在同一个账本上依次推进 */
export function drawFromLedger(
  ledger: SupportLedger,
  n: number,
  rng: () => number = Math.random,
): { ledger: SupportLedger; prizes: SupportPrize[] } {
  const count = Math.max(0, Math.min(Math.floor(n), ledger.drawsLeft))
  const prizes: SupportPrize[] = []
  let next = ledger
  for (let i = 0; i < count; i++) {
    const r = rollOnce(next.pity, rng)
    prizes.push(r.prize)
    next = foldDraw(next, r)
  }
  return { ledger: next, prizes }
}

/** 坏数据回默认:任意脏输入都产出合法账本(存储层读盘的唯一入口) */
export function sanitizeLedger(raw: unknown): SupportLedger {
  const base = defaultLedger()
  if (typeof raw !== 'object' || raw === null) return base
  const o = raw as Record<string, unknown>
  const num = (v: unknown) => (Number.isFinite(v) && (v as number) >= 0 ? Math.floor(v as number) : 0)
  const pityRaw = (typeof o.pity === 'object' && o.pity !== null ? o.pity : {}) as Record<string, unknown>
  const collection: Record<string, CollectionEntry> = {}
  if (typeof o.collection === 'object' && o.collection !== null) {
    for (const [id, v] of Object.entries(o.collection as Record<string, unknown>)) {
      // 陌生 id(池子已改)直接丢弃,不留僵尸数据
      if (!prizeById(id) || typeof v !== 'object' || v === null) continue
      const e = v as Record<string, unknown>
      const count = num(e.count)
      if (count <= 0) continue
      collection[id] = { count, firstAt: Number.isFinite(e.firstAt) ? (e.firstAt as number) : Date.now() }
    }
  }
  return {
    version: 1,
    totalSupportedYuan: Number.isFinite(o.totalSupportedYuan) && (o.totalSupportedYuan as number) >= 0
      ? Math.round((o.totalSupportedYuan as number) * 100) / 100
      : 0,
    drawsLeft: Math.min(num(o.drawsLeft), 1_000_000),
    totalDraws: num(o.totalDraws),
    pity: { sinceEpic: num(pityRaw.sinceEpic), sinceLegendary: num(pityRaw.sinceLegendary) },
    collection,
  }
}
