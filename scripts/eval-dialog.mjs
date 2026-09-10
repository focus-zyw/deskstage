// 对话结构离线评测(P2):固定场景跑分,衡量模型对输出协议的结构服从度。
// 只评结构(JSON 通过/死抉择/节拍覆盖/连说/超长句),不评"好不好笑"——那需要人。
// 直接调用 OpenAI 兼容端点(读应用配置),复用 src 的解析与校验器,保证与线上同标准。
// 用法:node scripts/eval-dialog.mjs [--limit N]   (不套壳地跑全量 10 个场景,逐个串行)
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createServer } from 'vite'

// ---------- 固定场景集(10):覆盖 话题/抉择/场外/剧情拍 组合 ----------
const SCENES = [
  { name: '便利店-临期食品之争', topic: '临期食品打折该不该囤', choice: false },
  { name: '便利店-雨夜抢伞', topic: '下雨天两人只有一把伞', choice: true },
  { name: '程序员-线上翻车', topic: '周五晚上上线出了事故', choice: false },
  { name: '程序员-需求又变了', topic: '产品经理半夜改需求', choice: true },
  { name: '合租-冰箱主权', topic: '冰箱里谁的东西过期了', choice: false },
  { name: '外卖-差评风波', topic: '甲给差评后发现是乙的店', choice: true },
  { name: '健身-年卡骗局', topic: '甲想办第三张健身年卡', choice: false },
  { name: '网购-凑单满减', topic: '为了满减凑单越凑越多', choice: true },
  { name: '宠物-猫的地位', topic: '乙的猫只认甲当铲屎官', choice: false },
  { name: '存款-记账之争', topic: '甲的记账 App 显示乙超支', choice: true },
]

const argIdx = process.argv.indexOf('--limit')
const limit = argIdx > 0 ? Math.max(0, Number(process.argv[argIdx + 1]) || 0) : SCENES.length

// ---------- 输出协议(与 promptBuilder 同源精简;评测关注结构服从度) ----------
const PROTOCOL = (scene) => `维护桌面双人情景剧。写一集:${scene.topic}。
输出协议（严格遵守）：
- 只输出一个 JSON 对象，不要输出任何其他文字
- 先写场景卡再写台词，格式：{"card":{"relationship":"关系标签","scene":"具体场景一句话","goalA":"甲想要什么","goalB":"乙想要什么","secret":"被隐瞒的关键信息","escalation":["节拍1","节拍2","节拍3"],"callback":"结尾回收的本集铺垫"},"dialog":[{"speaker":"A","text":"台词","action":"动作","target":"B","beatId":"节拍1"},...]}
- 每句必填 "target"("A"/"B"=对方/"audience"=对观众/"room"=对全场) 和 "beatId"(实现 card.escalation 的哪一拍,逐字引用)
- speaker 只能是 "A" 或 "B";一段共 14~22 句,两人交替说话;每句口语化不超过 25 字
- action 用具体小动作词(如 翻白眼/凑近/拍桌)
${scene.choice ? '- 在冲突最激烈的中段插入恰好一个抉择对象:{"choice":{"prompt":"站队问题,15字内","options":[{"id":"a","label":"选项一"},{"id":"b","label":"选项二"}]}};choice 之后的台词带 "branch":"所支持选项id",两个分支各 3~5 句,结尾收同一个底包袱' : '- 本集不要输出 choice'}
- secret 在结尾反转揭晓;callback 必须回收本集前面埋的线`

// ---------- 运行 ----------
const dataDir = path.join(process.env.APPDATA ?? '', 'dev.virtualcharacter.app', 'data')
const cfg = JSON.parse(readFileSync(path.join(dataDir, 'config.json'), 'utf8'))
const baseUrl = String(cfg.baseUrl ?? '').replace(/\/+$/, '')
if (!cfg.apiKey || !baseUrl || !cfg.model) {
  console.error('配置缺少 apiKey/baseUrl/model,请先在应用里配好模型')
  process.exit(1)
}

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
})
const { parseGeneratedDialog, validatePerformanceScript } = await server.ssrLoadModule(
  '/src/performer/dialogSchema.ts',
)

async function callLlm(prompt) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'system', content: '你是桌面双人情景剧的编剧,严格遵守输出协议。' }, { role: 'user', content: prompt }],
      temperature: 1.1,
      max_tokens: 4000,
      response_format: { type: 'json_object' },
    }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  return data.choices?.[0]?.message?.content ?? ''
}

const rows = []
for (const scene of SCENES.slice(0, limit)) {
  const started = Date.now()
  const row = { name: scene.name, parseOk: false, fatal: 0, warnings: 0, choiceOk: false, beatOk: false, lines: 0, ms: 0 }
  try {
    const raw = await callLlm(PROTOCOL(scene))
    const script = parseGeneratedDialog(raw)
    row.parseOk = true
    row.lines = script.before.length + Object.values(script.after).reduce((s, l) => s + l.length, 0)
    const v = validatePerformanceScript(script)
    row.fatal = v.fatal.length
    row.warnings = v.warnings.length
    row.choiceOk = !script.choice || (script.choice.options.every((o) => (script.after[o.id]?.length ?? 0) >= 2))
    const beats = script.card?.escalation ?? []
    const used = new Set(
      [...script.before, ...Object.values(script.after).flat()].map((l) => l.beatId).filter(Boolean),
    )
    row.beatOk = beats.length > 0 && beats.every((b) => used.has(b))
  } catch (e) {
    row.error = String(e.message ?? e).slice(0, 120)
  }
  row.ms = Date.now() - started
  rows.push(row)
  const mark = (ok) => (ok ? '✓' : '✗')
  console.log(
    `${mark(row.parseOk)}解析 ${mark(row.fatal === 0)}结构 ${mark(row.choiceOk)}分支 ${mark(row.beatOk)}节拍 | ${row.name} (${Math.round(row.ms / 100) / 10}s${row.error ? ` | ${row.error}` : ''})`,
  )
}
await server.close()

const n = rows.length || 1
const pct = (x) => `${Math.round((x / n) * 100)}%`
console.log('\n=== 结构服从度汇总(共 %d 场景) ==='.replace('%d', String(n)))
console.log(`JSON 解析通过率      ${pct(rows.filter((r) => r.parseOk).length)}`)
console.log(`结构一次通过率       ${pct(rows.filter((r) => r.parseOk && r.fatal === 0).length)}`)
console.log(`双分支完整率         ${pct(rows.filter((r) => r.choiceOk).length)}`)
console.log(`节拍覆盖达标率       ${pct(rows.filter((r) => r.beatOk).length)}`)
console.log(`连说/超长/收底警告   ${rows.reduce((s, r) => s + r.warnings, 0)} 条`)
console.log(`平均句数             ${Math.round((rows.reduce((s, r) => s + r.lines, 0) / n) * 10) / 10}`)
console.log(`平均耗时             ${Math.round(rows.reduce((s, r) => s + r.ms, 0) / n / 100) / 10}s`)
