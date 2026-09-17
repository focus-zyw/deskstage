// 角色工具系统 · 协议与接口的唯一事实源。
//
// 设计裁决(为什么不走 function calling、不进剧本协议):
// · 决策协议是供应商无关的普通 JSON——API 模型与网页模型(webchat CDP)都能输出,
//   function calling 日后只作为 ToolPlanner 的内部 Adapter,不上升为全项目协议;
// · 工具调用永不进入 {card, dialog, choice} 剧本——剧本会落盘/重放/收藏,
//   截屏这类真实世界副作用重放一次就是一次事故;舞台动作(action)可以重放,
//   工具调用不行,两者在类型上就分开。
//
// 模型只负责"建议调用什么",永远不决定"是否安全":决策协议没有 reasoning/权限
// 字段,风险分级与开关只来自本地配置(见 policy.ts),模型输出无法给自己降权。

/** 风险分级:read 自动执行;local-write 视工具确认;external 必须确认 */
export type ToolRisk = 'read' | 'local-write' | 'external'

/** 模型决策协议:三选一,只允许调用一个工具(一期) */
export type ToolDecision =
  | { kind: 'none' }
  | { kind: 'call'; tool: string; arguments: Record<string, unknown> }
  | { kind: 'clarify'; question: string }

/** 工具输入的最小 schema:既驱动 validate 清洗,也渲染进决策 prompt(见 schema.ts) */
export type { ToolInputSchema } from './schema'

/** 一次工具执行的产出。summary 是唯一回流契约:浮层卡展示它,观察块引用它 */
export interface ToolResult {
  ok: boolean
  /** 一句话人话摘要(适配器保证不带密钥/完整 URL/超长原文) */
  summary: string
  /** 结构化数据(可选;供调用方深用,不进观察块) */
  data?: unknown
  errorCode?: string
}

/** 门槛过滤的舞台事实快照(纯数据,每回合算一次) */
export interface ToolPlanningContext {
  /** 演出阶段:'idle' | 'performing' | 'generating'…(与 App phase 同源) */
  phase: string
}

/** 工具自述(注册时的静态事实;运行时行为在 CharacterTool 上) */
export interface ToolManifest {
  id: string
  /** 短标签(任务卡/确认卡用,如"截屏""识字") */
  label: string
  /** 给模型与确认卡看的一句话能力描述(命令式,不含主语) */
  description: string
  risk: ToolRisk
  /** 输入约束:validate 清洗依据 + 决策 prompt 的参数提示 */
  inputSchema: import('./schema').ToolInputSchema
  /** 执行超时 ms;到点 abort 信号置位并按失败落账 */
  timeoutMs: number
  /** 设置无该工具开关时的缺省方向(read 默认开,external 默认关) */
  defaultEnabled: boolean
  /** 确定性候选打分 0~1:门槛过滤用它把普通对话挡在 Planner 之外 */
  match(text: string, ctx: ToolPlanningContext): number
  /** 呈现提示(仅 UI):执行期间谁说什么、做什么动作。不参与权限与执行决策 */
  presentation?: { actor: 'A' | 'B' | 'C'; pendingText: string; action: string }
}

/** 工具执行期上下文:协调器注入,适配器不自己找 */
export interface ToolContext {
  /** 超时/用户取消都会置位;适配器长循环必须响应 */
  signal: AbortSignal
  /** 执行中再确认(如视频生成扣费);拒绝 = 抛 AbortError 或返回失败,由适配器定 */
  confirm(req: { toolId: string; title: string; detail: string }): Promise<boolean>
  /** 进度上报:浮层卡 detail 更新(可能未接,调用前判空) */
  report?(detail: string): void
  /** 舞台事实快照(available 判定用) */
  facts: ToolPlanningContext
}

/** 一个角色工具:manifest 是静态自述,available/validate/execute 是运行时行为。
 *  Registry 是安全事实源:模型报上来的工具名与参数都要过这里的 validate 清洗 */
export interface CharacterTool {
  manifest: ToolManifest
  /** 当前可否执行(未配 Key 等运行时前提;开关在 policy 层,不在这判) */
  available(ctx: ToolContext): Promise<boolean> | boolean
  /** 白名单式清洗:未知键丢弃、类型校验、超长截断;不合法返回原因(不猜意图) */
  validate(input: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string }
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>
}

