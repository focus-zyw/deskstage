// 单聊会话工厂:direct:<slot> 房间,1对1直答。
// · 面板模式呈现:回复不弹舞台气泡、不朗读,只由聊天面板按 sessionId 渲染;
// · prompt 走 direct 直答形态(无 decision 协议/无群聊纪律,见 actorPrompt);
// · 创建时按 sessionId 过滤 chatlog 引导历史(惰性房间,打开即有上下文);
// · 演出中插话语义不适用(那是舞台群聊),host 的舞台回调全部为 no-op。
import { nameOf } from '../engine/persona'
import { directSessionId, listChatTurns } from '../storage/chatLogStore'
import type { ActorId } from '../groupChat/types'
import { createChatSession, type ChatSession, type ChatSessionOpts } from './ChatSession'

export interface DirectSessionOpts
  extends Pick<ChatSessionOpts, 'clock' | 'config' | 'adapters'> {
  /** 整轮零回复的兜底提示(面板内展示;缺省 no-op) */
  presentFallback?: (line: { speaker: ActorId; text: string }) => void
  /** 回复情绪的舞台动作反应(面板模式零气泡零 TTS 不变,只让角色做个表情一拍;
   *  缺省 no-op = 桌面保持安静)。宿主(App)经 ChatPanel 注入 */
  presentMood?: (who: ActorId, action?: string) => void
}

export function createDirectSession(slot: ActorId, opts: DirectSessionOpts = {}): ChatSession {
  const sessionId = directSessionId(slot)
  const session = createChatSession(
    {
      names: () => ({ A: nameOf('A'), B: nameOf('B'), C: nameOf('C') }),
      isPerforming: () => false,
      queueInterjection: () => {},
      presentTurn: () => {},
      presentUser: () => {}, // 用户消息由面板渲染(chatlog 订阅 + 本地乐观上屏)
      clearUser: () => {},
      presentFallback: (line) => opts.presentFallback?.(line),
      presentMood: (who, action) => opts.presentMood?.(who, action),
      onUserActive: () => {},
    },
    {},
    {
      clock: opts.clock,
      config: opts.config,
      adapters: opts.adapters,
      room: { kind: 'direct', slot },
    },
  )
  // 历史引导:按房间过滤(异步拉取;失败/为空 = 新房间,journal.bootstrap 空数组无害)
  void listChatTurns(60, sessionId).then((ts) => {
    session.bootstrapHistory(ts.map((t) => ({ who: t.who, text: t.text, ts: t.ts })))
  })
  return session
}
