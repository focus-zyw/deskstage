// 相声模式：逗哏铺包袱、捧哏拆台。相当于 class CrosstalkMode extends DialogMode
import type { DialogLine } from '../player'
import type { DialogMode } from './index'

const CROSSTALK_SCRIPT: DialogLine[] = [
  { speaker: 'A', text: '我最近发现一条发财的路子。', action: 'talk' },
  { speaker: 'B', text: '哦？', action: 'talk' },
  { speaker: 'A', text: '我把家里攒了十年的旧书全卖了。', action: 'talk', delivery: 'excited' },
  { speaker: 'B', text: '卖了多少钱？', action: 'talk' },
  { speaker: 'A', text: '三十八块五！当晚请全楼吃了顿火锅。', action: 'happy', pauseBefore: 400 },
  { speaker: 'B', text: '好家伙，倒贴三百多。', action: 'surprise', listenerAction: 'sad' },
  { speaker: 'A', text: '外行了不是？这叫盘活闲置资产。', action: 'talk', delivery: 'deadpan' },
  { speaker: 'B', text: '嗐！你可拉倒吧！', action: 'angry', pauseAfter: 1200 },
]

export const crosstalkMode: DialogMode<'crosstalk'> = {
  id: 'crosstalk',
  label: '相声',
  accent: '#f08c5a',
  gap: 200,
  script: CROSSTALK_SCRIPT,
  prompt:
    '当前是【相声】模式：甲是逗哏（负责铺陈和抖包袱），乙是捧哏（用"哦？""好家伙""嗐！"这类短句接话、拆台）。结构：开头垫话 1~2 句，中间正活层层展开，最后 1 句必须是收底的包袱。',
  // 相声结构化强,兴趣只作偶尔点缀,不构成话题约束
  interestTopicChance: 0.12,
  // 自然语言点播触发词("来一段相声/来一段段子")
  triggers: ['相声', '段子'],
  // 基调显式声明:默认互怼喜剧全套
  tone: 'comedy',
}
