// C 的动作仲裁:所有"想播什么"的请求按固定优先级竞出唯一胜者,组件不做第二次判断。
// 优先级(高→低):隐藏 > 用户拖拽 > 说话 > 剧情指定反应 > 点击回应 > 漫游 > 随机待机 > 普通待机。
// "随机动画绝不能覆盖说话或剧情动作"由这里单一出口保证;
// 说话中拖拽=显示拖拽动画,松手后 speaking 未变则自然落回说话——恢复不需要专门逻辑。
import { isLoopingClip, nativeFacing, pickClip } from './residentManifest'
import { quantizeMood, type Mood } from '../../engine/moodState'
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

/** 随机待机链候选:都是单次片段,播完停帧片刻回待机(哼歌穿插,偶尔切工作状态) */
export const AMBIENT_CLIPS: readonly ResidentClipId[] = ['turn', 'caught', 'hum']
export const AMBIENT_MIN_MS = 12_000
export const AMBIENT_MAX_MS = 25_000
/** 随机片段播完后的停帧停留 */
export const AMBIENT_HOLD_MS = 3200

/** 点击回应候选:乖巧管家式的反应(敲桌面/被抓包的偷吃是彩蛋) */
export const POKE_CLIPS: readonly ResidentClipId[] = ['happy', 'wave', 'startled', 'caught', 'tap']
/** 点击回应持续时长(到期回待机) */
export const POKE_HOLD_MS = 2800

// ---------- 情绪余波偏置(纯函数,测试直接喂 Mood)----------
// C 的心情(moodStore)不是只给文案:她的随机行为池也跟着变——
// 闹情绪不哼歌改敲桌面、蔫了安静发呆、精神足多干点专注小事。平静时走默认池,零成本。

/** 随机待机候选池:情绪不好时 hum(哼歌)收起来,换 tap(敲桌面闹情绪)/更安静的发呆 */
export function ambientClipsForMood(mood: Mood): readonly ResidentClipId[] {
  const face = quantizeMood(mood).id
  if (face === 'angry') return ['turn', 'caught', 'tap']
  if (face === 'sad' || face === 'sleepy') return ['turn', 'caught']
  if (face === 'excited' || face === 'restless') return ['turn', 'caught', 'hum', 'focus']
  return AMBIENT_CLIPS
}

/** 随机待机节奏倍率:蔫了/犯困懒得动,小动作间隔拉长 */
export function ambientIntervalScale(mood: Mood): number {
  const face = quantizeMood(mood).id
  return face === 'sad' || face === 'sleepy' ? 1.5 : 1
}

/** 点击回应候选池:情绪不好时热情的 happy/wave 收起来,startled/caught/tap 占比自然升高 */
export function pokeClipsForMood(mood: Mood): readonly ResidentClipId[] {
  const face = quantizeMood(mood).id
  if (face === 'angry' || face === 'sad') return ['startled', 'caught', 'tap']
  if (face === 'sleepy') return ['wave', 'startled', 'tap']
  return POKE_CLIPS
}

/** 漫游节奏:每隔一段空闲时间走一小趟 */
export const ROAM_PAUSE_MIN_MS = 20_000
export const ROAM_PAUSE_MAX_MS = 45_000

/** 方向性片段是否需要水平镜像:素材原生朝向与实际移动方向相反时翻,
 *  否则就是"倒着走"。无方向性片段(待机/反应/原地类)或静止(移动量为 0)恒不翻 */
export function shouldFlip(clip: ResidentClipId, moveDir: number): boolean {
  const facing = nativeFacing(clip)
  if (facing === 0 || moveDir === 0) return false
  return facing !== Math.sign(moveDir)
}
