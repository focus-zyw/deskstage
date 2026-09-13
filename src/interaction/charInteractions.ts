// 角色互动 · 深模块:戳/摸头/投喂这条"轻量即时反应"链的唯一入口。
//
// 对外只有三个动作:poke(who) / headpatC() / feedC()。
// 内部隐藏:连戳滑动窗口与分级(害羞/生气)、演说打断、LLM 即兴(冷却/概率/
// 超窗丢弃/占位替换)、团宠被戳的另一角色起哄、投喂吃撑窗口与冷却、
// 台词来源(每日台词包优先 → 内置池兜底)。
// 不进 interactionStore 账本之外的情绪联动(被打断的记仇、被戳心情)留在
// 既有存储模块内,本模块只负责调用时机。
//
// 依赖边界(测试注入内存 adapter,见 tests/charInteractions.test.mjs):
//   · host:呈现与舞台事实(聚焦/说话中/演出阶段/最近台词)
//   · deps:账本/行为信号、即兴 LLM、台词包选择器、时钟与随机源——
//     默认接真实实现;测试注入确定性 rand/clock 后分级与冷却全部可断言
import type { DialogLine, Speaker } from '../performer/player'
import { improvPokeLine } from '../engine/llmClient'
import { react } from '../engine/interactionRules'
import { logInteraction, logInterrupt } from '../storage/interactionStore'
import { notePoked } from '../storage/moodStore'
import { bumpPoke } from '../storage/memoryStore'
import { takePackLine, type LineKind } from '../storage/linePackStore'
import { nameOf, pronounOf } from '../engine/persona'
import { snackActionNow } from '../stage/resident/residentManifest'

/** 戳反应池(甲乙):互怼语气;C 走团宠专属池,语气区分见各池注释 */
export const POKE_LINES = [
  '再点要收费了！',
  '诶嘿嘿~',
  '别闹，正聊着呢',
  '摸鱼被发现了？！',
  '（默默挪开半步）',
  '手滑了？再来一次试试',
  '点我有什么好玩的嘛',
]
export const SHY_LINES = [
  '（脸红）别、别一直戳啦…',
  '呜…突然这样我会不好意思的',
  '（往后缩了缩）你今天好奇怪',
]
export const ANGRY_LINES = [
  '够了！再戳我真的生气了！！',
  '（拍开你的手）烦不烦！',
  '再戳一下试试？信不信我下线！',
]

/** C(团宠)专属戳反应池:小管家的字面认真语气,与甲乙的互怼语气区分开。
 *  函数化:取用时填当前配置名(模块加载早于 setCharacterNames) */
const cPokeLines = () => [
  `（掏出小本本）此人今日戳${nameOf('C')}一次`,
  `哼，${nameOf('C')}可生气了（并没有）`,
  '（歪头）你的手…是在打招呼吗？',
  `（认真脸）再戳${nameOf('C')}就要预约了`,
  '（被戳得晃了晃）哇啊——',
]
const cShyLines = () => [
  `（鼓脸）再、再戳${nameOf('C')}就把家务全做完了！`,
  '（往后缩）你们两个都笑话我…',
  '呜…（小声）其实也没有不开心…',
]
const cAngryLines = () => [
  `（傲娇鼓脸）哼！${nameOf('C')}真的生气了！这次是真的！`,
  `（叉腰）再戳就把${nameOf('A')}${nameOf('B')}的零食全部收缴！`,
  '（转身背对，肩膀微微在抖）不理你们了！',
]
/** 摸头(长按)反应池:受用又不好意思,与"被戳"的惊讶语气区分 */
const cHeadpatLines = () => [
  '（眯眼）唔…再摸一下也不是不可以…',
  '（咯咯笑）痒、痒啦！',
  `（蹭了蹭）${nameOf('C')}的头很神奇吧`,
  '（耳朵红了）谢、谢谢夸奖…？',
  '（开心到冒泡）今天的头也是甲级！',
]
const cHeadpatShyLines = () => [
  `（脸鼓成包子）再摸要摸秃啦！${nameOf('C')}头发量有限的！`,
  '（捂头蹲下）呜哇，头要被摸平了啦…',
  '（小声）其实…可以再摸一小会儿…',
]
/** 投喂反应池:按时段端出的点心各配一句通用感谢 */
const cFeedLines = () => [
  '（双手接过）开动啦！',
  '（眼睛发亮）哇——是给我的？！',
  `（小口小口）${nameOf('C')}会好好吃完的！`,
  '（腮帮鼓鼓）唔唔…好吃…',
  '（认真）点心和快乐一起收下了！',
]
/** 连喂吃撑:中性撒娇,不进账本不记仇 */
const cStuffedLines = () => [
  '（抱着圆滚滚的肚子）唔…吃不下了，剩下的存起来…',
  '（瘫住）肚子已经变成方形了…让我缓缓…',
  '（摆手）再喂就要滚着走路了！',
]
/** 戳团宠时另一角色起哄的台词:三人舞台感(甲乙是"同伙") */
const teaseHypeLines = () => {
  const t = pronounOf('C')
  return [
    `哈哈，${t}又把小本本掏出来了`,
    `别逗了，${t}连生气都是圆的`,
    '（憋笑）你继续，我就看看',
    '哎哎，团宠被你戳蔫了，赔！',
  ]
}

