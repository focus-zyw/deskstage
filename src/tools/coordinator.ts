// 工具协调器:角色工具系统对上层的唯一入口(深模块)。
//
// prepareTurn(聊天回合用):门槛过滤 → (按需)Planner 决策 → 策略闸 → 确认 →
//   执行(超时/取消)→ 落账 → 观察。上层只认识 {userText, observations, clarify},
//   完全不知道供应商、风险分级或某个工具怎么截屏。
// runTool(UI 命令入口):同一条执行管线,跳过门槛与 Planner(人点的不用问模型)。
//
// 铁律(都收在这一个文件里执行,不散落调用方):
// · 模型只建议,不决定安全——策略只读本地设置;
// · 每回合最多一个工具,只服务用户发起的回合;
// · 任何失败都落账并尽量给出人话摘要,静默只属于"不用工具"。

import { routeTurn } from './candidateGate'
import { decidePolicy, toolEnabled } from './policy'
import { renderObservationBlock, truncateForObservation } from './observation'
import { recordToolLog } from './toolLog'
import type {
  CharacterTool,
  ToolCoordinator,
  ToolCoordinatorDeps,
  ToolDecision,
  ToolLogEntry,
  ToolResult,
  TurnPreparation,
} from './types'

const PLANNER_TIMEOUT_MS = 120_000 // 网页通道 90s + 余量;超时按"不用工具"处理

type Outcome = ToolLogEntry['outcome']

interface GatedObservation {
  toolId: string
  ok: boolean
  summary: string
  errorCode?: string
  /** search_memory 命中的记忆引用(gatedRun 里按条件展开写入,声明在此供消费方读取) */
  memoryRefs?: TurnPreparation['memoryRefs']
}

/** 确认卡的输入摘要:"text:晚上好呀"(清洗后的参数,超长截断) */
function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const rows = Object.entries(input as Record<string, unknown>).map(
    ([k, v]) => `${k}:${String(v).slice(0, 60)}`,
  )
  return rows.length > 0 ? `输入:${rows.join(';')}` : ''
}

