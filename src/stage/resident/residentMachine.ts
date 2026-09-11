// C 的动作仲裁:所有"想播什么"的请求按固定优先级竞出唯一胜者,组件不做第二次判断。
// 优先级(高→低):隐藏 > 用户拖拽 > 说话 > 剧情指定反应 > 点击回应 > 漫游 > 随机待机 > 普通待机。
// "随机动画绝不能覆盖说话或剧情动作"由这里单一出口保证;
// 说话中拖拽=显示拖拽动画,松手后 speaking 未变则自然落回说话——恢复不需要专门逻辑。
import { isLoopingClip, pickClip } from './residentManifest'
import type { ResidentClipId, ResidentPlayback } from './residentTypes'

export interface ResidentIntents {
  /** charactersHidden 或设置里禁用:整身不渲染(null) */
  hidden: boolean
  /** 拖拽进行中(松手前保持最高优先) */
  dragging: boolean
  /** TTS 正在说话 */
  speaking: boolean
  /** 剧情/呈现层指定动作(action.C);'idle' 视为未指定 */
  scripted: string | null
  /** 点击回应片段(短暂持有,由机器计时回收) */
  poke: ResidentClipId | null
  /** 漫游移动中 */
  roaming: boolean
  /** 随机待机链当前片段(如东张西望) */
  ambient: ResidentClipId | null
}

/** 仲裁出当前应播片段;hidden 返回 null(整身不渲染) */
export function resolveResidentClip(intents: ResidentIntents): ResidentPlayback | null {
  if (intents.hidden) return null
  const decide = (action: string): ResidentPlayback => {
    const clip = pickClip(action)
    return { clip, loop: isLoopingClip(clip) }
  }
  if (intents.dragging) return decide('drag')
  if (intents.speaking) return decide('talk')
  if (intents.scripted && intents.scripted !== 'idle') return decide(intents.scripted)
  if (intents.poke) return { clip: intents.poke, loop: isLoopingClip(intents.poke) }
  if (intents.roaming) return decide('walk')
  if (intents.ambient) return { clip: intents.ambient, loop: isLoopingClip(intents.ambient) }
  return decide('idle')
}

// ---------- 生命感参数(组件按这些节奏驱动随机链/点击回应/漫游) ----------

/** 随机待机链候选:都是单次片段,播完停帧片刻回待机 */
export const AMBIENT_CLIPS: readonly ResidentClipId[] = ['turn', 'caught']
export const AMBIENT_MIN_MS = 12_000
export const AMBIENT_MAX_MS = 25_000
/** 随机片段播完后的停帧停留 */
export const AMBIENT_HOLD_MS = 3200

/** 点击回应候选:乖巧管家式的反应(被抓包的偷吃是彩蛋) */
export const POKE_CLIPS: readonly ResidentClipId[] = ['happy', 'wave', 'startled', 'caught']
/** 点击回应持续时长(到期回待机) */
export const POKE_HOLD_MS = 2800

/** 漫游节奏:每隔一段空闲时间走一小趟 */
export const ROAM_PAUSE_MIN_MS = 20_000
export const ROAM_PAUSE_MAX_MS = 45_000
