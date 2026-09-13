// 逻辑动作 → WebM 片段的唯一映射(深模块):对话协议与呈现器只知道词表动作,
// 具体播哪个文件、缺哪个回退什么,全部收在这里——协议永远不出现中文文件名。
// 素材来自 dsh-pet(https://github.com/PC2005-cloud/dsh-pet),经 scripts/fetch-c-animations.mjs
// 抓取重命名为稳定英文 ID;文件缺失时运行期回退 idle,不报错不阻塞。
import type { ResidentClipId } from './residentTypes'

/** 稀有彩蛋池:超低频惊喜(鲸鱼大招/魔术/杂技/吃Token),不进常规池避免被稀释。
 *  声明在词表之前:INTERNAL_CLIPS 的 trick(右键点播绝活)整池引用它 */
export const RARE_CLIPS: readonly ResidentClipId[] = [
  'whale_rise',
  'whale_bubble',
  'dove',
  'card_magic',
  'juggle',
  'gomoku',
  'bloom',
  'eat_token',
]

/** 稀有彩蛋触发概率 */
export const RARE_CHANCE = 0.02

/** 词表动作(VALID_ACTIONS)→ 候选片段;多个候选随机挑,同一动作不总是一个动画 */
const ACTION_CLIPS: Record<string, ResidentClipId[]> = {
  idle: ['idle'],
  talk: ['talk'],
  thinking: ['think', 'pace'],
  happy: ['happy', 'wave'],
  laugh: ['happy', 'wave', 'cheer'],
  wave: ['wave'],
  shy: ['surprise'],
  surprise: ['surprise', 'startled'],
  angry: ['angry'],
  // 动作补缺:此前这些词回退待机,现在各有贴语义的片段
  sad: ['sigh', 'fallen'],
  sleepy: ['yawn', 'nap'],
  shake: ['squash'],
  jump: ['jump_smash'],
  // 右键点播"跳个舞":情绪池的宅舞三件套
  dance: ['dance', 'swing_dance', 'spin_show'],
}

/** C 内部动作(状态机/交互专用,对话协议不产生这些词) */
const INTERNAL_CLIPS: Record<string, ResidentClipId[]> = {
  turn: ['turn'],
  walk: ['walk'],
  float: ['float'],
  drag: ['drag'],
  caught: ['caught'],
  // 工具任务围观:写代码为主,忙碌点按/清点归档/轻快记录做候选
  working: ['working', 'focus', 'filing', 'note_quick'],
  // 久坐提醒:伸懒腰
  stretch: ['stretch'],
  // 待机哼歌
  hum: ['hum'],
  // 点击回应:敲桌面互动
  tap: ['tap'],
  // 摸头/挠痒(长按手势):咯咯笑为主,开心/欢呼做候选
  headpat: ['tickle', 'happy', 'cheer'],
  // 右键点播"睡午觉":固定午睡,不与 sleepy 的打哈欠混选
  nap: ['nap'],
  // 投喂吃撑(连喂):被点心压扁
  stuffed: ['squash'],
  // 右键点播"来个绝活":稀有彩蛋整池点播,不必再等 2% 随机
  trick: [...RARE_CLIPS],
  // 右键点播"投喂零食":点心动作词按当下时段/季节由 snackActionNow 选出,一词一片段
  breakfast: ['breakfast'],
  lunch: ['lunch'],
  dinner: ['dinner'],
  ice_cream: ['ice_cream'],
  watermelon: ['watermelon'],
  hotpot: ['hotpot'],
  what_to_eat: ['what_to_eat'],
}

/** 待机链候选(管家日常与玩心,单次片段):擦桌/对屏碎碎念是本职,其余是玩心 */
export const AMBIENT_CLIPS: readonly ResidentClipId[] = [
  'turn',
  'caught',
  'hum',
  'wipe',
  'screen_mutter',
  'daze',
  'cat',
  'mirror',
  'cube',
  'toy_car',
  'kick_shuttle',
  'rocking_horse',
  'spin_top',
  'animals',
  'butterflies',
]

/** 点击回应候选(乖巧管家式的反应;挠痒咯咯笑/被吓一跳是新候选) */
export const POKE_CLIPS: readonly ResidentClipId[] = ['happy', 'wave', 'startled', 'caught', 'tap', 'tickle', 'scared']

