// 主播模式:直播弹幕互动。与日常/相声共用模式注册表(UI 分段按钮自动感知),
// 但不走 generateDialog 剧本链路——playMode('live') 分支到 App 的 startStreaming,
// 弹幕回复走 runtime/liveDanmaku 管线的轻量单句决策(generateLiveReply)。
// script 只当"开播白":连接成功前先播一轮,给用户即时的进入反馈。
import type { DialogLine } from '../player'
import type { DialogMode } from './index'

const LIVE_SCRIPT: DialogLine[] = [
  { speaker: 'A', text: '开播啦开播啦!进来的各位弹幕刷起来,我都看得见!', action: 'wave' },
  { speaker: 'B', text: '对,随便聊,问我们问题也行,就是答不答得上看缘分。', action: 'talk', listenerAction: 'happy' },
  { speaker: 'A', text: '咳,主要是看智力。', action: 'talk', listenerAction: 'angry', pauseAfter: 800 },
]

export const liveMode: DialogMode<'live'> = {
  id: 'live',
  label: '主播',
  accent: '#e0556d',
  // 弹幕回复各自走气泡清理节奏,gap 基本用不上;取与相声相近的小值
  gap: 300,
  script: LIVE_SCRIPT,
  // 直播互动不生成剧本;prompt 仅在误走剧本链路时兜底,保持搭档口吻
  prompt: '当前是【主播】模式:甲乙搭档直播读弹幕,以互怼但有默契的口吻回应直播间观众。',
  interestTopicChance: 0,
}
