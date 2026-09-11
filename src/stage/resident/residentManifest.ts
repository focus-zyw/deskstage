// 逻辑动作 → WebM 片段的唯一映射(深模块):对话协议与呈现器只知道词表动作,
// 具体播哪个文件、缺哪个回退什么,全部收在这里——协议永远不出现中文文件名。
// 素材来自 dsh-pet(https://github.com/PC2005-cloud/dsh-pet),经 scripts/fetch-c-animations.mjs
// 抓取重命名为稳定英文 ID;文件缺失时运行期回退 idle,不报错不阻塞。
import type { ResidentClipId } from './residentTypes'

/** 词表动作(VALID_ACTIONS)→ 候选片段;多个候选随机挑,同一动作不总是一个动画 */
const ACTION_CLIPS: Record<string, ResidentClipId[]> = {
  idle: ['idle'],
  talk: ['talk'],
  thinking: ['think'],
  happy: ['happy', 'wave'],
  laugh: ['happy', 'wave'],
  wave: ['wave'],
  shy: ['surprise'],
  surprise: ['surprise', 'startled'],
  angry: ['angry'],
  // C 没有独立素材的动作:语义最近或直接回退待机
  sad: ['idle'],
  sleepy: ['idle'],
  shake: ['idle'],
  jump: ['happy'],
}

/** C 内部动作(状态机/交互专用,对话协议不产生这些词) */
const INTERNAL_CLIPS: Record<string, ResidentClipId[]> = {
  turn: ['turn'],
  walk: ['walk'],
  float: ['float'],
  drag: ['drag'],
  caught: ['caught'],
  // 工具任务围观:写代码为主,忙碌点按作候选
  working: ['working', 'focus'],
  // 久坐提醒:伸懒腰
  stretch: ['stretch'],
  // 待机哼歌
  hum: ['hum'],
  // 点击回应:敲桌面互动
  tap: ['tap'],
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
const LOOPING = new Set<ResidentClipId>(['idle', 'talk', 'think', 'walk', 'float', 'drag', 'working'])

export function isLoopingClip(clip: ResidentClipId): boolean {
  return LOOPING.has(clip)
}

/** 片段 → 播放地址(BASE_URL 与 spriteSets 同源,兼容浏览器 dev 与 Tauri) */
export function residentSrc(clip: ResidentClipId): string {
  return `${import.meta.env.BASE_URL}animations/c/${clip}.webm`
}

/** 启动预热全部片段,演出中首次切换零等待(与 preloadSprites 同一思路) */
export function preloadResident(): void {
  const clips = new Set<ResidentClipId>([
    ...Object.values(ACTION_CLIPS).flat(),
    ...Object.values(INTERNAL_CLIPS).flat(),
  ])
  for (const clip of clips) {
    const video = document.createElement('video')
    video.preload = 'auto'
    video.muted = true
    video.src = residentSrc(clip)
  }
}
