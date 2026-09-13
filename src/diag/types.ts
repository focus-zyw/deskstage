// AI 链路诊断 · 类型层:白名单事件协议。
//
// 设计红线(见 docs/链路诊断与会话回放设计方案.md):
//   · 这里只有"类型化小接口",刻意不提供通用 trace.log(anyObject)——
//     任何模块都不可能把整个请求对象(headers/Cookie/prompt)整包倒进诊断;
//   · 每种事件只允许白名单字段,正文类字段必须经 diag/redact 的 redactText()
//     进入(调用方无权自定脱敏),且只在详情捕获开启时被受理;
//   · 默认档零可读正文:只有长度/语言/盐哈希/句数/耗时/id/决策码/错误分类。
//
// 事件按 sessionId(turnId)归组为一次"交互会话",面板按时间轴回放。

/** 交互来源:诊断面板按此分型 */
export type DiagSource = 'chat' | 'voice' | 'performance' | 'danmaku' | 'interjection'

/** 事件档位:basic = 默认常开(无正文);detail = 仅详情捕获开启时受理 */
export type DiagLevel = 'basic' | 'detail'

/** LLM 调用点标签(同时充当"prompt 模板"标识:每处调用的 prompt 形状固定) */
export type LlmCallKind =
  | 'turnBatch'
  | 'singleReply'
  | 'streamVoice'
  | 'dialog'
  | 'interject'
  | 'liveBatch'
  | 'liveSingle'
  | 'shortChat'
  | 'pokeLine'
  | 'dailyPack'
  | 'facts'
  | 'memo'
  | 'distill'
  | 'cues'
  | 'other'

export type LlmTransport = 'api' | 'webchat'

/** 错误分类:回答"是网络问题、CDP 问题还是模型问题"的第一层归纳 */
export type LlmErrorKind = 'timeout' | 'network' | 'http' | 'parse' | 'empty' | 'cdp' | 'unsupported' | 'unknown'

export type TurnOutcome = 'spoke' | 'silent' | 'failed' | 'cancelled' | 'queued'

export type TtsSegmentOutcome = 'played' | 'demoted' | 'silent' | 'failed' | 'cancelled' | 'stop-noop'

/** 白名单事件(判别联合,kind 收窄)。所有字段都是标量/简单数组,永无嵌套对象——
 *  这是"不接受 secret 字段"在类型层面的落地 */