/** 时间情境池:特定时段/季节小管家会做的事(与情绪池取并集,时间特色占大头) */
export function timeAmbientClips(slotId: string, month: number): readonly ResidentClipId[] {
  const bySlot: Record<string, readonly ResidentClipId[]> = {
    earlyMorning: ['brush'],
    morning: ['breakfast'],
    noon: ['lunch'],
    afternoon: ['what_to_eat'],
    dusk: ['dinner'],
  }
  const clips = [...(bySlot[slotId] ?? [])]
  if (month >= 6 && month <= 8) clips.push('fan', 'watermelon', 'ice_cream')
  if (month === 12 || month <= 2) clips.push('snowman', 'hotpot')
  return clips
}

/** 投喂零食 → 当下该吃的点心(动作词,经 INTERNAL_CLIPS 一词一片段)。
 *  与 timeAmbientClips 同一套时段/季节口味:早上早餐、午间午餐、夏天冷饮、冬天火锅,
 *  其余时段端出"想想吃啥"的纠结;now 可注入(测试) */
export function snackActionNow(now: Date = new Date()): string {
  const hour = now.getHours()
  const month = now.getMonth() + 1
  if (hour < 10) return 'breakfast'
  if (hour < 14) return 'lunch'
  if (hour < 17) {
    if (month >= 6 && month <= 8) return Math.random() < 0.5 ? 'ice_cream' : 'watermelon'
    return 'what_to_eat'
  }
  if (hour < 20) return 'dinner'
  if (month === 12 || month <= 2) return 'hotpot'
  return 'what_to_eat'
}

const FALLBACK: ResidentClipId[] = ['idle']

/** 动作词 → 候选片段列表;未知动作回退 idle(调用方自行随机挑) */
export function clipsForAction(action: string): readonly ResidentClipId[] {
  return ACTION_CLIPS[action] ?? INTERNAL_CLIPS[action] ?? FALLBACK
}

/** 候选里随机挑一个(随机源可注入,测试用) */
export function pickClip(action: string, rand: () => number = Math.random): ResidentClipId {
  const candidates = clipsForAction(action)
  return candidates[Math.min(candidates.length - 1, Math.floor(rand() * candidates.length))]
}

/** 循环片段:持续状态(待机/说话/思考/移动/拖拽/工作)循环播放;反应类单次播完停在末帧 */
const LOOPING = new Set<ResidentClipId>([
  'idle',
  'talk',
  'think',
  'walk',
  'float',
  'drag',
  'working',
  'focus',
  'filing',
  'note_quick',
  'pace',
  'wipe',
  'cat',
  'cube',
  'daze',
  'screen_mutter',
])

export function isLoopingClip(clip: ResidentClipId): boolean {
  return LOOPING.has(clip)
}

/** 片段 → 播放地址(BASE_URL 与 spriteSets 同源,兼容浏览器 dev 与 Tauri) */
export function residentSrc(clip: ResidentClipId): string {
  return `${import.meta.env.BASE_URL}animations/c/${clip}.webm`
}

/** 方向性片段的原生行进朝向(帧分析:walk.webm 的螃蟹步向画面左侧行进,帧间重心左摆)。
 *  只登记水平位移类片段;原地类(待机/反应/拖拽/float)不在此表=无方向性,参与镜像判定时恒不翻转 */
export const CLIP_NATIVE_FACING: Partial<Record<ResidentClipId, 1 | -1>> = {
  walk: -1,
}

/** 片段的原生朝向:1=朝右,-1=朝左,0=无方向性 */
export function nativeFacing(clip: ResidentClipId): 1 | -1 | 0 {
  return CLIP_NATIVE_FACING[clip] ?? 0
}

/** 启动预热全部片段,演出中首次切换零等待(与 preloadSprites 同一思路) */
export function preloadResident(): void {
  const clips = new Set<ResidentClipId>([
    ...Object.values(ACTION_CLIPS).flat(),
    ...Object.values(INTERNAL_CLIPS).flat(),
    ...AMBIENT_CLIPS,
    ...POKE_CLIPS,
    ...RARE_CLIPS,
  ])
  for (const clip of clips) {
    const video = document.createElement('video')
    video.preload = 'auto'
    video.muted = true
    video.src = residentSrc(clip)
  }
}
