// 用户聊天短期窗口(doc §5.2 会话短期状态):最近 N 个 turn 的会话记忆。
// 进程内存存续(会话态不落盘);超出上限直删最旧——LLM 摘要压缩列为后续可选。
// 用户聊天与演出插话(P4)共用同一窗口,保证"插话接回"时角色记得刚才聊了什么。

export type TurnWho = 'user' | 'A' | 'B'

export interface ChatTurn {
  who: TurnWho
  text: string
}

const MAX_TURNS = 10

let turns: ChatTurn[] = []

/** 追加一个 turn(超上限淘汰最旧) */
export function pushTurn(t: ChatTurn): void {
  const text = t.text.trim()
  if (!text) return
  turns = [...turns, { who: t.who, text }].slice(-MAX_TURNS)
}

/** 当前窗口快照(新在后) */
export function chatWindow(): ChatTurn[] {
  return [...turns]
}

/** 清空(测试/重置用) */
export function resetChatWindow(): void {
  turns = []
}
