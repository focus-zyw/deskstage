// 网页模型手动验证的评测脚本:用仓库里真实的 parseGeneratedDialog(dialogSchema.ts)
// 跑手动粘贴回来的原始输出,给出"能否直接接入"的硬结论。
// 用法: node scripts/webchat-eval/eval.ts   (Node >= 22.18,原生 TS 类型剥离)
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseGeneratedDialog,
  sanitizeDialogLine,
  VALID_ACTIONS,
  DELIVERIES,
} from '../../src/performer/dialogSchema.ts'

const here = join(dirname(fileURLToPath(import.meta.url)))
const rawDir = join(here, 'raw')

// 与 llmClient.parseDialog 同参:minLines=4
const MIN_LINES = 4

function auditDialog(raw: string): string[] {
  const issues: string[] = []
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) return ['找不到 JSON']
  let obj: any
  try {
    obj = JSON.parse(m[0])
  } catch (e) {
    return [`JSON.parse 失败: ${(e as Error).message}`]
  }
  const arr: any[] = Array.isArray(obj.dialog) ? obj.dialog : []
  // 场景卡字段(经 sanitizeSceneCard 的截断上限核对)
  const card = obj.card ?? {}
  const relLen = String(card.relationship ?? '').length
  if (relLen > 40) issues.push(`card.relationship ${relLen} 字,超 40 截断上限(会被截)`)
  // 逐行原始审计(sanitize 之前的问题,才是模型真实的格式服从度)
  let prevSpeaker = ''
  let breaks = 0
  const badActions: string[] = []
  const badListener: string[] = []
  const badDelivery: string[] = []
  let longLines = 0
  for (const l of arr) {
    const sp = l?.speaker
    if (sp !== 'A' && sp !== 'B') issues.push(`非法 speaker: ${JSON.stringify(sp)}`)
    else if (sp === prevSpeaker) breaks++
    prevSpeaker = sp
    if (l?.action && !VALID_ACTIONS.has(l.action)) badActions.push(l.action)
    if (l?.listenerAction && !VALID_ACTIONS.has(l.listenerAction)) badListener.push(l.listenerAction)
    if (l?.delivery && !(DELIVERIES as readonly string[]).includes(l.delivery)) badDelivery.push(l.delivery)
    const t = typeof l?.text === 'string' ? l.text.trim() : ''
    if (t.length > 25) longLines++
  }
  if (breaks) issues.push(`${breaks} 处未交替说话(协议要求交替;解析器不拦,演出观感问题)`)
  if (badActions.length) issues.push(`非法 action(会被归一为 talk): ${[...new Set(badActions)].join(', ')}`)
  if (badListener.length) issues.push(`非法 listenerAction(会被丢弃): ${[...new Set(badListener)].join(', ')}`)
  if (badDelivery.length) issues.push(`非法 delivery(会被丢弃): ${[...new Set(badDelivery)].join(', ')}`)
  if (longLines) issues.push(`${longLines} 句超 25 字(协议软约束)`)
  return issues
}

function runJson(file: string): void {
  const raw = readFileSync(join(rawDir, file), 'utf8')
  console.log(`\n===== ${file} =====`)
  try {
    const r = parseGeneratedDialog(raw, MIN_LINES)
    const total = r.before.length + Object.values(r.after).reduce((n, a) => n + a.length, 0)
    console.log(`解析: ✅ 通过 (有效台词 ${total} 句, 场景卡: ${r.card ? '有' : '无'})`)
    if (r.card) {
      console.log(`  卡: relationship="${r.card.relationship}" | scene=${r.card.scene}`)
      console.log(`  卡: secret=${r.card.secret}`)
      console.log(`  卡: escalation ${r.card.escalation.length} 拍 | callback=${r.card.callback}`)
    }
    for (const issue of auditDialog(raw)) console.log(`  审计: ⚠️  ${issue}`)
  } catch (e) {
    console.log(`解析: ❌ 失败 — ${(e as Error).message}`)
    for (const issue of auditDialog(raw)) console.log(`  审计: ⚠️  ${issue}`)
  }
}

function runChatLine(file: string): void {
  const raw = readFileSync(join(rawDir, file), 'utf8').trim()
  // 与 generateUserChatReply 的验收逻辑一致:剥引号,>40 字判不合规
  let line = raw
  if (line.startsWith('{')) {
    try {
      const obj = JSON.parse(line)
      const inner = [obj.text, obj.content].find((v: unknown) => typeof v === 'string')
      if (inner) line = (inner as string).trim()
    } catch { /* 按原文处理 */ }
  }
  line = line.replace(/^["'「『]|["'」』]$/g, '')
  const ok = line && line.length <= 40
  console.log(`\n===== ${file} =====`)
  console.log(`${ok ? '✅ 通过' : '❌ 不合规'} (${line.length} 字, 要求 ≤40, 协议建议 15~25): ${line}`)
}

for (const f of readdirSync(rawDir).sort()) {
  if (/-[ab]\.txt$/.test(f)) runJson(f)
  else if (/-c\.txt$/.test(f)) runChatLine(f)
}
