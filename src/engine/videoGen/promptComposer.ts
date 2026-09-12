// 剧本轻适配的唯一落点:不改 DialogLine/SceneCard——把已有台词(动作/反应/语气)
// + 场景卡 + 人设压缩成一段 5~15 秒短视频的画面描述 prompt,交给视频模型生成。
// LLM 只做"翻译"不新增剧情;失败时回退本地模板拼装(要素仍在,只是少了镜头语言)。
import { complete } from '../llmGateway'
import { genderOf, nameOf } from '../persona'
import { deliveryInstruction, reactionsOf, type DialogLine, type Speaker } from '../../performer/dialogSchema'
import type { Episode } from '../../storage/historyStore'

/** 短视频容量有限,超长剧本只取开头若干句(节拍在前的最关键) */
const MAX_LINES = 8
/** 单句摘录上限:视频 prompt 要的是画面要素,不是完整台词 */
const MAX_LINE_TEXT = 40

export interface ComposeInput {
  /** 最近一集(或空 = 纯手写创意) */
  episode: Pick<Episode, 'lines' | 'card'> | null
  /** 用户补充的创意方向(可空) */
  brief?: string
  /** 视频主角;缺省 = 第一句说话者 */
  lead?: Speaker
  /** 进 prompt 的对白句数(按时长定:5 秒 1 句,10 秒 2 句);缺省 2 */
  maxSpokenLines?: number
}

/** 动作词表 → 画面动词(给视频模型看得懂的演出描述) */
export const ACTION_HINTS: Record<string, string> = {
  idle: '安静站立',
  talk: '开口说话',
  happy: '笑容明媚',
  laugh: '开怀大笑',
  shy: '害羞低头',
  sleepy: '困倦打盹',
  wave: '向镜头挥手',
  thinking: '托腮思考',
  angry: '气鼓鼓地皱眉',
  sad: '委屈低落',
  surprise: '惊讶睁大眼',
  shake: '连连摇头',
  jump: '雀跃跳起',
}

function actionHint(action: string): string {
  return ACTION_HINTS[action] ?? '表情生动'
}

/** 台词数组 → 结构化要点(纯函数,可测):说话者/动作/听者反应/语气 + 台词摘录 */
export function scriptDigest(lines: DialogLine[]): string[] {
  return lines.slice(0, MAX_LINES).map((l) => {
    const parts = [`${nameOf(l.speaker)}(${genderOf(l.speaker)})${actionHint(l.action)}`]
    for (const [k, v] of Object.entries(reactionsOf(l))) {
      parts.push(`${nameOf(k as Speaker)}${actionHint(v)}`)
    }
    const del = deliveryInstruction(l.delivery)
    if (del) parts.push(del)
    parts.push(`「${l.text.slice(0, MAX_LINE_TEXT)}」`)
    return parts.join(',')
  })
}

/** 无 LLM 时的模板拼装(纯函数,可测):场景卡 + 开场动作 + 用户补充 + 对白 */
export function fallbackPrompt(input: ComposeInput): string {
  const lines = input.episode?.lines ?? []
  const card = input.episode?.card
  const lead = input.lead ?? lines[0]?.speaker ?? 'A'
  const other: Speaker = lead === 'A' ? 'B' : 'A'
  const scene = card?.scene?.trim() || '明亮温馨的都市室内'
  const first = lines[0]
  const opening =
    first && first.speaker === lead
      ? `${nameOf(lead)}(${genderOf(lead)})${actionHint(first.action)}`
      : `${nameOf(lead)}(${genderOf(lead)})与${nameOf(other)}面对面站着互动`
  const brief = input.brief?.trim()
  const visual = [
    `${scene}。${opening}`,
    first ? `两人像真人一样自然交流,节奏轻快` : '人物神态自然',
    brief || '中景镜头,柔和自然光,动作连贯自然',
  ]
    .filter(Boolean)
    .join('。')
  return assemblePrompt(visual, pickSpokenLines(lines, input.maxSpokenLines ?? 2))
}