/** 台词包优先取句:今日包/存档里有就弹一句(不重复),没有回内置池。
 *  导出供 App(C 右键点播等)与测试共用 */
export function packLine(kind: LineKind, pool: string[], rand: () => number = Math.random): string {
  return takePackLine(kind) ?? pool[Math.floor(rand() * pool.length)]
}

/** 连戳/吃撑计数窗口与阈值 */
const POKE_WINDOW_MS = 60_000
const SHY_AT = 2 // 窗口内第 2~4 次戳 → 害羞
const ANGRY_AT = 5 // 第 5 次起 → 生气,并不再响应直到窗口清空
const HEADPAT_SHY_AT = 3 // 摸头 60s 内第 3 次起害羞
const FEED_WINDOW_MS = 5 * 60_000
const FEED_FULL_AT = 3
const FEED_FULL_COOLDOWN_MS = 60_000
/** 轻戳走 LLM 即兴的概率与冷却;即兴返回有效期(超窗丢弃防顶掉气泡) */
const IMPROV_CHANCE = 0.3
const IMPROV_COOLDOWN_MS = 30_000
const IMPROV_TTL_MS = 4500
/** 戳团宠时另一角色延迟起哄的概率与延迟 */
const TEASE_HYPE_CHANCE = 0.3
const TEASE_HYPE_DELAY_MS = 1100

export interface InteractionHost {
  /** 呈现一句反应(气泡+动作);ms 缺省 = 舞台默认停留时长 */
  present(who: Speaker, line: string, action: string, ms?: number): void
  /** 呈现前置顶该角色(气泡与道具不被压) */
  focus(who: Speaker): void
  /** 用户活跃信号(主动行为调度) */
  onUserActive(): void
  /** 该角色正在说话(演出中被戳 = 忘词/指责打断) */
  isSpeaking(who: Speaker): boolean
  /** 演出进行中(打断分支与即兴门槛) */
  isPerforming(): boolean
  /** 空闲(即兴与起哄只在空闲插话) */
  isIdle(): boolean
  /** 导演正在放片(与 isIdle 一起构成插话安全缝判定) */
  isDirectorBusy(): boolean
  /** 最近台词(即兴提示词的上下文) */
  recentLines(): DialogLine[]
}

export interface InteractionDeps {
  bumpPoke(): void
  logInteraction(kind: 'pokeA' | 'pokeB' | 'pokeC'): void
  logInterrupt(who: Speaker): void
  notePoked(who: Speaker): void
  /** LLM 即兴台词(失败由调用方静默回落) */
  improvLine(who: Speaker, recent: DialogLine[]): Promise<string>
  /** 台词选择:每日台词包优先,内置池兜底 */
  pick(kind: LineKind, pool: string[]): string
  /** 确定性注入口(测试);缺省真实随机 */
  rand(): number
  clock: {
    now(): number
    setTimeout(fn: () => void, ms: number): () => void
  }
}

export interface CharInteractions {
  poke(who: Speaker): void
  headpatC(): void
  feedC(): void
}

