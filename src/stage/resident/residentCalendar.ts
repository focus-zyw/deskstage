// C 的日历情境:公历节日表 + 主要农历节日的公历日期对照表 + 季节判定。
// 全部纯数据与纯函数,供 residentMachine 组合待机池;
// 判定错误的最坏后果只是节日动画在错的天出现,无功能影响——农历表按公开万年历录入,
// 覆盖 2025~2030,过期年份自动失效回落无节日态(新增年份往表里补一行即可)。
import type { ResidentClipId } from './residentTypes'

/** 公历固定节日:月-日(含窗口) → 节日 ID */
const SOLAR_FESTIVALS: { id: FestivalId; month: number; day: number; span?: number }[] = [
  { id: 'halloween', month: 10, day: 31 },
  { id: 'christmas', month: 12, day: 24, span: 3 }, // 平安夜~26
  { id: 'qingming', month: 4, day: 4, span: 2 }, // 清明节气在 4/4~4/6 附近
]

/** 农历节日公历日期对照(月-日字符串,按万年历录入;跨年年初的腊八/春节按公历日归属)。
 *  春节给 3 天窗口(含前一日除夕);端午/中秋/元宵等单日 */
const LUNAR_FESTIVALS: Record<Exclude<FestivalId, SolarFestivalId>, Record<string, [number, number][]>> = {
  // 春节:格式 年:[月,日...] 连续公历日
  spring: {
    '2025': [[1, 28], [1, 29], [1, 30]],
    '2026': [[2, 16], [2, 17], [2, 18]],
    '2027': [[2, 5], [2, 6], [2, 7]],
    '2028': [[1, 25], [1, 26], [1, 27]],
    '2029': [[2, 12], [2, 13], [2, 14]],
    '2030': [[2, 1], [2, 2], [2, 3]],
  },
  yuanxiao: {
    '2025': [[2, 12]],
    '2026': [[3, 3]],
    '2027': [[2, 21]],
    '2028': [[2, 9]],
    '2029': [[2, 27]],
    '2030': [[2, 16]],
  },
  duanwu: {
    '2025': [[5, 31]],
    '2026': [[6, 19]],
    '2027': [[6, 9]],
    '2028': [[5, 28]],
    '2029': [[6, 16]],
    '2030': [[6, 5]],
  },
  qixi: {
    '2025': [[8, 29]],
    '2026': [[8, 19]],
    '2027': [[8, 8]],
    '2028': [[8, 26]],
    '2029': [[8, 16]],
    '2030': [[8, 5]],
  },
  zhongqiu: {
    '2025': [[10, 6]],
    '2026': [[9, 25]],
    '2027': [[9, 15]],
    '2028': [[10, 3]],
    '2029': [[9, 22]],
    '2030': [[9, 12]],
  },
  chongyang: {
    '2025': [[10, 29]],
    '2026': [[10, 18]],
    '2027': [[10, 8]],
    '2028': [[10, 26]],
    '2029': [[10, 16]],
    '2030': [[10, 5]],
  },
  laba: {
    '2025': [[1, 7]],
    '2026': [[1, 26]],
    '2027': [[1, 15]],
    '2028': [[1, 4]],
    '2029': [[1, 22]],
    '2030': [[1, 11]],
  },
}

export type SolarFestivalId = 'halloween' | 'christmas' | 'qingming'
export type FestivalId =
  | SolarFestivalId
  | 'spring'
  | 'yuanxiao'
  | 'duanwu'
  | 'qixi'
  | 'zhongqiu'
  | 'chongyang'
  | 'laba'

/** 当天(公历月/日)命中的节日;span = 覆盖天数(含首日)。多节重叠时后写优先(表内无重叠,防御性取最后一个) */
export function festivalOf(month: number, day: number, year = new Date().getFullYear()): FestivalId | null {
  for (const f of SOLAR_FESTIVALS) {
    if (month === f.month && day >= f.day && day <= f.day + (f.span ?? 1) - 1) return f.id
  }
  for (const [id, byYear] of Object.entries(LUNAR_FESTIVALS as Record<string, Record<string, [number, number][]>>)) {
    if (byYear[String(year)]?.some(([m, d]) => m === month && d === day)) return id as FestivalId
  }
  return null
}

/** 季节带:夏季(6~8月)/冬季(12,1,2月),其余 null——时间池据此叠季节特色 */
export function seasonOf(month: number): 'summer' | 'winter' | null {
  if (month >= 6 && month <= 8) return 'summer'
  if (month === 12 || month <= 2) return 'winter'
  return null
}

/** 节日 → 待机替换池(节日当天满屏节日感) */
export const FESTIVAL_CLIPS: Record<FestivalId, readonly ResidentClipId[]> = {
  spring: ['fu', 'red_packet', 'dumplings', 'fireworks', 'lion_dance', 'rice_cake'],
  yuanxiao: ['tangyuan', 'sky_lantern'],
  duanwu: ['zongzi'],
  qixi: ['qixi_needle'],
  zhongqiu: ['mooncake'],
  chongyang: ['chongyang', 'chongyang_cake'],
  laba: ['laba_porridge'],
  qingming: ['qingtuan'],
  halloween: ['trick_treat'],
  christmas: ['christmas_tree'],
}
