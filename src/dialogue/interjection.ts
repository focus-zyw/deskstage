// 演出中安全插话(P4):用户在演出进行时发消息,不在句中打断,
// 而是等当前句结束(onLineEnd 安全缝)后接管——生成 1~3 句反应回合,
// 反应完把话头接回原剧本继续演;整集仍按单次落盘提交完整真实路径。

import type { DialogLine } from '../performer/dialogSchema'

export interface InterjectionPlan {
  /** 新播放列表 = 反应回合 + 剩余原剧本 */
  list: DialogLine[]
  /** 是否仍携带原抉择点/分支(尚未选边时为 true) */
  keepChoice: boolean
  /** 已插话的当前句下标(playingLines 中),接回从下一句开始 */
  consumedIndex: number
}

/** 纯函数:由当前播放进度与反应回合,合成"反应后接回"的新播放列表。
 *  index = 已开播的当前句(算作已播,接回从它的下一句开始);
 *  chosen = 观众已选边(分支播放中,抉择点已消费) */
export function planInterjectionTakeover(opts: {
  reaction: DialogLine[]
  playingLines: DialogLine[]
  index: number
  chosen: boolean
}): InterjectionPlan {
  const remaining = opts.playingLines.slice(opts.index + 1)
  return {
    list: [...opts.reaction, ...remaining],
    keepChoice: !opts.chosen,
    consumedIndex: opts.index,
  }
}

/** 抉择点工具:未选边时返回原值(choice/after),已选边返回 undefined */
export function keepChoiceOpts<T>(chosen: boolean, value?: T): T | undefined {
  return chosen ? undefined : value
}