export function createCharInteractions(
  host: InteractionHost,
  overrides: Partial<InteractionDeps> = {},
): CharInteractions {
  const deps: InteractionDeps = {
    bumpPoke,
    logInteraction,
    logInterrupt,
    notePoked,
    improvLine: (who, recent) => improvPokeLine(who, recent),
    pick: (kind, pool) => packLine(kind, pool, deps.rand),
    rand: Math.random,
    clock: {
      now: Date.now,
      setTimeout: (fn, ms) => {
        const id = window.setTimeout(fn, ms)
        return () => window.clearTimeout(id)
      },
    },
    ...overrides,
  }

  const pokeTimes: Record<Speaker, number[]> = { A: [], B: [], C: [] }
  const headpatTimes: number[] = []
  const feedTimes: number[] = []
  let feedFullUntil = 0
  let improvLastAt = 0

  function slideWindow(times: number[], now: number, windowMs: number): number[] {
    const kept = times.filter((t) => now - t < windowMs)
    kept.push(now)
    return kept
  }

  function pickFrom(pool: string[]): string {
    return pool[Math.floor(deps.rand() * pool.length)]
  }

  /** 戳团宠时另一角色延迟起哄:只在空闲时插话,触发时再次校验阶段 */
  function scheduleHype(who: Speaker): void {
    if (who !== 'C' || deps.rand() >= TEASE_HYPE_CHANCE) return
    const other: Speaker = deps.rand() < 0.5 ? 'A' : 'B'
    deps.clock.setTimeout(() => {
      if (!host.isIdle() || host.isDirectorBusy()) return
      host.present(other, pickFrom(teaseHypeLines()), 'laugh', 2000)
    }, TEASE_HYPE_DELAY_MS)
  }

  /** 轻戳小概率走 LLM 即兴(冷却内/演出生成中不触发);失败静默用固定台词。
   *  C 不参与即兴:她的台词由每日台词包+存档+预置池闭环供给,来源可预期 */
  function tryImprov(who: Speaker, now: number, fallback: string, fallbackAction: string): boolean {
    if (
      who === 'C' ||
      !host.isIdle() ||
      deps.rand() >= IMPROV_CHANCE ||
      now - improvLastAt < IMPROV_COOLDOWN_MS
    ) {
      return false
    }
    improvLastAt = now
    deps
      .improvLine(who, host.recentLines())
      .then((line) => {
        // 返回时已超有效期或开始正式演出 → 丢弃,防止顶掉台词气泡
        if (deps.clock.now() - now >= IMPROV_TTL_MS) return
        if (!host.isIdle() || host.isDirectorBusy()) return
        host.present(who, line, 'talk', 2200)
      })
      .catch(() => {
        if (!host.isIdle() || host.isDirectorBusy()) return
        host.present(who, fallback, fallbackAction)
      })
    // 先给一个占位反应,LLM 返回后替换
    host.present(who, '（被戳得一激灵）', 'surprise', 1200)
    return true
  }

  function poke(who: Speaker): void {
    host.onUserActive()
    host.focus(who)
    deps.bumpPoke() // 行为信号:互动频率

    // 正在说话的角色被戳:忘词/指责打断(本地即时,优先于连戳分级)
    if (host.isPerforming() && host.isSpeaking(who)) {
      host.present(who, react(who, 'interrupt'), 'surprise', 2200)
      deps.logInterrupt(who)
      deps.notePoked(who)
      return
    }
    deps.logInteraction(who === 'A' ? 'pokeA' : who === 'B' ? 'pokeB' : 'pokeC')
    deps.notePoked(who)

    // 连戳分级:滑动窗口计数,生气期内不再响应
    const now = deps.clock.now()
    const arr = (pokeTimes[who] = slideWindow(pokeTimes[who], now, POKE_WINDOW_MS))
    const count = arr.length
    // 丙走团宠专属池(台词包优先),甲乙保持互怼语气池
    const pools =
      who === 'C'
        ? { poke: cPokeLines(), shy: cShyLines(), angry: cAngryLines() }
        : { poke: POKE_LINES, shy: SHY_LINES, angry: ANGRY_LINES }
    if (count >= ANGRY_AT) {
      host.present(who, deps.pick('poke', pools.angry), 'angry', 2000)
      scheduleHype(who)
      return
    }
    const shy = count >= SHY_AT
    const fallback = shy ? pickFrom(pools.shy) : pickFrom(pools.poke)
    const fallbackAction = shy ? 'shy' : deps.rand() < 0.3 ? 'laugh' : 'talk'
    if (tryImprov(who, now, fallback, fallbackAction)) {
      scheduleHype(who)
      return
    }
    host.present(who, shy ? deps.pick('poke', pools.shy) : deps.pick('poke', pools.poke), fallbackAction)
    scheduleHype(who)
  }

  function headpatC(): void {
    host.onUserActive()
    host.focus('C')
    deps.bumpPoke()
    const now = deps.clock.now()
    const arr = slideWindow(headpatTimes, now, POKE_WINDOW_MS)
    headpatTimes.length = 0
    headpatTimes.push(...arr)
    const shy = arr.length >= HEADPAT_SHY_AT
    const line = shy ? pickFrom(cHeadpatShyLines()) : deps.pick('headpat', cHeadpatLines())
    host.present('C', line, 'headpat', 2200)
  }

  function feedC(): void {
    host.onUserActive()
    host.focus('C')
    deps.bumpPoke()
    const now = deps.clock.now()
    if (now < feedFullUntil) {
      host.present('C', pickFrom(cStuffedLines()), 'stuffed', 2200)
      return
    }
    const arr = slideWindow(feedTimes, now, FEED_WINDOW_MS)
    feedTimes.length = 0
    feedTimes.push(...arr)
    if (feedTimes.length >= FEED_FULL_AT) {
      feedFullUntil = now + FEED_FULL_COOLDOWN_MS
      host.present('C', pickFrom(cStuffedLines()), 'stuffed', 2400)
      return
    }
    // 按当下时段/季节端点心:早上早餐、午间午餐、夏天冷饮、冬天火锅(与待机时段池同口味)
    host.present('C', deps.pick('feed', cFeedLines()), snackActionNow(), 2600)
  }

  return { poke, headpatC, feedC }
}
