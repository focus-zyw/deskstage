// 抓取第三角色 C 的 WebM 素材:从 dsh-pet 仓库(https://github.com/PC2005-cloud/dsh-pet)
// 按中文名下载,重命名为稳定英文 ID 落到 public/animations/c/。
// 素材许可:代码 MIT;动画素材开源可用、禁商用、衍生需注明原仓库地址(见上游 LICENSE)。
// 用法:node scripts/fetch-c-animations.mjs [--force]
// 已存在的文件默认跳过;--force 强制重新下载。抓取失败只报错不中断其余文件,
// 应用侧对缺失素材静默回退 idle(residentManifest),因此本脚本失败不阻塞开发。
import { mkdir, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_RAW = 'https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/webm'
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'animations', 'c')

/** 逻辑动作 → 上游素材中文名(数组 = 随机候选);英文 ID 即落盘文件名 */
const SOURCES = {
  idle: ['待机呼吸休闲'],
  talk: ['深度思考碎碎念'],
  think: ['工作状态-思考冒泡'],
  happy: ['点击回应-开心跃动'],
  wave: ['点击回应-元气挥手'],
  angry: ['点击回应-傲娇生气'],
  surprise: ['点击回应-害羞惊讶'],
  startled: ['打瞌睡被惊醒'],
  caught: ['偷吃零食被抓住'],
  turn: ['东张西望'],
  walk: ['螃蟹走路'],
  float: ['原地漂浮踏步'],
  drag: ['被鼠标拖拽悬空反馈'],
}

const force = process.argv.includes('--force')
await mkdir(OUT_DIR, { recursive: true })

let ok = 0
const failed = []
for (const [id, names] of Object.entries(SOURCES)) {
  const dest = path.join(OUT_DIR, `${id}.webm`)
  if (!force) {
    try {
      const s = await stat(dest)
      if (s.size > 10_000) {
        console.log(`跳过(已存在) ${id}.webm`)
        ok++
        continue
      }
    } catch {
      // 不存在,继续下载
    }
  }
  const name = names[0]
  const url = `${REPO_RAW}/${encodeURIComponent(name)}.webm`
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 10_000) throw new Error(`文件过小(${buf.length}B),疑似下载不完整`)
    await writeFile(dest, buf)
    console.log(`完成 ${id}.webm  ← ${name} (${(buf.length / 1024).toFixed(0)}KB)`)
    ok++
  } catch (e) {
    console.error(`失败 ${id}.webm ← ${name}: ${e.message}`)
    failed.push(id)
  }
}
console.log(`\n${ok}/${Object.keys(SOURCES).length} 个素材就绪 → ${OUT_DIR}`)
if (failed.length) {
  console.error(`缺失: ${failed.join(', ')}(应用会回退 idle.webm;可重跑本脚本补齐)`)
  process.exitCode = 1
}
