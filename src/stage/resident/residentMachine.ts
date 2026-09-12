// C 的动作仲裁:所有"想播什么"的请求按固定优先级竞出唯一胜者,组件不做第二次判断。
// 优先级(高→低):隐藏 > 用户拖拽 > 说话 > 剧情指定反应 > 点击回应 > 漫游 > 随机待机 > 普通待机。
// "随机动画绝不能覆盖说话或剧情动作"由这里单一出口保证;
// 说话中拖拽=显示拖拽动画,松手后 speaking 未变则自然落回说话——恢复不需要专门逻辑。
import {
  AMBIENT_CLIPS,
  POKE_CLIPS,
  RARE_CHANCE,
  RARE_CLIPS,
  isLoopingClip,
  nativeFacing,
  pickClip,
  timeAmbientClips,
} from './residentManifest'
import { FESTIVAL_CLIPS, festivalOf } from './residentCalendar'
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

// AMBIENT_CLIPS / POKE_CLIPS 移至 residentManifest(纯数据层,preload 同源消费)
export { AMBIENT_CLIPS, POKE_CLIPS } from './residentManifest'
export const AMBIENT_MIN_MS = 12_000
export const AMBIENT_MAX_MS = 25_000
/** 随机片段播完后的停帧停留 */
export const AMBIENT_HOLD_MS = 3200

/** 点击回应持续时长(到期回待机) */
export const POKE_HOLD_MS = 2800

// ---------- 情绪余波偏置(纯函数,测试直接喂 Mood)----------
// C 的心情(moodStore)不是只给文案:她的随机行为池也跟着变——
// 闹情绪不哼歌改敲桌面、蔫了安静发呆、精神足多干点专注小事。平静时走默认池,零成本。

/** 随机待机候选池:情绪不好时 hum(哼歌)收起来,换 tap(敲桌面闹情绪)/更安静的发呆;
 *  气急败坏/拍地是 angry 面专属,蔫了加发呆小憩,兴奋加宅舞旋转 */
export function ambientClipsForMood(mood: Mood): readonly ResidentClipId[] {
  const face = quantizeMood(mood).id
  if (face === 'angry') return ['turn', 'caught', 'tap', 'rage_quit', 'whale_slam']
  if (face === 'sad') return ['turn', 'caught', 'daze', 'fallen']
  if (face === 'sleepy') return ['turn', 'caught', 'yawn']
  if (face === 'excited') return ['turn', 'caught', 'hum', 'focus', 'dance', 'swing_dance', 'spin_show', 'cheer']
  if (face === 'restless') return ['turn', 'caught', 'hum', 'focus', 'pace']
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
  if (face === 'angry' || face === 'sad') return ['startled', 'caught', 'tap', 'scared']
  if (face === 'sleepy') return ['wave', 'startled', 'tap']
  return POKE_CLIPS
}

// ---------- 待机池组合:节日 > 稀有彩蛋 > 时间∪情绪 > 默认 ----------

export interface AmbientContext {
  /** 心情余波(moodStore) */
  mood: Mood
  /** timeAware 时段 id(earlyMorning/morning/noon/afternoon/dusk/evening/lateNight) */
  slotId: string
  /** 公历月(1~12)/日/年——节日与季节判定 */
  month: number
  day: number
  year: number
}

/** 本拍待机该播什么(纯函数,rand 可注入)。
 *  优先级:节日命中 → 整池替换为节日池(满屏节日感);
 *  否则 2% 掷稀有彩蛋;其余 = 时间特色池 ∪ 情绪池(时间在前,均匀随机下时间项占大头) */
export function pickAmbientClip(ctx: AmbientContext, rand: () => number = Math.random): ResidentClipId {
  const festival = festivalOf(ctx.month, ctx.day, ctx.year)
  if (festival) {
    const pool = FESTIVAL_CLIPS[festival]
    return pool[Math.floor(rand() * pool.length)]
  }
  if (rand() < RARE_CHANCE) {
    return RARE_CLIPS[Math.floor(rand() * RARE_CLIPS.length)]
  }
  // 时间特色池(时段+季节,season 在 timeAmbientClips 内部处理)在前,情绪池在后:
  // 均匀随机下时间项占大头——"这个点她会做的事"优先于"她现在的心情"
  const timeClips = [...timeAmbientClips(ctx.slotId, ctx.month)]
  const moodClips = ambientClipsForMood(ctx.mood)
  const merged = [...timeClips, ...moodClips]
  if (merged.length === 0) return AMBIENT_CLIPS[Math.floor(rand() * AMBIENT_CLIPS.length)]
  return merged[Math.floor(rand() * merged.length)]
}

/** seasonOf 供调用方复导出的便捷引用(测试/未来扩展用) */
export { seasonOf } from './residentCalendar'

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
