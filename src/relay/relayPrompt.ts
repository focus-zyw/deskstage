// 舞台导演消息(纯函数):每个演员首次/重建会话收到完整设定、历史和输出协议，
// 正常后续轮只收到阅读游标之后的新台词与短节拍。网页标签页保存稳定上下文；
// 若模型格式漂移，由独立纠错消息按需补发协议。

import type { RelayActor, RelayScene, RelayTranscriptLine } from './types'
import { VALID_ACTIONS } from '../performer/dialogSchema'

const OUTPUT_PROTOCOL = [
  '只输出一个 JSON 对象,格式:',
  '{"text":"一句台词","action":"动作词","intent":"continue或end"}',
  `action 词表:${[...VALID_ACTIONS].join('/')}`,
  'intent 只能填 continue 或 end。',
].join('\n')

export interface RelayTurnPromptInput {
  scene: RelayScene
  actor: RelayActor
  /** 全场 transcript(函数内部按 lastSeenSeq 过滤未见部分) */
  transcript: RelayTranscriptLine[]
  /** 该演员的阅读游标:只发 seq > lastSeenSeq 的台词 */
  lastSeenSeq: number
  /** 本场轮次(0 起);达到 maxTurns-1 起注入收尾指令 */
  turnIndex: number
  maxTurns: number
  /** true = 开场(第一句,由该演员先开口) */
  opening: boolean
  /** true = 该角色首次进入或网页会话刚重建，需要注入完整稳定设定与历史 */
  fullContext: boolean
  /** true = 网络重连后的恢复演出(reset 重发,附全量近况) */
  recovery?: boolean
}

export function buildRelayTurnPrompt(input: RelayTurnPromptInput): string {
  const { scene, actor, transcript, lastSeenSeq, turnIndex, maxTurns, opening, fullContext } = input
  const unseen = transcript.filter((l) => l.seq > lastSeenSeq)
  const visibleTranscript = fullContext ? transcript : unseen
  const lines: string[] = [fullContext ? '[舞台导演消息 v3·初始化]' : '[导演·增量]']
  if (fullContext) {
    lines.push(`场景:${scene.topic}——${scene.hook}(本轮切口:${scene.focus})`)
    lines.push(`你的角色:${actor.persona}`)
    lines.push(`当前阶段:${scene.stage}`)
    lines.push(`两人关系:${scene.relationship}`)
    lines.push(`你的目标:${actor.speaker === 'A' ? scene.goalA : scene.goalB}`)
    if (scene.allowedBranches.length > 0) {
      lines.push(`可自然延伸、但不能越过的范围:${scene.allowedBranches.join(';')}`)
    }
    if (scene.avoid.length > 0) {
      lines.push(`最近已聊过、不要重复提:${scene.avoid.join('、')}`)
    }
  }
  if (opening) {
    lines.push('')
    lines.push('本场由你先开口:自然带出场景,像真人接话一样开口,不要报幕。')
  } else {
    lines.push('')
    lines.push(
      input.recovery
        ? '刚才连接断了一下,以下是本场完整进度,演出继续:'
        : fullContext
          ? '这是新的网页会话,开场至今发生了:'
          : '未读台词:',
    )
    if (visibleTranscript.length === 0) {
      lines.push('(没有新台词,接着你的上一句继续推进)')
    } else {
      for (const l of visibleTranscript) {
        lines.push(`${l.seq}. ${l.speaker === 'A' ? '甲' : l.speaker === 'B' ? '乙' : '丙'}:${l.text}`)
      }
    }
  }
  if (turnIndex >= maxTurns - 1) {
    lines.push('')
    lines.push('末句:自然收住,不开新话题。')
  } else if (turnIndex >= maxTurns - 3) {
    lines.push('')
    lines.push('收束:完成回应闭环;收住可填 end。')
  } else {
    lines.push('')
    lines.push('展开:接住并添新信息;intent 填 continue。')
  }
  lines.push('')
  if (fullContext) {
    lines.push(`现在轮到${actor.name}。`)
    lines.push('台词一句,口语化,不超过 30 字,不要引号、不要旁白、不要 JSON 之外的文字。')
    lines.push(OUTPUT_PROTOCOL)
  } else {
    lines.push(`${actor.name}接话:一句口语台词,不超过30字。`)
  }
  return lines.join('\n')
}

/** 网页已经回答但格式不可解析时，在原会话中要求重写上一条，不推进剧情。 */
export function buildRelayFormatRepairPrompt(): string {
  return [
    '[导演·格式纠错]',
    '上一条回复无法解析。不要续写、不要解释,只把上一条台词按以下格式重写:',
    OUTPUT_PROTOCOL,
  ].join('\n')
}
