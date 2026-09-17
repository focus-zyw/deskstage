// JSON 提示词规划器:工具决策的供应商无关实现。
// 极短、严格的决策 prompt——候选只有传入的几个(候选门槛已过滤),
// 输出协议三选一;API 走 llmGateway(jsonMode),网页模型走 webchatAsk,
// 两条通道产出同一 ToolDecision。function calling 日后作为并列 Adapter,
// 归一成同一协议即可,不改变上层任何形状。

import { complete } from '../../engine/llmGateway'
import { describeSchema } from '../schema'
import type { ToolDecision, ToolManifest, ToolPlanningContext } from '../types'
import { parseToolDecision } from './decisionParse'

/** API 通道默认 20s:决策是短输出,卡死就当"不用工具",别拖慢聊天 */
const API_TIMEOUT_MS = 20_000
/** 网页通道一轮几十秒,给宽到 90s;错了不重试(设计裁决:CDP 贵,错了回落聊天) */
const WEBCHAT_TIMEOUT_MS = 90_000
const DECISION_TEMPERATURE = 0

export function buildDecisionPrompt(candidates: ToolManifest[], userText: string): string {
  const lines = candidates.map((c, i) => `${i + 1}. ${c.id}:${c.description}(参数:${describeSchema(c.inputSchema)})`)
  return [
    '根据用户消息,从候选工具中选择零个或一个。只能输出一个 JSON 对象,不要输出任何其他文字。',
    '候选工具:',
    ...lines,
    '输出只能是以下三种之一:',
    '{"kind":"none"}',
    '{"kind":"call","tool":"工具id","arguments":{...}}',
    '{"kind":"clarify","question":"一句反问"}',
    '纪律:工具 id 必须逐字取自候选;意图含糊或参数缺失时用 clarify 反问;不需要工具时用 none。',
    `用户消息:${userText}`,
  ]
    .filter(Boolean)
    .join('\n')
}

export interface ToolPlannerDeps {
  askApi(prompt: string, signal: AbortSignal): Promise<string>
  /** 网页通道可缺省(未启用 webchat 时不传) */
  askWebchat?(prompt: string, signal: AbortSignal): Promise<string>
  /** true = 网页优先(与主生成通道同源);网页失败回落 API */
  preferWebchat(): boolean
}

export interface ToolPlanner {
  decide(input: {
    userText: string
    candidates: ToolManifest[]
    context: ToolPlanningContext
  }, signal: AbortSignal): Promise<ToolDecision>
}

export function createJsonPromptPlanner(deps: ToolPlannerDeps): ToolPlanner {
  async function ask(prompt: string, signal: AbortSignal): Promise<string> {
    if (deps.preferWebchat() && deps.askWebchat) {
      try {
        return await deps.askWebchat(prompt, signal)
      } catch (e) {
        if (signal.aborted) throw e
        // 网页通道失败(未登录/超时/解析):一次 API 短调用兜底,不再碰 CDP
      }
    }
    return deps.askApi(prompt, signal)
  }

  return {
    async decide({ userText, candidates }, signal): Promise<ToolDecision> {
      const prompt = buildDecisionPrompt(candidates, userText)
      const raw = await ask(prompt, signal)
      const ids = new Set(candidates.map((c) => c.id))
      const decision = parseToolDecision(raw, ids)
      // 解析失败按协议拒绝处理:调用方回落普通聊天(不重试,不猜测)
      return decision ?? { kind: 'none' }
    },
  }
}

/** 桌面端缺省接线:API 走配置端点代理,网页走 webchatAsk */
export function defaultPlannerDeps(preferWebchat: () => boolean): ToolPlannerDeps {
  return {
    askApi: (prompt, signal) =>
      complete({
        messages: [{ role: 'user', content: prompt }],
        jsonMode: true,
        temperature: DECISION_TEMPERATURE,
        maxTokens: 200,
        timeoutMs: API_TIMEOUT_MS,
        signal,
      }),
    askWebchat: (prompt, signal) => {
      // 动态 import:未启用 webchat 的用户不为此加载 CDP 封装(按需加载纪律)
      return import('../../engine/webchat').then((m) => m.webchatAsk(prompt, signal, WEBCHAT_TIMEOUT_MS))
    },
    preferWebchat,
  }
}
