// C 的小范围水平漫游:路径计算纯函数集。状态与计时由调用方(ResidentActor)持有,
// 这里不做任何副作用,可独立测试。漫游是"溜达"不是"位移"——小步幅、慢速度、贴边界反弹。
export interface RoamBounds {
  minPct: number
  maxPct: number
}

/** 漫游范围:不出甲乙常规活动带(它们默认在 20%/80%) */
export const RESIDENT_ROAM_BOUNDS: RoamBounds = { minPct: 8, maxPct: 92 }

/** 单次漫游步幅(屏宽百分比):小范围溜达,不做横穿全屏的大移动 */
const STEP_MIN_PCT = 3
const STEP_MAX_PCT = 7

/** 行进速度(百分点/秒):螃蟹步的悠闲速度;组件按它换算步进节奏 */
export const ROAM_SPEED_PCT_PER_SEC = 1.1

/** 下一个漫游目标:距离当前 3~7 个百分点,越界自动反弹回界内 */
export function nextRoamTarget(
  currentPct: number,
  rand: () => number = Math.random,
  bounds: RoamBounds = RESIDENT_ROAM_BOUNDS,
): number {
  // 生成一个 3~7 的步幅,方向随机;贴边时强制向内
  const magnitude = STEP_MIN_PCT + rand() * (STEP_MAX_PCT - STEP_MIN_PCT)
  let direction = rand() < 0.5 ? -1 : 1
  if (currentPct + direction * magnitude > bounds.maxPct) direction = -1
  if (currentPct + direction * magnitude < bounds.minPct) direction = 1
  const next = currentPct + direction * magnitude
  return Math.min(bounds.maxPct, Math.max(bounds.minPct, next))
}

/** 行进耗时:按速度换算,给组件做步进推进与漫游态计时 */
export function roamDurationMs(fromPct: number, toPct: number): number {
  const dist = Math.abs(toPct - fromPct)
  return Math.round((dist / ROAM_SPEED_PCT_PER_SEC) * 1000)
}
