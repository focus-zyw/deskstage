// 舞台导演消息(纯函数):每个演员每轮收到的一页"剧本指令"。
// 关键约束:只给该演员尚未看过的台词(阅读游标),不给全量 transcript——
// 三个以上角色时 AI 之间本就互不见对方对话,本地 transcript 才是事实源;
// 模型只输出一句台词,输出协议三选一固定形状。

import type { RelayActor, RelayScene, RelayTranscriptLine } from './types'
import { VALID_ACTIONS } from '../performer/dialogSchema'

const OUTPUT_PROTOCOL = [
  '只输出一个 JSON 对象,格式:',
  '{"text":"一句台词","action":"动作词","intent":"continue或end"}',
  `action 词表:${[...VALID_ACTIONS].join('/')}`,
  'intent:想继续演填 continue;认为本场该结束(≥2轮后)填 end。',
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
  /** true = 网络重连后的恢复演出(reset 重发,附全量近况) */
  recovery?: boolean
}

export function buildRelayTurnPrompt(input: RelayTurnPromptInput): string {
  const { scene, actor, transcript, lastSeenSeq, turnIndex, maxTurns, opening } = input
  const unseen = transcript.filter((l) => l.seq > lastSeenSeq)
  const lines: string[] = ['[舞台导演消息 v1]']
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
  if (opening) {
    lines.push('')
    lines.push('本场由你先开口:自然带出场景,像真人接话一样开口,不要报幕。')
  } else {
    lines.push('')
    lines.push(input.recovery ? '刚才连接断了一下,演出继续。你上次发言后发生了:' : '你上次发言后发生了:')
    if (unseen.length === 0) {
      lines.push('(没有新台词,接着你的上一句继续推进)')
    } else {
      for (const l of unseen) {
        lines.push(`${l.seq}. ${l.speaker === 'A' ? '甲' : l.speaker === 'B' ? '乙' : '丙'}:${l.text}`)
      }
    }
  }
  if (turnIndex >= maxTurns - 1) {
    lines.push('')
    lines.push('这是本场最后一句,请自然收住,不开启新话题。')
  }
  lines.push('')
  lines.push(`现在轮到${actor.name}。`)
  lines.push('台词一句,口语化,不超过 30 字,不要引号、不要旁白、不要 JSON 之外的文字。')
  lines.push(OUTPUT_PROTOCOL)
  return lines.join('\n')
}
