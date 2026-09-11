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

/**
 * 双槽切换时长(ms)。切换引擎(CharacterSprite)在新图 decode 就绪后才发起过渡:
 * - crossfade/dip:新旧两槽同步互补淡化,任一时刻合成可见度 = 1,不存在空窗帧
 * - impact:0ms 硬切——同帧对调零中间帧,冲击感由 motion-* 起势动画承担
 * 导出供 spriteTransition 回归做合成可见度模拟(单一事实源)。
 */
export const SWITCH_MS: Record<TransitionMode, number> = {
  crossfade: 140,
  dip: 120,
  impact: 0,
}
