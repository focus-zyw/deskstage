// 命令面板的路由层:命令注册表 + 整句自然语言路由。
// 路由顺序:关键词(提醒/演出/命令字面) → LLM 兜底(只挑命令 id,不生成内容);
// 提醒的时间解析在 parseTime.ts,认不出时间时回落"预填文本用户确认",绝不猜错时间默默设上。
import { complete } from '../../engine/llmGateway'
import { parseChineseTime, extractMemoText } from './parseTime'
import { allModes } from '../../performer/modes'

export interface Command {
  id: string
  label: string
  keywords: string[]
  run: () => void
}

export type NlRoute =
  | { kind: 'command'; command: Command }
  | { kind: 'memo'; text: string; due: Date | null }
  | { kind: 'perform'; mode: string; topic?: string }
  | { kind: 'none' }

/** 命令搜索:字面包含即命中(空串返回全量) */
export function filterCommands(input: string, commands: Command[]): Command[] {
  const q = input.trim().toLowerCase()
  if (!q) return commands
  return commands.filter(
    (c) => c.label.toLowerCase().includes(q) || c.keywords.some((k) => q.includes(k.toLowerCase()) || k.includes(q)),
  )
}

/** 演出触发词拼正则用:转义保留字面量语义(触发词一般是纯中文,防御性处理) */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 整句路由:优先零成本关键词,拿不准再花一次 LLM 调用 */
export async function nlRoute(input: string, commands: Command[]): Promise<NlRoute> {
  const q = input.trim()
  if (!q) return { kind: 'none' }

  // 1) 提醒类:无论多长句子,先试时间解析
  if (/提醒|叫我|备忘|待办/.test(q)) {
    return { kind: 'memo', text: extractMemoText(q) || q, due: parseChineseTime(q) }
  }

  // 2) 演出类:"来一段关于加班的相声"。触发词来自各模式自带的 triggers(数据驱动):
  //    模式工坊新加的自定义模式自动可点播
  const performable = allModes().filter((m) => (m.triggers?.length ?? 0) > 0)
  const alt = performable.flatMap((m) => m.triggers ?? []).map(escapeRegExp).join('|')
  const perform = alt ? q.match(new RegExp(`(?:来|说|演|放|讲)?一?段(.{0,12}?)(${alt})`)) : null
  if (perform) {
    const hit = performable.find((m) => (m.triggers ?? []).includes(perform[2]))
    if (hit) {
      const topic = perform[1].replace(/^关于|关于$|^的|的$/g, '').trim()
      return { kind: 'perform', mode: hit.id, topic: topic || undefined }
    }
  }

  // 3) 命令关键词字面命中
  const hit = commands.find((c) => c.keywords.some((k) => q.includes(k)))
  if (hit) return { kind: 'command', command: hit }

  // 4) LLM 兜底:只做命令挑选,失败静默回落
  if (q.length >= 6) {
    const cmd = await llmPickCommand(q, commands)
    if (cmd) return { kind: 'command', command: cmd }
  }
  return { kind: 'none' }
}

async function llmPickCommand(q: string, commands: Command[]): Promise<Command | null> {
  try {
    const list = commands.map((c) => `${c.id}: ${c.label}`).join('\n')
    const raw = await complete({
      messages: [
        {
          role: 'system',
          content: `你是桌面宠物的命令路由器。把用户的话映射到下列命令之一,只输出一个 JSON 对象:{"command":"命令id"};没有合适命令就输出 {"command":null}。不要解释,不要执行命令。\n命令列表:\n${list}`,
        },
        { role: 'user', content: q },
      ],
      temperature: 0.1,
      maxTokens: 120,
      jsonMode: true,
      timeoutMs: 8_000,
    })
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) return null
    const id = (JSON.parse(m[0]) as { command?: unknown }).command
    if (typeof id !== 'string') return null
    return commands.find((c) => c.id === id) ?? null
  } catch {
    return null // LLM 不可用 → 关键词路由已是全部能力
  }
}
