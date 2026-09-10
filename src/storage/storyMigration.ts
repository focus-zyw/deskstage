// 角色世界数据迁移(v1 → v2),2026-09-11 记忆检查结论的落地:
// ①11 条已检老梗合并为 6 条规范表述(同场景重复入库、反问写成事实、缺主体);
// ②删除已被完结剧情覆盖、或未经台词确认的事件线;
// ③结构迁移:done 剧情线的 nextHook 移入 ending——完结线不再有下一拍。
// 全部步骤按"精确旧文本/旧钩子"匹配,首跑后旧文本消失,重复执行是 no-op。
// app 加载(storyStore.loadRaw)与 scripts/migrate-story.mjs 共用本函数,保证两边结果一致。

export interface MigrationReport {
  changed: boolean
  mergedGags: { kept: string; removed: string[] }[]
  rewrittenGags: { from: string; to: string }[]
  deletedGags: string[]
  rewrittenThreads: { from: string; to: string }[]
  deletedThreads: string[]
  /** nextHook 移入 ending 的完结剧情线标题 */
  endedArcs: string[]
  rewrittenHooks: { title: string; from: string; to: string }[]
}

// 同一梗被拆成多条入库 → 合并为一条自包含、带主体的规范表述
const GAG_MERGES: { text: string; legacy: string[] }[] = [
  {
    text: '甲用"赛博身体不适"请假，店长秒批',
    legacy: ['AI写请假条店长秒批', '赛博身体不适需接入床铺碎片整理'],
  },
  {
    text: '甲家的猪会唱《孤勇者》，疑似陈奕迅教的',
    legacy: ['猪自己哼的调是陈奕迅考不上编转行养的', '甲家的猪得是陈奕迅考不上编转行养的'],
  },
  {
    text: '甲认定家族群才是真算法，专推灵魂拷问',
    legacy: ['算法比亲戚懂我，还秒推辟谣', '家族群是过年灵魂拷问的真算法'],
  },
  {
    text: '甲办图书卡就算读过书，还在儿童区睡觉采风',
    legacy: ['图书馆办卡等于跟知识签约，已履约', '儿童区小板凳是沉浸式阅读神器'],
  },
]
// 原表述有语病/把吐槽写成了事实 → 改写为规范表述(hits 等字段保留)
const GAG_REWRITES: { from: string; to: string }[] = [
  { from: '无糖比白开水还狠，全糖永远背锅', to: '乙点无糖，甲喝全糖也要让乙背锅' },
  { from: '奶茶杯里连茶底都是AI画的', to: '甲的赛博奶茶被吐槽连茶底都是AI画的' },
]
// 比喻不成立的临时甩锅("充电宝"梗,相关情节已由房东语音事件线保存)
const GAG_DELETES = ['甲的手机是公用充电宝，谁都能借去发emo语音']

const THREAD_REWRITES: { from: string; to: string }[] = [
  { from: '怀疑观众和店长全是AI', to: '甲怀疑观众和店长全是AI' },
]
const THREAD_DELETES = [
  // 对应剧情线"声明发观众群"已完结,事件线留着会被错误复活
  '观众群投票让甲直播唱全曲，票数已过百',
  '甲要教猪唱《孤勇者》凑合唱环节',
  // 已被活跃剧情"图书馆睡神"覆盖
  '甲办图书馆卡却把儿童区睡成采风地，管理员来了',
  // 只是乙的挖苦,从未被台词确认为事实
  '甲拿AI图当毕业设计被质疑',
  // 就是活跃剧情"监控拷贝危机"本身,同件事不再挂一条事件线
  '乙把监控备份发给甲的相亲对象，还透露甲存有十八集监控日记',
]

