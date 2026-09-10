// 一次性角色世界数据迁移:11 条已检老梗合并为 6 条规范表述、清理失真/重复事件线、
// 完结剧情线的 nextHook 移入 ending。迁移逻辑在 src/storage/storyMigration.ts(纯函数,
// 与 app 启动加载共用),本脚本只负责备份与写回。
// 幂等,可重复执行;重复运行不会产生二次合并。
// 用法:先关闭应用(app 进程内的旧缓存会把迁移结果覆写回去),然后
//   node scripts/migrate-story.mjs [--data <story.json 路径>]
// 不带 --data 时默认迁移 %APPDATA%/dev.virtualcharacter.app/data/story.json
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createServer } from 'vite'

const argIdx = process.argv.indexOf('--data')
const dataPath =
  argIdx > 0
    ? path.resolve(process.argv[argIdx + 1])
    : path.join(process.env.APPDATA ?? '', 'dev.virtualcharacter.app', 'data', 'story.json')

if (!existsSync(dataPath)) {
  console.error(`找不到数据文件:${dataPath}`)
  process.exit(1)
}

const d = new Date()
const p2 = (n) => String(n).padStart(2, '0')
const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
const backupPath = `${dataPath}.bak-${stamp}`
await copyFile(dataPath, backupPath)
console.log(`已备份 → ${backupPath}`)

const raw = JSON.parse(await readFile(dataPath, 'utf8'))

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
})
let report
try {
  const mod = await server.ssrLoadModule('/src/storage/storyMigration.ts')
  const result = mod.migrateStoryData(raw)
  report = result.report
  if (!report.changed && raw.version >= 2) {
    console.log('数据已是目标状态,无需迁移(备份仍已生成,可直接删除)')
  } else {
    for (const m of report.mergedGags) {
      console.log(`[老梗合并] ${m.removed.join(' + ')} → ${m.kept}`)
    }
    for (const r of report.rewrittenGags) console.log(`[老梗改写] ${r.from} → ${r.to}`)
    for (const t of report.deletedGags) console.log(`[老梗删除] ${t}`)
    for (const r of report.rewrittenThreads) console.log(`[事件线改写] ${r.from} → ${r.to}`)
    for (const t of report.deletedThreads) console.log(`[事件线删除] ${t}`)
    for (const t of report.endedArcs) console.log(`[剧情完结] 《${t}》nextHook 移入 ending`)
    for (const h of report.rewrittenHooks)
      console.log(`[下一拍重写] 《${h.title}》${h.from} → ${h.to}`)
    const tmp = `${dataPath}.tmp`
    await writeFile(tmp, JSON.stringify(result.data, null, 2), 'utf8')
    await rename(tmp, dataPath)
    console.log(`已写回 → ${dataPath}`)
  }
} finally {
  await server.close()
}
console.log('完成。再次运行本脚本应报告"无需迁移"(幂等)。')
