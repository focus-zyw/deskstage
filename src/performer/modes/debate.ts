// 辩论模式:正反方围绕日常小话题针锋相对。相当于 class DebateMode extends DialogMode
import type { DialogLine } from '../player'
import type { DialogMode } from './index'

const DEBATE_SCRIPT: DialogLine[] = [
  { speaker: 'A', text: '我方认为,熬夜是自由意志的伟大胜利。', action: 'talk' },
  { speaker: 'B', text: '请问正方:自由到早上七点,还是自由到中午?', action: 'talk', listenerAction: 'thinking' },
  { speaker: 'A', text: '熬夜一时爽,一直熬夜一直爽!', action: 'happy' },
  { speaker: 'B', text: '爽完呢?黑眼圈都垂到下巴了。', action: 'surprise', pauseBefore: 400 },
  { speaker: 'A', text: '那是奋斗者专属的勋章!', action: 'angry' },
  { speaker: 'B', text: '行,那你戴着勋章去上班吧。', action: 'laugh', pauseAfter: 1200 },
]

export const debateMode: DialogMode<'debate'> = {
  id: 'debate',
  label: '辩论',
  accent: '#4aa3f0',
  gap: 260,
  script: DEBATE_SCRIPT,
  prompt:
    '当前是【辩论】模式:甲是正方,乙是反方,围绕一个日常小话题针锋相对。结构:开头各自亮观点 1 句,中间互相抓对方漏洞反驳(反问、举例、抬杠都行),最后 1 句必须是不服气的金句收尾。',
  interestTopicChance: 0.15,
}
