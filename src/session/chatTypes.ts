// 聊天会话共享契约:宿主回调与引擎依赖接口(旧单飞引擎与新群聊运行时共用)。
// 本文件只放纯类型与纯函数——两代实现都从这里取形状,保证 send() 调用方零感知切换。
import type { DialogLine, Speaker } from '../performer/player'
import type { SpeechHandle } from '../engine/tts'
import type { ChatMemoryRef } from '../storage/chatLogStore'
import type { TurnMemoryContext } from '../storage/memoryStore'
import type { DiagRef } from '../diag/store'
import type { ChatContextLines } from '../engine/llmClient'

export type { ChatContextLines }

/** 发送选项:语音路径的气泡随首帧上屏与句级节奏;ASR 结果摘要进诊断 */
export interface SendOptions {
  /** 语音对话路径:首帧声音上屏 + 句级提交 + ended 驱动推进 */
  voice?: boolean
  /** 语音路径的 ASR 结果摘要(结构,无正文):受理时并入本回合诊断会话 */
  diagAsr?: { ms: number; chars: number; audioMs?: number; errorKind?: string }
}

/** 单句台词的上屏停留时长(呈现 ms 与逐句节奏同源) */
export function chatLineHoldMs(text: string): number {
  return 2200 + text.length * 160
}

/** 明确同时问三人才放开 TurnBatch(旧链路判定;新链路仅作 primary 提示参考) */
export const GROUP_ASK_RE = /你们|大家|各位|三位|每人|各自|都怎么|都说说/

/** 稳定轮 id:受理即定,贯穿 chatLog/提取/参考记忆(时间戳不是 ID,同毫秒会撞) */
export function newTurnId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  } catch {
    // 旧 webview 无 randomUUID:退化为时间戳+随机串
  }
  return `t${Date.now()}${Math.random().toString(36).slice(2, 10)}`
}

/** 宿主注入的呈现侧回调(两代实现共用;天然属于宿主,必须注入) */
export interface ChatHostDeps {
  /** 当前角色名(设置可改名;每次 send 时取最新) */
  names(): { A: string; B: string; C: string }
  /** 演出中?聊天改走插话队列,句尾安全缝反应后接回剧情 */
  isPerforming(): boolean
  queueInterjection(text: string, who: Speaker): void
  /** 呈现一句角色台词(上屏+动画;TTS 由 tts 通知,失败不影响本回调)。
   *  memoryRefs 是"原子的呈现事件"载荷:本轮实际注入的记忆引用,首句携带(徽标),
   *  N=0 不带;演出/直播路径不传即不显示 */
  presentTurn(line: {
    speaker: Speaker
    text: string
    holdMs: number
    memoryRefs?: ChatMemoryRef[]
  }): void
  /** 用户这句话上屏;who 非空 = 空闲路径(顺带聚焦该角色),null = 演出插话路径 */
  presentUser(text: string, who: Speaker | null): void
  /** 收走用户气泡;文本不符(已被顶掉)时保持不动 */
  clearUser(text: string): void
  /** 应答失败的兜底台词 */
  presentFallback(line: { speaker: Speaker; text: string }): void
  /** 用户活跃信号(主动行为调度) */
  onUserActive(): void
  /** 语音路径:一句开始出声(或无声兜底开屏)。语音会话据此把 phase 推进到「正在说」 */
  onTurnSpeechStart?(): void
}

/** 引擎/存储侧可覆盖的默认实现(旧单飞链路用;群聊运行时经 Adapter 走自己的模型通道) */
export interface ChatEngineDeps {
  turnBatch(input: {
    userText: string
    target: Speaker
    groupAsk: boolean
    /** 取消信号:贯穿到网关,打断 = 真断请求 */
    signal?: AbortSignal
    /** 工具观察块(工具系统渲染好的不可信资料;原样附加到用户消息后) */
    toolNote?: string
    /** 回合记忆上下文(显式传入;实现不得再自读 memoryStore——"注入即所见") */
    memory?: TurnMemoryContext
    /** 上下文生命周期注入行(Warm 摘要/Mem0 经历;开关关闭时缺省) */
    contextLines?: ChatContextLines
    /** 诊断会话 id(可选):传入后本次生成的请求进诊断环 */
    diagTurnId?: string
  }): Promise<DialogLine[]>
  singleReply(
    target: Speaker,
    userText: string,
    signal?: AbortSignal,
    toolNote?: string,
    memory?: TurnMemoryContext,
    diagTurnId?: string,
    contextLines?: ChatContextLines,
  ): Promise<string>
  /** 角色工具协调(可选):用户回合先过工具系统——本句话要不要截图/识字/查记忆。
   *  返回的 note 由协调器渲染好(截断+不可信包裹),这里只透传给生成函数;
   *  clarify 直接作为本回合回复。协调失败回落普通聊天,永不阻塞消息收发 */
  tools?(input: { userText: string }, signal: AbortSignal): Promise<{
    userText: string
    note?: string
    clarify?: string
    /** search_memory 命中的记忆引用(并入回合总注入集合) */
    memoryRefs?: ChatMemoryRef[]
  }>
  recordTurn(
    who: TurnWhoAlias,
    text: string,
    meta?: {
      entryId?: string
      parentTurnId?: string
      ts?: number
      memoryRefs?: ChatMemoryRef[]
      trace?: unknown
    },
  ): void
  /** 记忆摄取器(可选;缺省用生产单例):用户轮 → 长期事实的唯一入口,
   *  内含 pending 账本/证据校验/冲突裁决,失败记 failed 不影响聊天 */
  memoryIngestor?: {
    ingestUserTurn(input: { turnId: string | null; text: string }): Promise<MemoryIngestReportAlias>
  }
  tts: {
    /** diag:诊断会话引用(可选),传入后 TTS 引擎按段发诊断事件 */
    speak(who: Speaker, text: string, diag?: DiagRef): void
    /** 语音路径:生命周期句柄;null = 被更高优先级压制。返回句柄由会话持有,
     *  cancel() 时句柄级停声(不全局 stopSpeaking,不碰提醒/工具播报) */
    speakTracked?(who: Speaker, text: string, diag?: DiagRef): SpeechHandle | null
    /** 预合成(不播):语音路径在播第 i 句时预合成第 i+1,句间零等待 */
    prefetch?(who: Speaker, text: string): void
  }
  /** 语音流式应答(可选):逐句 yield,调用方边流边说。缺省 = 无流式,退回整段 */
  streamTurn?(input: {
    userText: string
    target: Speaker
    signal?: AbortSignal
    toolNote?: string
    memory?: TurnMemoryContext
    /** 句子入队回调(入队时机 = 消费方还在播上一句,正好预合成) */
    onQueued?(line: DialogLine): void
    /** 诊断会话 id(可选) */
    diagTurnId?: string
  }): AsyncGenerator<DialogLine>
  /** 回合记忆检索(缺省 = memoryStore.prepareTurnMemory;测试注入固定上下文) */
  prepareMemory?(input: { query: string; n?: number }): Promise<TurnMemoryContext>
  /** debug 显示档才把检索 trace 落聊天日志(缺省读配置 memoryDisplay) */
  includeTrace?(): Promise<boolean>
  clock: { setTimeout(fn: () => void, ms: number): () => void }
}

// 局部别名(避免本类型文件直接依赖 turnWindow/memoryStore/ingestor 的运行时导出)
type TurnWhoAlias = 'user' | Speaker
type MemoryIngestReportAlias = import('../memory/ingestor').MemoryIngestReport
