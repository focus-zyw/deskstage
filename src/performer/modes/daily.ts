// 日常模式：两个朋友自然闲聊。相当于 class DailyMode extends DialogMode
import type { DialogLine } from '../player'
import type { DialogMode } from './index'

const DAILY_SCRIPT: DialogLine[] = [
  { speaker: 'A', text: '今天天气真不错，窗外阳光正好。', action: 'happy' },
  { speaker: 'B', text: '是啊，这种天最适合摸鱼了。', action: 'talk' },
  { speaker: 'A', text: '话说你昨天是不是又熬夜了？', action: 'surprise' },
  { speaker: 'B', text: '咳……怎么可能，我十点就睡了。', action: 'sad' },
  { speaker: 'A', text: '黑眼圈都快垂到下巴了。', action: 'talk' },
  { speaker: 'B', text: '你礼貌吗！', action: 'angry' },
]

export const dailyMode: DialogMode<'daily'> = {
  id: 'daily',
  label: '日常',
  accent: '#7c6cf0',
  gap: 400,
  script: DAILY_SCRIPT,
  prompt:
    '当前是【日常】模式：两个朋友自然闲聊，有来有回，情绪有起伏（好奇、吐槽、小争执、和解），像真人聊天一样。',
  // 闲聊里较常聊到使用者的兴趣爱好
  interestTopicChance: 0.35,
}