// "AI放假疑云"的下一拍被"毕业设计"这条未确认事实污染,改从已确立的请假条梗派生
const ARC_HOOK_REWRITES: { title: string; from: string; to: string }[] = [
  {
    title: 'AI放假疑云',
    from: '甲发现毕业设计也是AI代笔，怀疑自己是否真人',
    to: '店长秒批了甲的AI请假条，弹幕跟着起哄给自己批假，甲被追问AI到底放没放假',
  },
]

type Row = Record<string, unknown>
const rows = (v: unknown): Row[] => (Array.isArray(v) ? v.map((x) => ({ ...((x ?? {}) as Row) })) : [])
const num = (v: unknown): number => Number(v) || 0

export function migrateStoryData(raw: unknown): { data: Row; report: MigrationReport } {
  const o = (raw ?? {}) as Row
  const report: MigrationReport = {
    changed: false,
    mergedGags: [],
    rewrittenGags: [],
    deletedGags: [],
    rewrittenThreads: [],
    deletedThreads: [],
    endedArcs: [],
    rewrittenHooks: [],
  }

  const gags = rows(o.gags)
  for (const merge of GAG_MERGES) {
    const found = gags.filter((g) => merge.legacy.includes(String(g.text)))
    if (found.length === 0) continue
    // 规范表述已存在(部分迁移过/用户手动建过)时并入它,否则保留数组序最早的一条
    const existing = gags.find((g) => g.text === merge.text)
    const pool = existing && !found.includes(existing) ? [...found, existing] : found
    const target = existing ?? found[0]!
    target.text = merge.text
    target.hits = Math.max(0, pool.reduce((s, g) => s + num(g.hits), 0))
    target.lastSeen = Math.max(...pool.map((g) => num(g.lastSeen)))
    target.lastInjectedAt = Math.max(...pool.map((g) => num(g.lastInjectedAt)))
    for (const g of pool) {
      if (g === target) continue
      const i = gags.indexOf(g)
      if (i >= 0) gags.splice(i, 1)
    }
    report.mergedGags.push({ kept: merge.text, removed: pool.filter((g) => g !== target).map((g) => String(g.text)) })
  }
  for (const r of GAG_REWRITES) {
    const g = gags.find((x) => x.text === r.from)
    if (!g) continue
    g.text = r.to
    report.rewrittenGags.push({ from: r.from, to: r.to })
  }
  for (const text of GAG_DELETES) {
    const i = gags.findIndex((x) => x.text === text)
    if (i < 0) continue
    gags.splice(i, 1)
    report.deletedGags.push(text)
  }

  const threads = rows(o.threads)
  for (const r of THREAD_REWRITES) {
    const t = threads.find((x) => x.text === r.from)
    if (!t) continue
    t.text = r.to
    report.rewrittenThreads.push({ from: r.from, to: r.to })
  }
  for (const text of THREAD_DELETES) {
    const i = threads.findIndex((x) => x.text === text)
    if (i < 0) continue
    threads.splice(i, 1)
    report.deletedThreads.push(text)
  }

  const arcs = rows(o.arcs)
  for (const arc of arcs) {
    for (const r of ARC_HOOK_REWRITES) {
      if (arc.title === r.title && arc.nextHook === r.from) {
        arc.nextHook = r.to
        report.rewrittenHooks.push({ title: r.title, from: r.from, to: r.to })
      }
    }
    // 结构迁移:完结线的收尾存档进 ending,不再保留下一拍
    if (arc.status === 'done' && typeof arc.nextHook === 'string' && arc.nextHook) {
      arc.ending = arc.nextHook
      arc.nextHook = ''
      report.endedArcs.push(String(arc.title))
    }
  }

  report.changed =
    report.mergedGags.length > 0 ||
    report.rewrittenGags.length > 0 ||
    report.deletedGags.length > 0 ||
    report.rewrittenThreads.length > 0 ||
    report.deletedThreads.length > 0 ||
    report.endedArcs.length > 0 ||
    report.rewrittenHooks.length > 0
  return { data: { ...o, version: 2, gags, threads, arcs }, report }
}
