// 日常模式：熟人随口闲聊。相当于 class DailyMode extends DialogMode
import type { DialogLine } from '../player'
import type { DialogMode } from './index'

// 兜底剧本与非喜剧基调一致:自然来回、无互怼、无强制包袱
const DAILY_SCRIPT: DialogLine[] = [
  { speaker: 'A', text: '今天风好大，我刚出去买咖啡差点被吹跑。', action: 'surprise' },
  { speaker: 'B', text: '所以说你围巾只围了一半？我早就想提醒了。', action: 'talk' },
  { speaker: 'A', text: '哎，下午要不要一起点奶茶？我请。', action: 'happy' },
  { speaker: 'B', text: '行啊，不过别加冰，我胃今天有点闹脾气。', action: 'talk', listenerAction: 'happy' },
  { speaker: 'A', text: '记住了，热乎的，少糖。', action: 'talk' },
  { speaker: 'B', text: '嗯，跟你搭伙就是省心。', action: 'happy', pauseAfter: 1200 },
]

export const dailyMode: DialogMode<'daily'> = {
  id: 'daily',
  label: '日常',
  accent: '#7c6cf0',
  gap: 400,
  script: DAILY_SCRIPT,
  prompt:
    '当前是【日常】模式：像熟人随口聊天，一次只聊一个小事件；允许平淡、有停顿、有没接上的话。幽默服务于亲切感，不强制反转、秘密和收底。',
  // 闲聊里较常聊到使用者的兴趣爱好
  interestTopicChance: 0.35,
  // 自然语言点播触发词("来一段日常/来一段闲聊")
  triggers: ['日常', '闲聊'],
  // 基调:非喜剧闲聊——不套用互怼喜剧骨架,句数走 8~16 档,secret/callback 不强制
  tone: '日常闲聊',
}