const SYSTEM_PROMPT = [
  '你是短视频分镜师。把一段桌面虚拟角色的对话演出压缩成一个 5~15 秒短视频的画面描述,',
  '这段文字将直接作为文生视频/图生视频模型的 prompt。',
  '要求:',
  '- 只写画面:场景环境、人物外形与情绪、关键动作、镜头运用',
  '  (角色对白由系统单独附加,你不用写台词)',
  '- 情绪与动作必须贴合台词的动作标注,人物关系与性格保持原剧设定,不新增情节',
  '- 输出一段话,120 字以内,直接给出描述文本,不要任何解释、引号或前缀',
].join('')

/** 单句对白长度上限:5 秒视频约念得完 20 字上下 */
const SPOKEN_MAX_CHARS = 24

/** 抽出可念的对白(纯函数,可测):首选首句,再取下一个不同说话者的句子,
 *  各截到第一个句读处。对白原文直接拼进 prompt——带音频生成的模型
 *  (Seedance 2.0 / CogVideoX-3 等)会据此让角色开口说这句话 */
export function pickSpokenLines(lines: DialogLine[], max = 2): string[] {
  if (max <= 0 || lines.length === 0) return []
  const toSpeech = (l: DialogLine): string => {
    const clause = l.text.split(/[。!!??,;，,;;…]/).find((s) => s.trim()) ?? l.text
    const s = clause.trim().slice(0, SPOKEN_MAX_CHARS)
    return `${nameOf(l.speaker)}:「${s}」`
  }
  const first = lines[0]
  const out = [toSpeech(first)]
  if (max > 1) {
    const reply = lines.find((l) => l.speaker !== first.speaker)
    if (reply) out.push(toSpeech(reply))
  }
  return out
}

/** 画面描述 + 对白原文的最终组装(LLM 转译与模板回退共用,对白不依赖 LLM 转述) */
function assemblePrompt(visual: string, spoken: string[]): string {
  const base = visual.trim().replace(/^["「]|["」]$/g, '').slice(0, 400)
  return spoken.length > 0 ? `${base}\n角色对白:${spoken.join(' ')}` : base
}

export interface ComposeResult {
  prompt: string
  /** true = LLM 转译失败,用的是本地模板(UI 据此提示) */
  usedFallback: boolean
  error?: string
}

/** 调主 LLM 把剧本转译成视频画面 prompt;LLM 失败回退模板,绝不抛错空手而归 */
export async function composeVideoPrompt(
  input: ComposeInput,
  deps: { complete: typeof complete } = { complete },
): Promise<ComposeResult> {
  const lines = input.episode?.lines ?? []
  const brief = input.brief?.trim() ?? ''
  if (lines.length === 0 && !brief) {
    throw new Error('没有可用的素材:先在舞台上演一段,或直接手写画面描述')
  }
  const userParts: string[] = []
  const card = input.episode?.card
  if (card) {
    userParts.push(
      `【场景卡】关系:${card.relationship};场景:${card.scene};暗线:${card.secret};收梗:${card.callback}`,
    )
  }
  const digest = scriptDigest(lines)
  if (digest.length > 0) userParts.push(`【台词】\n${digest.join('\n')}`)
  if (brief) userParts.push(`【用户补充】${brief.slice(0, 200)}`)
  try {
    const raw = await deps.complete({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userParts.join('\n\n') },
      ],
      temperature: 0.8,
      maxTokens: 400,
      jsonMode: false,
      timeoutMs: 30_000,
    })
    // 画面归画面;对白原文由这里确定性拼上,不依赖 LLM 转述
    const visual = raw.trim()
    if (!visual) throw new Error('空响应')
    return {
      prompt: assemblePrompt(visual, pickSpokenLines(lines, input.maxSpokenLines ?? 2)),
      usedFallback: false,
    }
  } catch (e) {
    return {
      prompt: fallbackPrompt(input),
      usedFallback: true,
      error: String((e as Error)?.message ?? e).slice(0, 80),
    }
  }
}
