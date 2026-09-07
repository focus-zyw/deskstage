import type { DialogLine } from './player'

// 硬编码演示脚本（M1）。M2 起由 LLM 生成同结构数据替换。
// 相声模式：A=逗哏（叙事、抖包袱），B=捧哏（接话、拆台）。

export const DAILY_SCRIPT: DialogLine[] = [
  { speaker: 'A', text: '今天天气真不错，窗外阳光正好。', action: 'happy' },
  { speaker: 'B', text: '是啊，这种天最适合摸鱼了。', action: 'talk' },
  { speaker: 'A', text: '话说你昨天是不是又熬夜了？', action: 'surprise' },
  { speaker: 'B', text: '咳……怎么可能，我十点就睡了。', action: 'sad' },
  { speaker: 'A', text: '黑眼圈都快垂到下巴了。', action: 'talk' },
  { speaker: 'B', text: '你礼貌吗！', action: 'angry' },
]

export const CROSSTALK_SCRIPT: DialogLine[] = [
  { speaker: 'A', text: '我最近发现一条发财的路子。', action: 'talk' },
  { speaker: 'B', text: '哦？', action: 'talk' },
  { speaker: 'A', text: '我把家里攒了十年的旧书全卖了。', action: 'talk' },
  { speaker: 'B', text: '卖了多少钱？', action: 'talk' },
  { speaker: 'A', text: '三十八块五！当晚请全楼吃了顿火锅。', action: 'happy' },
  { speaker: 'B', text: '好家伙，倒贴三百多。', action: 'surprise' },
  { speaker: 'A', text: '外行了不是？这叫盘活闲置资产。', action: 'talk' },
  { speaker: 'B', text: '嗐！你可拉倒吧！', action: 'angry' },
]

export const MODES = {
  daily: { label: '日常', gap: 400, script: DAILY_SCRIPT },
  crosstalk: { label: '相声', gap: 200, script: CROSSTALK_SCRIPT },
} as const

export type Mode = keyof typeof MODES