export type DiagEvent =
  // ---- 生命周期 ----
  {
    kind: 'turn_started'
    ts: number
    level: 'basic'
    source: DiagSource
    inputChars: number
    language: string
    fingerprint: string
    target: string
    groupAsk: boolean
    voice: boolean
  }
  | {
      kind: 'turn_finished'
      ts: number
      level: 'basic'
      outcome: TurnOutcome
      totalMs: number
      replyChars: number
      replySentences: number
    }
  // ---- 模型调用 ----
  | {
      kind: 'llm_started'
      ts: number
      level: 'basic'
      call: LlmCallKind
      transport: LlmTransport
      model?: string
      endpointHost?: string
      /** prompt 总字符与 system/user 分项(长度不是内容) */
      promptChars: number
      systemChars: number
      userChars: number
      contextLines: number
      estTokens: number
      timeoutMs?: number
    }
  | { kind: 'llm_first_token'; ts: number; level: 'basic'; call: LlmCallKind; transport: LlmTransport; ms: number }
  /** 流式首句闭合(分句器吐出第一句):语音"开口延迟"的决定项 */
  | { kind: 'llm_first_sentence'; ts: number; level: 'basic'; call: LlmCallKind; ms: number }
  | {
      kind: 'llm_finished'
      ts: number
      level: 'basic'
      call: LlmCallKind
      transport: LlmTransport
      ok: boolean
      /** true = 被外部取消(AbortError),不算错误 */
      cancelled?: boolean
      elapsedMs: number
      outputChars: number
      sentences?: number
      status?: number
      errorKind?: LlmErrorKind
      /** 服务端错误说明,强制 scrub 后截断 ≤160 字符(可能含模型侧回显,兜底一次) */
      serverMsg?: string
    }
  /** 回退事件:回答"为什么走了网页版回退 / 为什么整段回落单句" */
  | {
      kind: 'fallback'
      ts: number
      level: 'basic'
      call: LlmCallKind
      from: 'webchat' | 'stream' | 'turnBatch' | 'ocr'
      reason: string
    }
  /** CDP 阶段轨迹(Rust webchat_last_trace):拉起/发送/首忙/首文/稳定各阶段耗时 */
  | {
      kind: 'webchat_stages'
      ts: number
      level: 'basic'
      requestId: string
      stages: { stage: string; ms: number }[]
      totalMs: number
      error?: string
    }
  // ---- TTS ----
  | {
      kind: 'tts_request'
      ts: number
      level: 'basic'
      seg: number
      speaker: string
      chars: number
      channel: string
      epoch: number
      action?: string
    }
  | {
      kind: 'tts_segment'
      ts: number
      level: 'basic'
      seg: number
      epoch: number
      outcome: TtsSegmentOutcome
      /** 合成首包耗时 / 首帧出声绝对时刻 / 出声→结束时长 / 是否缓存命中 */
      synthMs?: number
      audibleAt?: number
      playbackMs?: number
      cacheHit?: boolean
      reason?: string
    }
  | {
      kind: 'tts_stopped'
      ts: number
      level: 'basic'
      trigger: 'cancel' | 'global'
      hadActiveSession: boolean
      activeChannel?: string
      epochBefore: number
      epochAfter: number
    }
  // ---- 会话控制 / 动作 ----
  | {
      kind: 'cancel_requested'
      ts: number
      level: 'basic'
      generation: number
      hadHandle: boolean
      hadAbort: boolean
    }
  | { kind: 'action_fired'; ts: number; level: 'basic'; speaker: string; action: string; seg?: number }
  /** 角色工具协调(用户回合先过工具系统):clarify = 工具直接反问,回合不烧生成 */
  | {
      kind: 'tools_prepare'
      ts: number
      level: 'basic'
      ms: number
      clarified: boolean
      hasNote: boolean
      memoryRefs: number
    }
  // ---- 记忆(默认档只有 id 与决策,无正文;查看时按 id 实时解析现状) ----
  | {
      kind: 'memory_selection'
      ts: number
      level: 'basic'
      ms: number
      selected: { id: string; score: number; source: string }[]
      /** 未注入候选与原因枚举(检索器给出的 outcome) */
      candidates: { id: string; score: number; outcome: string }[]
    }
  | {
      kind: 'memory_write'
      ts: number
      level: 'basic'
      candidates: number
      changed: number
      addedIds: string[]
      supersededIds: string[]
      rejected: number
      ms: number
      error?: string
    }
  // ---- 语音识别 ----
  | { kind: 'asr_result'; ts: number; level: 'basic'; ms: number; chars: number; audioMs?: number; errorKind?: string }
  // ---- 详情正文(仅详情捕获开启时受理;进店前强制 redactText/scrub) ----
  | {
      kind: 'detail_text'
      ts: number
      level: 'detail'
      textKind: 'input' | 'reply' | 'asr'
      seg?: number
      /** 已脱敏文本(或显式含原文档强制 scrub 过的原文) */
      text: string
      rawChars: number
    }

/** 单次交互的完整诊断记录(内存环成员,不落盘) */
export interface DiagSession {
  id: string
  ts: number
  source: DiagSource
  ended: boolean
  /** 详情档捕获的会话(面板标注,保留策略更紧) */
  hasDetail: boolean
  events: DiagEvent[]
  summary: DiagSummary
}

/** 派生结论:面板顶部直接回答五连问的归纳层(纯函数可测,见 store.deriveSummary) */
export interface DiagSummary {
  outcome: TurnOutcome | 'open'
  /** 未出声的具体原因(outcome=silent/failed 时有值) */
  noSpeechReason?: string
  /** 回退链:按发生顺序(网页→API、流式→整段、批→单句) */
  fallbacks: { from: string; reason: string; ts: number }[]
  /** 取消后仍有出声迹象(cancel 后同一会话出现 audible 晚于取消时刻的 played 段) */
  cancelLeak: boolean
  /** 首个错误分类(网络/超时/HTTP/CDP/解析) */
  errorKind?: LlmErrorKind
  errorText?: string
  /** 首 token / 首句闭合延迟(主导"为什么这么慢") */
  firstTokenMs?: number
  firstSentenceMs?: number
  /** 记忆:注入条数与写入条数 */
  memoryInjected: number
  memoryWritten: number
  /** TTS 分段数与出声段数 */
  ttsSegments: number
  ttsSpoken: number
  totalMs?: number
}

/** TTS 埋点引用:调用方把会话 id 传给引擎,引擎事件才能归组(可选,不传不记) */
export interface DiagRef {
  turnId: string
  segIndex?: number
  action?: string
}
