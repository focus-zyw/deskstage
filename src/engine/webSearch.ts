// 聊天联网搜索(docs/联网搜索设计方案.md):纯逻辑,无 IO。
// 服务端 web_search 由模型自主决定何时检索,这里收口三件纯事:
// · 端点传输判定——请求侧(工具注入形态)与提示词侧(规则行门控)共用同一谓词,
//   杜绝"提示说能搜、请求没带工具"的漂移;
// · DeepSeek Responses 响应提取(instructions/input 形态的文本还原);
// · 联网使用规则行(教角色"先核实再答、查不到就说不确定、不暴露工具细节")。
// v1 仅预设智谱/DeepSeek 端点;自定义档案与中转端点一律不注入(静默关闭)。

/** 联网搜索的请求传输形态 */
export type WebSearchTransport = 'zhipu-tools' | 'deepseek-responses'

/** 按端点 host 判定联网传输形态;不支持返回 null(工具不注入,行为同关闭)。
 *  DeepSeek 暂不支持:官方文档把 web_search 列入「忽略的内置工具」,更新日志从未提及;
 *  2026-09-18 真机探测(deepseek-v4-flash,/responses 带工具 + tool_choice 强制)
 *  web_search_call 恒为 0,模型自述无法联网——responsesWithDegrade 及测试保留,
 *  待 DeepSeek 真实上线服务端检索后把判定加回即可 */
export function webSearchTransportOf(baseUrl: string | undefined): WebSearchTransport | null {
  let host = ''
  try {
    host = new URL(String(baseUrl ?? '')).host
  } catch {
    return null
  }
  if (/(^|\.)bigmodel\.cn$/i.test(host)) return 'zhipu-tools'
  return null
}

/** 配置 → 聊天是否带联网工具(总开关 + 主端点支持;档案适配由调用方另判) */
export function webSearchOnOf(cfg: { webSearch?: boolean; baseUrl?: string }): boolean {
  return cfg.webSearch === true && webSearchTransportOf(cfg.baseUrl) !== null
}

/** 联网使用规则行(actorPrompt 注入 system;两种形态都带,同协议块常驻语义) */
export const WEB_SEARCH_LINE =
  '联网搜索已开启(系统在需要时自动检索):遇到时效性问题(今天/最新/现在)、' +
  '不了解或超出角色世界观的事实类问题,先核实再以角色口吻自然回答;' +
  '查不到就坦率说不确定,绝不编造具体数据;' +
  '不要提及"搜索/联网"等工具细节,不要罗列来源链接。'

/** 联网通道 404(端点无 Responses 路由)降级普通聊天时追加的诚实提示:
 *  规则行承诺过「能搜」,降级轮必须明说搜不了,防模型假装检索然后编造 */
export const WEB_UNAVAILABLE_LINE =
  '(系统提示:本轮联网搜索通道异常,本轮没有检索能力——请直接基于已有知识回答;' +
  '不要假装正在搜索,不要编造具体数据,无法核实的就说暂时查不了)'

/** 参数/路由类拒绝:400(参数或模型不被该路由接受)/404(路由不存在)/422(校验拒绝)。
 *  这类错误 = 「Responses 通道不可用」而非真故障(鉴权/配额/网络),应降级而非失败 */
export function isParamReject(e: unknown): boolean {
  const s = (e as { status?: number }).status
  return s === 400 || s === 404 || s === 422
}

interface SenderResponse {
  status: number
  text(): Promise<string> | string
}

/** Responses 通道三级尝试(可测:IO 全部注入)——
 *  ① 带工具请求;② 参数类拒绝 → 同路由去工具重试;③ 仍参数类拒绝(路由不存在,
 *  或该路由不认此模型/参数,状态码因厂商而异:400/404/422)→ 降级普通 chat/completions
 *  并追加诚实提示。非参数类错误(401 鉴权/429 配额/5xx/网络)原样抛出——降级调用
 *  一样会失败,不该把真故障伪装成"没联网"。 */
export async function responsesWithDegrade(io: {
  sendResponses: (withTool: boolean) => Promise<SenderResponse>
  sendChat: (extraSystem?: string) => Promise<SenderResponse>
  readResponses: (r: SenderResponse) => Promise<string>
  readCompletion: (r: SenderResponse) => Promise<string>
}): Promise<string> {
  try {
    return await io.readResponses(await io.sendResponses(true))
  } catch (e) {
    if (!isParamReject(e)) throw e
    try {
      // 400 = 端点不认工具参数:去工具重试一次(同路由)
      return await io.readResponses(await io.sendResponses(false))
    } catch (e2) {
      if (!isParamReject(e2)) throw e2
      return await io.readCompletion(await io.sendChat(WEB_UNAVAILABLE_LINE))
    }
  }
}

/** DeepSeek Responses 响应 → 文本:优先 output_text,退化拼 output 数组里的
 *  message.content[].output_text(官方 Responses 形态);没有可提取内容返回空串 */
export function extractResponsesText(data: unknown): string {
  const o = data as { output_text?: unknown; output?: unknown } | null
  if (typeof o?.output_text === 'string' && o.output_text) return o.output_text
  if (Array.isArray(o?.output)) {
    let t = ''
    for (const item of o.output) {
      const it = item as { type?: string; content?: unknown } | null
      if (it?.type !== 'message' || !Array.isArray(it.content)) continue
      for (const part of it.content) {
        const p = part as { type?: string; text?: unknown } | null
        if (p?.type === 'output_text' && typeof p.text === 'string') t += p.text
      }
    }
    return t
  }
  return ''
}

/** 剥推理模型把思考写进正文的情况(v4 偶发;服务层已剥一次,这里双保险) */
export function stripThinkBlocks(s: string): string {
  return String(s ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .trim()
}

/** Responses 请求体:system 消息并入 instructions,其余按序作 input(多模态不涉及) */
export function buildResponsesBody(
  model: string,
  messages: ReadonlyArray<{ role: string; content: string }>,
  opts: { temperature: number; webSearch: boolean },
): string {
  const sys = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
  const input = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }))
  const body: Record<string, unknown> = {
    model,
    ...(sys ? { instructions: sys } : {}),
    input,
    // 联网档固定 4096:搜索结果消耗输出预算,小预算会 incomplete(实测 256 必截断)
    max_output_tokens: 4096,
    temperature: opts.temperature,
    stream: false,
  }
  if (opts.webSearch) {
    body.tools = [{ type: 'web_search' }]
    body.tool_choice = 'auto'
  }
  return JSON.stringify(body)
}
