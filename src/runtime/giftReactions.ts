// 礼物反应旁路:GiftEvent → 道具动效 + 模板感谢语,完全免 AI(低延迟、零 token 消耗)。
// 为什么不进弹幕管线:礼物是即时性反馈,走 LLM 会慢一个数量级;弹幕管线照常独立运行。
// 感谢语不直接调 speak:经 deps.present 交给统一呈现口(App.presentLiveReply),
// 气泡/动作/TTS/计时清理全部复用;与 AI 回复的互斥由 ReactionGate(revision 门)保证。
// 说明:本模块只 import 类型(运行时零依赖),node --test 可直接加载。
import type { GiftEvent } from '../live'
import type { PropId } from '../stage/props'
import type { LiveReply } from './liveDanmaku'

// 档位阈值(金瓜子;B站 1000 金瓜子 = 1 元)。silver(瓜子/免费礼物)一律最低档。
export const TIER_MID_COIN = 1_000
export const TIER_TOP_COIN = 10_000

/** 礼物价值档位 → 道具:免费/小额递咖啡,中档奶茶,大额把话筒递给老板 */
export function giftTierToProp(totalCoin: number, coinType: 'gold' | 'silver'): PropId {
  if (coinType === 'silver') return 'coffee'
  if (totalCoin >= TIER_TOP_COIN) return 'microphone'
  if (totalCoin >= TIER_MID_COIN) return 'milk-tea'
  return 'coffee'
}

// 感谢语模板:{name} = 观众名,{gift} = 礼物名
const THANKS: Partial<Record<PropId, string[]>> = {
  coffee: ['{name}请的咖啡到啦,先干为敬!', '谢谢{name}的咖啡,这下精神了!'],
  'milk-tea': ['{name}的奶茶太暖了,谢谢!', '吸溜——谢谢{name}请的奶茶!'],
  microphone: ['话筒递给{name}老板,有排面!', '{name}直接把话筒拍桌上了,感谢老板!'],
}
// 注册表外道具的兜底(理论上不触发,防漏词冷场)
const GENERIC_THANKS = ['谢谢{name}送的{gift}!', '{name}的{gift}收到啦,感谢!']

/** 观众名清洗:去首尾空白与换行、截断;空名用通用称呼 */
export function cleanName(raw: string): string {
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, 12)
  return name || '这位观众'
}

/**
 * 呈现仲裁门:礼物感谢与 AI 弹幕回复共用一份"最近一次即时呈现"的版本号。
 * AI 发请求前 capture(),返回后 valid() 校验 —— 期间发生过礼物呈现(bump)则旧回复作废,
 * 否则礼物感谢刚上气泡就会被在途 AI 回复顶掉(同级 stream TTS 后到者抢占,同理)。
 */
export function createReactionGate() {
  let revision = 0
  return {
    capture(): number {
      return revision
    },
    bump(): void {
      revision++
    },
    valid(at: number): boolean {
      return at === revision
    },
  }
}
export type ReactionGate = ReturnType<typeof createReactionGate>

export interface GiftReactionDeps {
  /** 道具动效(注入 propEffects.showProp,测试可换假件) */
  showProp: (who: 'A' | 'B', propId: PropId) => void
  /** 感谢语呈现(注入会话层包装:revision 门 + onReply → presentLiveReply) */
  present: (r: LiveReply) => void
  /** 开关:礼物互动(道具动效与感谢语)。观众活动记账在旁路之外,与开关无关 */
  isEnabled: () => boolean
  gate?: ReactionGate
}

/** 两条感谢语之间的最小间隔:道具照放(有 propEffects 自身冷却),嘴上不刷屏 */
const THANKS_GAP_MS = 3_000
const THANK_ACTIONS = ['happy', 'wave', 'laugh']

export function createGiftReactions(deps: GiftReactionDeps) {
  let next: 'A' | 'B' = 'A'
  let lastPresentAt = 0
  const gate = deps.gate ?? createReactionGate()
  return {
    /** 会话层读取:AI 回复路径用它做 revision 校验 */
    gate,
    onGift(e: GiftEvent): void {
      if (!deps.isEnabled()) return
      const who = next
      next = who === 'A' ? 'B' : 'A'
      const propId = giftTierToProp(e.gift.totalCoin, e.gift.coinType)
      deps.showProp(who, propId)
      const now = Date.now()
      if (now - lastPresentAt < THANKS_GAP_MS) return
      lastPresentAt = now
      gate.bump()
      const pool = THANKS[propId] ?? GENERIC_THANKS
      const template = pool[Math.floor(Math.random() * pool.length)]
      const text = template.replaceAll('{name}', cleanName(e.username)).replaceAll('{gift}', e.gift.name)
      deps.present({
        speaker: who,
        text,
        action: THANK_ACTIONS[Math.floor(Math.random() * THANK_ACTIONS.length)],
        username: e.username,
      })
    },
  }
}

export type GiftReactions = ReturnType<typeof createGiftReactions>