export function createToolCoordinator(deps: ToolCoordinatorDeps): ToolCoordinator {
  const clock = deps.clock ?? {
    setTimeout: (fn, ms) => {
      const id = window.setTimeout(fn, ms)
      return () => window.clearTimeout(id)
    },
  }
  const log = deps.log ?? recordToolLog
  const registry = deps.registry as Record<string, CharacterTool>
  const toolOf = (id: string): CharacterTool | undefined => registry[id]

  /** 超时 + 外部取消的执行壳:信号一定置位;慢适配器由 race 兜底返回 */
  async function runWithGuards(
    tool: CharacterTool,
    input: unknown,
    ctxSignal: AbortSignal | undefined,
    facts: { phase: string },
  ): Promise<ToolResult> {
    const ctrl = new AbortController()
    let fireTimeout: () => void = () => {}
    const timeoutPromise = new Promise<never>((_, reject) => {
      fireTimeout = () => {
        // 先落 TimeoutError(race 以它结算),再 abort 让适配器收到停止信号
        reject(new DOMException('工具超时', 'TimeoutError'))
        ctrl.abort(new DOMException('工具超时', 'TimeoutError'))
      }
    })
    const cancelTimer = clock.setTimeout(fireTimeout, tool.manifest.timeoutMs)
    const onExternal = () => ctrl.abort(new DOMException('已取消', 'AbortError'))
    ctxSignal?.addEventListener('abort', onExternal, { once: true })
    const work = tool.execute(input, {
      signal: ctrl.signal,
      confirm: (req) => deps.host.confirm(req),
      report: (detail) => deps.host.onToolProgress?.(tool.manifest, detail),
      facts,
    })
    void work.catch(() => {}) // race 输家迟到的拒绝不许变成 unhandled
    try {
      return await Promise.race([work, timeoutPromise])
    } finally {
      cancelTimer()
      ctxSignal?.removeEventListener('abort', onExternal)
    }
  }

  /** 策略闸 + 可用性 + 确认 + 执行 + 落账,产出统一的观察 */
  /** 从工具结果提取记忆引用(search_memory 的 data.memoryRefs;只收 id/来源) */
  function memoryRefsOf(result: ToolResult): TurnPreparation['memoryRefs'] {
    const refs = (result.data as { memoryRefs?: unknown } | undefined)?.memoryRefs
    if (!Array.isArray(refs)) return undefined
    const out = refs
      .map((r) => {
        const o = (r ?? {}) as Record<string, unknown>
        if (typeof o.id !== 'string' || !o.id) return null
        return {
          id: o.id.slice(0, 64),
          source: o.source === 'search-tool' ? ('search-tool' as const) : ('passive' as const),
        }
      })
      .filter((r): r is { id: string; source: 'passive' | 'search-tool' } => r !== null)
    return out.length > 0 ? out.slice(0, 20) : undefined
  }

  async function gatedRun(
    tool: CharacterTool,
    input: unknown,
    source: 'user' | 'planner',
    signal: AbortSignal | undefined,
    facts: { phase: string },
  ): Promise<{ result: ToolResult; observation: GatedObservation }> {
    const verdict = decidePolicy(await deps.settings(), tool.manifest)
    const started = Date.now()
    const finish = (result: ToolResult, outcome: Outcome) => {
      log({
        toolId: tool.manifest.id,
        source,
        outcome,
        durationMs: Date.now() - started,
        detail: truncateForObservation(result.summary, 120),
        ts: started,
      })
      deps.host.onToolEnd?.(tool.manifest, result)
      return {
        result,
        observation: {
          toolId: tool.manifest.id,
          ok: result.ok,
          summary: truncateForObservation(result.summary),
          errorCode: result.errorCode,
          ...(memoryRefsOf(result) ? { memoryRefs: memoryRefsOf(result) } : {}),
        },
      }
    }
    if (verdict === 'denied') {
      return finish({ ok: false, summary: '该工具未启用,已跳过', errorCode: 'disabled' }, 'denied')
    }
    const probe: Parameters<CharacterTool['available']>[0] = {
      signal: signal ?? new AbortController().signal,
      confirm: (req) => deps.host.confirm(req),
      facts,
    }
    if (!(await Promise.resolve(tool.available(probe)))) {
      return finish({ ok: false, summary: '当前条件不满足,工具不可用', errorCode: 'unavailable' }, 'unavailable')
    }
    if (verdict === 'need-confirm') {
      deps.host.presentPending(tool.manifest)
      const allowed = await deps.host.confirm({
        toolId: tool.manifest.id,
        title: `要执行「${tool.manifest.label}」吗?`,
        detail: [tool.manifest.description, summarizeInput(input)].filter(Boolean).join('\n'),
        rememberable: tool.manifest.risk === 'external',
      })
      if (!allowed) {
        return finish({ ok: false, summary: '用户没有允许这次操作', errorCode: 'refused' }, 'refused')
      }
    } else {
      deps.host.presentPending(tool.manifest)
    }
    deps.host.onToolStart?.(tool.manifest)
    try {
      const result = await runWithGuards(tool, input, signal, facts)
      return finish(result, result.ok ? 'ok' : 'error')
    } catch (e) {
      const timedOut = (e as Error)?.name === 'TimeoutError'
      return finish(
        {
          ok: false,
          summary: timedOut
            ? '执行超时,已中止'
            : (e as Error)?.name === 'AbortError'
              ? '已取消'
              : `执行失败:${String((e as Error)?.message ?? e).slice(0, 80)}`,
          errorCode: timedOut ? 'timeout' : (e as Error)?.name === 'AbortError' ? 'cancelled' : 'error',
        },
        timedOut ? 'timeout' : 'error',
      )
    }
  }

  return {
    async prepareTurn(input, signal): Promise<TurnPreparation> {
      const userText = input.userText
      try {
        const settings = await deps.settings()
        const facts = await deps.facts()
        // 门槛过滤只看"开着"的工具:关掉的开关连候选都进不了
        const enabled = Object.values(deps.registry)
          .filter((t) => toolEnabled(settings, t.manifest))
          .map((t) => t.manifest)
        const route = routeTurn(userText, enabled, facts)
        if (route.kind === 'none') return { userText, observations: [] }
        let decision: ToolDecision
        if (route.kind === 'direct') {
          decision = { kind: 'call', tool: route.tool, arguments: {} }
        } else {
          try {
            decision = await withTimeout(
              deps.planner.decide(
                { userText, candidates: route.candidates, context: facts },
                signal ?? new AbortController().signal,
              ),
              PLANNER_TIMEOUT_MS,
            )
          } catch (e) {
            if (signal?.aborted) throw e
            logPlannerError(e)
            return { userText, observations: [] } // 决策失败 = 普通聊天,不重试不猜测
          }
        }
        if (decision.kind === 'none') return { userText, observations: [] }
        if (decision.kind === 'clarify') return { userText, observations: [], clarify: decision.question }

        const tool = toolOf(decision.tool)
        if (!tool) return { userText, observations: [] } // parse 已白名单校验,这里双保险
        const v = tool.validate(decision.arguments)
        if (!v.ok) {
          log({ toolId: tool.manifest.id, source: 'planner', outcome: 'invalid', durationMs: 0, detail: v.reason.slice(0, 120), ts: Date.now() })
          const obs: TurnPreparation['observations'] = [{ toolId: tool.manifest.id, ok: false, summary: '工具调用参数不合法,没有执行' }]
          return { userText, observations: obs, note: renderObservationBlock(obs) }
        }
        const { observation } = await gatedRun(tool, v.value, 'planner', signal, facts)
        const observations = [observation]
        return {
          userText,
          observations,
          note: renderObservationBlock(observations),
          memoryRefs: observations.flatMap((o) => o.memoryRefs ?? []),
        }
      } catch (e) {
        if (signal?.aborted) throw e
        // 协调器自身异常不阻塞聊天(工具系统的失败不许变成聊天的失败)
        logPlannerError(e)
        return { userText, observations: [] }
      }
    },

    async runTool(id, input, opts): Promise<ToolResult> {
      const tool = toolOf(id)
      if (!tool) return { ok: false, summary: `未知工具:${id}`, errorCode: 'unknown-tool' }
      const facts = await deps.facts()
      const v = tool.validate(input)
      if (!v.ok) {
        log({ toolId: id, source: opts?.source ?? 'user', outcome: 'invalid', durationMs: 0, detail: v.reason.slice(0, 120), ts: Date.now() })
        return { ok: false, summary: v.reason, errorCode: 'invalid' }
      }
      const { result } = await gatedRun(tool, v.value, opts?.source ?? 'user', opts?.signal, facts)
      return result
    },
  }

  function logPlannerError(e: unknown): void {
    log({
      toolId: '-',
      source: 'planner',
      outcome: 'planner-error',
      durationMs: 0,
      detail: String((e as Error)?.message ?? e).slice(0, 80),
      ts: Date.now(),
    })
  }

  async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let fire: () => void = () => {}
    const timeout = new Promise<never>((_, reject) => {
      fire = () => reject(new DOMException('决策超时', 'TimeoutError'))
    })
    const cancel = clock.setTimeout(fire, ms)
    void p.catch(() => {})
    try {
      return await Promise.race([p, timeout])
    } finally {
      cancel()
    }
  }
}
