/**
 * 立绘切换策略。
 *
 * 调用方只提供语义动作，本模块集中决定切图方式与起势动画：
 * - crossfade：身体基本一致，允许新旧图短暂重叠；
 * - dip：手臂/道具变化较大，旧图先退、新图再进，避免“四只手”；
 * - impact：快速切图，再用外层动势强调惊讶、跳跃等瞬时反应。
 */
export type TransitionMode = 'crossfade' | 'dip' | 'impact'
export type TransitionStyle = 'soft' | 'pop' | 'snap' | 'sink' | 'recoil'

export interface SpriteMotion {
  mode: TransitionMode
  style: TransitionStyle
}

const DEFAULT_MOTION: SpriteMotion = { mode: 'crossfade', style: 'soft' }

const MOTION_BY_ACTION: Record<string, SpriteMotion> = {
  happy: { mode: 'crossfade', style: 'pop' },
  laugh: { mode: 'crossfade', style: 'pop' },
  surprise: { mode: 'impact', style: 'snap' },
  sad: { mode: 'crossfade', style: 'sink' },
  sleepy: { mode: 'crossfade', style: 'sink' },
  angry: { mode: 'impact', style: 'recoil' },
  shake: { mode: 'impact', style: 'recoil' },
  jump: { mode: 'impact', style: 'pop' },
  reading: { mode: 'dip', style: 'soft' },
  present: { mode: 'dip', style: 'pop' },
}

/** 未配置动作保持轻柔交叉淡入，新增动作无需同步修改调用方。 */
export function motionForAction(action: string): SpriteMotion {
  return MOTION_BY_ACTION[action] ?? DEFAULT_MOTION
}
