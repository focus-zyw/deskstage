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
  working: ['写代码'],
  focus: ['工作状态-忙碌点按'],
  stretch: ['超大伸懒腰'],
  hum: ['悠闲哼歌'],
  tap: ['原地敲击桌面互动'],
  // —— 动作词补缺(此前 sad/sleepy/shake/jump 回退待机) ——
  sigh: ['工作状态-垂头叹气冒汗'],
  fallen: ['被落叶淹没'],
  yawn: ['哈欠连天'],
  nap: ['原地小憩沉眠'],
  squash: ['原地重力下蹲压缩'],
  jump_smash: ['原地跳跃抓碎头顶物品'],
  cheer: ['工作状态-雀跃庆祝'],
  pace: ['工作状态-原地踱步张望'],
  // —— 待机链:管家日常与玩心 ——
  wipe: ['碎碎念-擦桌碎碎念'],
  screen_mutter: ['碎碎念-对屏碎碎念'],
  daze: ['碎碎念-发呆碎碎念'],
  cat: ['撸猫'],
  mirror: ['照镜子'],
  cube: ['原地专心玩魔方'],
  toy_car: ['原地蹲下玩玩具汽车'],
  kick_shuttle: ['踢毽子'],
  rocking_horse: ['骑木马'],
  spin_top: ['抽陀螺'],
  animals: ['动物环绕'],
  butterflies: ['蝴蝶蜜蜂环绕头顶开花'],
  // —— 点击回应 ——
  tickle: ['点击回应-挠痒咯咯笑'],
  scared: ['被吓一跳'],
  // —— 时间感知待机 ——
  brush: ['晨间刷牙'],
  breakfast: ['吃早餐'],
  lunch: ['吃午餐'],
  what_to_eat: ['是啊，吃什么'],
  dinner: ['吃晚餐'],
  fan: ['摇扇纳凉'],
  watermelon: ['吃西瓜'],
  ice_cream: ['吃冰淇淋融化'],
  snowman: ['堆雪人'],
  hotpot: ['涮火锅'],
  // —— 节日彩蛋 ——
  fu: ['写福字'],
  red_packet: ['收红包'],
  dumplings: ['吃饺子'],
  fireworks: ['放烟花'],
  lion_dance: ['舞狮头'],
  rice_cake: ['吃年糕'],
  tangyuan: ['吃汤圆'],
  sky_lantern: ['放孔明灯'],
  zongzi: ['吃粽子'],
  qixi_needle: ['穿针乞巧'],
  mooncake: ['中秋赏月吃月饼'],
  chongyang: ['插茱萸赏菊'],
  chongyang_cake: ['吃重阳糕'],
  laba_porridge: ['吃腊八粥'],
  christmas_tree: ['装点圣诞树'],
  trick_treat: ['讨糖南瓜灯'],
  qingtuan: ['吃青团'],
  // —— 情绪池扩充 ——
  rage_quit: ['玩游戏气急败坏'],
  whale_slam: ['用鲸鱼尾巴拍打地面'],
  dance: ['可爱宅舞'],
  swing_dance: ['轻快摇摆舞'],
  spin_show: ['小幅度原地360度旋转展示'],
  // —— 工具任务候选 ——
  filing: ['工作状态-清点归档'],
  note_quick: ['轻快记录'],
  // —— 稀有彩蛋池(2%) ——
  whale_rise: ['蓝鲸现世'],
  whale_bubble: ['鲸鱼吐泡泡特效'],
  dove: ['变鸽子'],
  card_magic: ['扑克魔术'],
  juggle: ['三球抛接'],
  gomoku: ['下五子棋'],
  bloom: ['凭空生花'],
  eat_token: ['吃Token'],
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