/** 一条脱敏后的工具观察:注入 prompt 的唯一形态(见 observation.ts) */
export interface ToolObservation {
  toolId: string
  ok: boolean
  /** 已截断的摘要(截断发生在进这里之前,见 truncateForObservation) */
  summary: string
  errorCode?: string
  /** 检索类工具命中的记忆引用(search_memory;只含 id,不含正文) */
  memoryRefs?: { id: string; source: 'passive' | 'search-tool' }[]
}

/** 一回合的工具准备结果:上层(ChatSession)拿它决定怎么继续生成 */
export interface TurnPreparation {
  userText: string
  /** 空 = 没有工具介入,上层按普通聊天走 */
  observations: ToolObservation[]
  /** 意图含糊时模型反问的一句话;上层直接把它当这回合的回复呈现 */
  clarify?: string
  /** 观察块的渲染成品(renderObservationBlock 的输出):上层原样注入 prompt,
   *  不需要知道防注入纪律的细节。observations 为空时为 undefined */
  /** search_memory 命中的记忆引用(并入回合总注入集合;只含 id) */
  memoryRefs?: { id: string; source: 'passive' | 'search-tool' }[]
  note?: string
}

/** 设置侧的工具偏好(configStore 清洗后只含布尔值) */
export interface ToolSettings {
  /** 按工具开关;缺省键 = manifest.defaultEnabled */
  switches?: Record<string, boolean>
  /** external 工具的"记住允许";模型输出无法写入这里 */
  autoApproved?: Record<string, boolean>
}

export type PolicyVerdict = 'allow-auto' | 'need-confirm' | 'denied'

/** 调用日志一条(内存环,不落盘):summary 已截断,永不含密钥/完整 URL */
export interface ToolLogEntry {
  toolId: string
  source: 'user' | 'planner'
  outcome: 'ok' | 'error' | 'denied' | 'refused' | 'unavailable' | 'invalid' | 'timeout' | 'planner-error'
  durationMs: number
  detail: string
  ts: number
}

/** 工具时钟(CharInteractions 同款确定性注入口):setTimeout 返回取消函数 */
export interface ToolClock {
  setTimeout(fn: () => void, ms: number): () => void
}

/** 对协调器宿主(App)的最小呈现面:确认与进度都经这里,App 适配成气泡/浮层卡 */
export interface ToolHostBridge {
  confirm(req: {
    toolId: string
    title: string
    detail: string
    /** external 工具为真:确认卡可提供"允许并不再问"(写入设置 autoApproved) */
    rememberable?: boolean
  }): Promise<boolean>
  /** pendingText 呈现(manifest.presentation 存在时,执行前调一次) */
  presentPending(manifest: ToolManifest): void
  /** 任务卡生命周期与进度(App 侧映射 runUtilityTask;可不接) */
  onToolStart?(manifest: ToolManifest): void
  onToolProgress?(manifest: ToolManifest, detail: string): void
  onToolEnd?(manifest: ToolManifest, result: ToolResult): void
}

/** 协调器依赖(全部可注入,测试用内存假件) */
export interface ToolCoordinatorDeps {
  registry: Record<string, CharacterTool>
  planner: {
    decide(
      input: { userText: string; candidates: ToolManifest[]; context: ToolPlanningContext },
      signal: AbortSignal,
    ): Promise<ToolDecision>
  }
  settings(): Promise<ToolSettings>
  /** 舞台事实快照(每回合取一次;App 从 phase/mode 的 ref 组装) */
  facts(): Promise<ToolPlanningContext>
  host: ToolHostBridge
  /** 缺省真实时钟;测试注入虚拟时钟 */
  clock?: ToolClock
  /** 缺省 recordToolLog;测试注入收集器 */
  log?(entry: ToolLogEntry): void
}

/** 对上层的唯一接口:prepareTurn 给聊天回合,runTool 给 UI 命令入口 */
export interface ToolCoordinator {
  prepareTurn(input: { userText: string }, signal?: AbortSignal): Promise<TurnPreparation>
  runTool(id: string, input: unknown, opts?: { source?: 'user' | 'planner'; signal?: AbortSignal }): Promise<ToolResult>
}
