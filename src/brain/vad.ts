// VAD 连续情绪空间:影子大脑决策协议的表达层。
// 为什么连续值:离散标签后面做渐变很难;内部/协议保存 VAD,对 LLM/UI 映射标签。
// v = valence(愉悦度 -1 烦躁 .. 1 愉悦)、a = arousal(唤醒度 -1 蔫 .. 1 亢奋)、
// d = dominance(支配度 -1 顺从 .. 1 主导)。
// 本地 moodState 目前只有 valence/energy 双标量:moodToVad 单向投影(d 暂记 0,
// 本地暂无支配度信号);VAD 的完整落地(moodState 迁移/Fatigue/Relationship)是
// 后续独立工程,见 docs/影子大脑桥接设计方案.md 的终态路线图。

import type { Mood } from '../engine/moodState'
import { VALENCE_LIMIT, ENERGY_LIMIT } from '../engine/moodState'

/** VAD 三维各钳 -1..1 */
export interface Vad {
  v: number
  a: number
  d: number
}

export function clampVad(v: Vad): Vad {
  const one = (x: number): number =>
    Number.isFinite(x) ? Math.min(1, Math.max(-1, x)) : 0
  return { v: one(v.v), a: one(v.a), d: one(v.d) }
}

/** 离散标签(调试界面/Trace 展示用;给 LLM 的仍是连续值或标签皆可)。
 *  阈值设计:效价定愉悦/恼火/低落/满足,唤醒定兴奋/犯困/坐不住,支配细分恼火/委屈 */
export type VadLabel =
  | 'cheerful' // 愉悦+高唤醒:正美着呢
  | 'content' // 愉悦+低唤醒:满足慵懒
  | 'annoyed' // 负效价+高唤醒+高支配:来气
  | 'anxious' // 负效价+高唤醒+低支配:委屈/不安
  | 'gloomy' // 负效价+低唤醒:蔫了
  | 'restless' // 中性效价+高唤醒:坐不住想搞事
  | 'sleepy' // 低唤醒:犯困
  | 'calm' // 其余:平稳

const V_POS = 0.45
const V_NEG = -0.45
const A_HI = 0.5
const A_LO = -0.55
const D_MID = 0.4

export function vadToLabel(v: Vad): VadLabel {
  const c = clampVad(v)
  if (c.v >= V_POS) return c.a >= A_HI ? 'cheerful' : 'content'
  if (c.v <= V_NEG) {
    if (c.a >= A_HI) return c.d >= D_MID ? 'annoyed' : 'anxious'
    return 'gloomy'
  }
  if (c.a >= 0.55) return 'restless'
  if (c.a <= A_LO) return 'sleepy'
  return 'calm'
}

/** VAD → 立绘动作词表(VALID_ACTIONS):本地执行的落点。
 *  映射是表达层翻译不是权威——演出侧自有放松链与待机染色 */
export function vadToAction(v: Vad): string {
  switch (vadToLabel(v)) {
    case 'cheerful':
      return 'laugh'
    case 'content':
      return 'happy'
    case 'annoyed':
      return 'angry'
    case 'anxious':
      return 'shy'
    case 'gloomy':
      return 'sad'
    case 'restless':
      return 'jump'
    case 'sleepy':
      return 'sleepy'
    case 'calm':
      return 'idle'
  }
}

/** moodState 双标量 → VAD 单向投影:v=valence/3,a=energy 折 -1..1,d 暂记 0。 */
export function moodToVad(m: Mood): Vad {
  return {
    v: Math.min(1, Math.max(-1, m.valence / VALENCE_LIMIT)),
    a: Math.min(1, Math.max(-1, (m.energy / ENERGY_LIMIT) * 2 - 1)),
    d: 0,
  }
}
