// 演出导演:生成、回放、选边、停止、播放器生命周期与主动行为演出的唯一归属。
// 此前 playMode/playEpisode/pickOption/stopEverything 散在 App,与播放器回调共享
// 一堆 ref(nowPlaying/pendingEpisode/generateAbort/lastLines...)。现在:
// - React 侧拿到一个小接口(play/replay/choose/stop + choice 快照)
// - 播放器回调把"逐句呈现"委托给 ActorPresenter,自己只管推进与记账
// - 停止清场顺序固定:外围清场 → 记账(跳过/忽略)→ 中止生成 → 停播 → 停语音 → 复位
import { useEffect, useRef, useState } from 'react'
import {
  PerformancePlayer,
  bubbleDuration,
  MIN_READABLE_MS,
  FIRST_AUDIO_DEADLINE_MS,
  planLinePresentation,
  type ChoiceOption,
  type ChoicePoint,
  type DialogLine,
} from '../performer/player'
import { deliverySpeed, type SceneCard, type Speaker } from '../performer/dialogSchema'
import { modeOf, type Mode } from '../performer/modes'
import {
  generateShortChat,
  generateInterjectionBatch,
  describeLlmError,
} from '../engine/llmClient'
import { dialogue, newEpisodeId } from '../dialogue/director'
import { planInterjectionTakeover, keepChoiceOpts } from '../dialogue/interjection'
import { pushTurn, chatWindow } from '../dialogue/turnWindow'
import { nameOf } from '../engine/persona'
import { recentMoodHint } from '../engine/moodState'
import { noteEpisodeAbandoned } from '../storage/moodStore'
import type { CurateReport } from '../engine/storyCurator'
import { listEpisodes, loadRecentHistory, type Episode, type TopicRef } from '../storage/historyStore'
import {
  peekCompatiblePrefetch,
  dropPrefetchEntry,
  type PrefetchCheck,
} from '../storage/prefetchStore'
import { getStory } from '../storage/storyStore'
import { bumpMode } from '../storage/memoryStore'
import { logDismiss, type DismissableKind } from '../storage/interactionStore'
import { getConfig } from '../storage/configStore'
import { prefetchNext } from '../engine/dialogPrefetch'
import { isFullscreenApp } from '../engine/envAware'
import { topicDirector } from '../topic/director'
import {
  banHashOf,
  fingerprintOf,
  modeHashOf,
  PLANNER_VERSION,
} from '../topic/planner'
import { getTopicState } from '../topic/store'
import { maybeRestockTopicCandidates } from '../topic/discovery'
import type { TopicDuration, TopicIntent, TopicPlan, TopicRequest, TopicDistance } from '../topic/types'
import {
  beginPerforming,
  setMode as setRuntimeMode,
  useRuntime,
  type RuntimeMode,
} from './runtimeMode'
import { startScheduler, noteSpontaneous } from './proactiveScheduler'
import { speakTracked, stopSpeaking, prefetchVoice } from '../engine/tts'
import type { ActorPresenter } from '../stage/useActorPresenter'

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms))

/** 保底收底留白:未走二遍节奏标注的集,最后一句自动补 1s 停顿,给响底包袱留笑的时间 */
function withFinalePause(lines: DialogLine[]): DialogLine[] {
  if (lines.length === 0) return lines
  const last = lines[lines.length - 1]
  if (last.pauseAfter !== undefined) return lines
  return [...lines.slice(0, -1), { ...last, pauseAfter: 1000 }]
}

export interface PerformanceDirectorDeps {
  presenter: Pick<ActorPresenter, 'say' | 'showTalk' | 'hush' | 'endLine' | 'settle' | 'reset' | 'setPose'>
  /** 此刻是否空闲(异步回调里判断是否仍空闲的守卫) */
  isIdle(): boolean
  /** 点播 'live' 模式时转交主播模式(连接弹幕源) */
  onLive(): void
  /** 停止时的外围清场:下播、道具清空、用户气泡等 */
  teardown(): void
  /** 新生成的集自然播完并由 DialogueDirector 提交(历史+蒸馏)后的 UI 刷新(可选) */
  onEpisodeCommitted?(report: CurateReport): void
  /** 新生成的集自然播完(完播信号,不等蒸馏完成):供 App 弹"这集怎么样"评价条。
   *  回放/中止不触发——中途退场还问好不好很讨嫌 */
  onEpisodeEnd?(info: { eid: string; mode: Mode; topic: string; plan?: TopicPlan }): void
  /** 到点备忘扫描(调度器每 tick 调,幂等) */
  sweepMemos(): Promise<void>
}

/** 点播请求:一次性话题/会话动作/跳跃距离/持续时间(缺省走导演自动决策) */
export interface PlayRequest {
  topic?: string
  intent?: TopicIntent
  distance?: TopicDistance
  duration?: TopicDuration
  strict?: boolean
}

/** 正在播出的集:话题/台词/进度/信号来源,供完播/跳过记账 */
interface NowPlaying {
  topic?: string
  lines?: DialogLine[]
  total: number
  index: number
  source: 'auto' | 'manual' | 'gen'
}

export function usePerformanceDirector(deps: PerformanceDirectorDeps) {
  const [choice, setChoice] = useState<ChoicePoint | null>(null)
  const choiceTimer = useRef(0)
  // 已开播待提交的集:单次落盘——完播提交完整真实路径(playedAccum,含插话反应),
  // 中止提交已播前缀。choice/after 留存以便"插话接回"后继续未消费的抉择点
  const pendingEpisode = useRef<{ eid: string; card?: SceneCard; before: DialogLine[]; after: Record<string, DialogLine[]>; choice?: ChoicePoint; playedAccum: DialogLine[]; mode: Mode; topic: string; topicRef?: TopicRef; plan?: TopicPlan; chosen?: string } | null>(null)
  // 演出中的用户插话队列:onLineEnd 安全缝处消费(反应回合后接回原剧本)
  const interjectionQueue = useRef<{ text: string; target?: Speaker }[]>([])
  const handoff = useRef(false) // 接回换场中:onStopped 跳过中止提交
  const interjectBusy = useRef(false)
  // 上一段台词(内存中),续播/即兴时喂给 LLM 做衔接;上次自动重放的集,连续重放时避开
  const lastLines = useRef<DialogLine[]>([])
  const lastReplayTs = useRef(0)
  const nowPlaying = useRef<NowPlaying | null>(null)
  // 正在播的主动行为(供"提前掐断 = 负反馈"记账);onDone/stop 清
  const proactiveAct = useRef<{ kind: DismissableKind; since: number } | null>(null)
  const generateAbort = useRef<AbortController | null>(null)
  // 当前正在播放的台词数组,供 onLineStart 回调预合成下一句语音
  const playingLines = useRef<DialogLine[]>([])

  // 演出播放器:逐句呈现委托给 ActorPresenter,这里只管推进节奏与记账
  const player = useRef<PerformancePlayer | null>(null)
  if (!player.current) {
    player.current = new PerformancePlayer({
      onStart: (first) => {
        // 开播即预取第一句语音,消除首句文字先行
        prefetchVoice(first.speaker, first.text, first.delivery)
      },
      onLineStart: (line, index) => {
        if (nowPlaying.current) nowPlaying.current.index = index
        pendingEpisode.current?.playedAccum.push(line) // 真实已播路径:跨接回播放持续累计
        const handle = speakTracked(line.speaker, line.text, line.delivery, 'performance')
        const next = playingLines.current[index + 1]
        if (next) prefetchVoice(next.speaker, next.text, next.delivery)
        const estimate = Math.round(bubbleDuration(line.text) / deliverySpeed(line.delivery))
        let speechPhase: Promise<void>
        if (!handle) {
          deps.presenter.showTalk(line) // 被更高优先级压制:纯文本节奏
          speechPhase = sleepMs(estimate)
        } else {
          // 首声截止:超时取消本句 TTS 按纯文本播,杜绝迟到语音突然插入
          let deadlineTimer = 0
          speechPhase = Promise.race([
            handle.started,
            new Promise<'timeout'>((resolve) => {
              deadlineTimer = window.setTimeout(() => resolve('timeout'), FIRST_AUDIO_DEADLINE_MS)
            }),
          ]).then((res) => {
            window.clearTimeout(deadlineTimer)
            deps.presenter.showTalk(line) // 无论声音是否赶上截止,台词与表情都必须上屏
            const plan = planLinePresentation(res, estimate)
            if (plan.stopTts) handle.stop() // 首声超时:取消本句,按纯文本节奏走
            if (plan.textDurationMs !== null) return sleepMs(plan.textDurationMs) // 静音/超时:纯文本节奏
            return Promise.all([
              sleepMs(MIN_READABLE_MS),
              Promise.race([handle.ended, sleepMs(estimate + 8000)]),
            ]).then(() => {})
          })
        }
        return { speechPhase }
      },
      onSpeechEnd: deps.presenter.hush,
      onLineEnd: (speaker) => {
        deps.presenter.endLine(speaker)
        void maybeConsumeInterjection() // 句尾安全缝:有插话排队就在这里接管(P4)
      },
      onChoice: (cp) => {
        setChoice(cp)
        setRuntimeMode({ type: 'choosing', choiceId: String(Date.now()) })
      },
      onDone: () => {
        // 单次落盘:提交完整真实已播路径(playedAccum:铺垫+分支+插话反应);中止路径见 onStopped
        const p = pendingEpisode.current
        const fullPath = p?.playedAccum ?? null
        if (p?.chosen) {
          const branchLines = p.after[p.chosen] ?? []
          nowPlaying.current = { topic: p.topic, lines: branchLines, total: branchLines.length, index: -1, source: 'gen' }
        }
        if (p && fullPath && fullPath.length > 0) {
          lastLines.current = fullPath // 续播衔接上下文升级为完整路径(选边集原先是前半段)
          deps.onEpisodeEnd?.({ eid: p.eid, mode: p.mode, topic: p.topic, plan: p.plan })
          void dialogue
            .commitEpisode({ eid: p.eid, mode: p.mode, topic: p.topic, card: p.card, played: fullPath, natural: true, topicRef: p.topicRef })
            .then((report) => {
              if (report) deps.onEpisodeCommitted?.(report)
            })
        }
        pendingEpisode.current = null
        proactiveAct.current = null // 自然播完不算忽略
        setRuntimeMode({ type: 'idle' })
        // 看完一集 = 话题正信号(唯一写入口 TopicDirector.record;eid 无信号则自动 no-op,
        // 自动重放/回放没有 started 信号,天然不记)。完播后后台视池量补货(AI 发现默认关)
        if (p) {
          void topicDirector.record({ type: 'completed', eid: p.eid })
          void maybeRestockTopicCandidates()
        }
        nowPlaying.current = null
        // 收底拍:响底台词与表情定格 2.6s 给观众笑的时间,然后全员放松回 idle
        deps.presenter.settle(2600)
      },
      onStopped: () => {
        // 接回换场:播放权交给"反应回合+剩余剧本",不动账、不提交
        if (handoff.current) return
        // 中止提交:同一集只落真实播出过的前缀(playedAccum,eid 不变);不蒸馏、不推进剧情——仅自然完播走 onDone。
        // 回放/短聊天被打断时 pendingEpisode 为空,自然跳过
        const p = pendingEpisode.current
        if (p && p.playedAccum.length > 0) {
          void dialogue.commitEpisode({ eid: p.eid, mode: p.mode, topic: p.topic, card: p.card, played: p.playedAccum, natural: false, topicRef: p.topicRef })
          lastLines.current = p.playedAccum
        }
        pendingEpisode.current = null
      },
    })
  }

  /** 播放器是否在播(即兴/翻译搭腔/备忘讨论的抢场守卫) */
  function isPlaying(): boolean {
    return player.current!.playing
  }

  /** 续播衔接用的最近台词(即兴吐槽/备忘讨论注入上下文) */
  function recentLines(): DialogLine[] {
    return lastLines.current
  }

  /** 开播前清场:作废在途生成 + 停播 + 停语音 + 舞台复位(不清记账,不算"停止") */
  function abortPending(): void {
    generateAbort.current?.abort()
    player.current!.stop()
    stopSpeaking()
    deps.presenter.reset()
  }

  /** 播放指定的一集(自动重放与历史行点击共用):不调 LLM、不写历史。
   *  回放是旧集重演,不进话题账(V2:回放信号退役,口味只看新集反馈) */
  function replay(ep: Episode, source: 'auto' | 'manual') {
    generateAbort.current?.abort() // 若有生成在途,直接作废
    player.current!.stop()
    stopSpeaking()
    lastReplayTs.current = ep.ts
    lastLines.current = ep.lines // 衔接后续手动生成
    nowPlaying.current = { topic: ep.topic, lines: ep.lines, total: ep.lines.length, index: -1, source }
    deps.presenter.reset()
    beginPerforming()
    playingLines.current = ep.lines
    player.current!.play(withFinalePause(ep.lines), { gap: modeOf(ep.mode).gap })
  }

  /** 加权随机抽一集历史重放(收藏权重 5):不调 LLM、不写历史。返回是否真的播了(调度器记账用) */
  async function autoReplay(): Promise<boolean> {
    if (player.current!.playing) return false
    if (isFullscreenApp()) return false // 用户在全屏应用(视频/游戏/演示)里,别打扰
    const eps = await listEpisodes(100)
    // 读历史(可能数百 ms)期间用户点了生成/聊天 → 不抢场
    if (!deps.isIdle() || player.current!.playing) return false
    if (eps.length === 0) return false
    const pool = eps.length > 1 ? eps.filter((e) => e.ts !== lastReplayTs.current) : eps
    const bag: Episode[] = []
    for (const e of pool) {
      for (let i = 0; i < (e.fav ? 5 : 1); i++) bag.push(e)
    }
    const ep = bag[Math.floor(Math.random() * bag.length)]
    proactiveAct.current = { kind: 'replay', since: Date.now() }
    replay(ep, 'auto')
    return true
  }

  /** 观众选边:播对应分支并补记历史;30s 未选由 effect 自动随机 */
  function choose(option: ChoiceOption) {
    window.clearTimeout(choiceTimer.current)
    setChoice(null)
    beginPerforming()
    if (pendingEpisode.current) pendingEpisode.current.chosen = option.id
    playingLines.current = pendingEpisode.current?.after[option.id] ?? []
    nowPlaying.current = {
      topic: pendingEpisode.current?.topic ?? '',
      lines: playingLines.current,
      total: playingLines.current.length,
      index: -1,
      source: 'gen',
    }
    player.current!.resume(option.id)
    try { localStorage.setItem('vc-lastChoice', option.label) } catch { /* ignore */ }
  }

  /** 演出中插话入队(P4):当前句结束的安全缝(onLineEnd)处消费 */
  function queueInterjection(text: string, target?: Speaker): void {
    const t = text.trim()
    if (t) interjectionQueue.current.push({ text: t, target })
  }

  /** 安全缝消费:句尾停播(handoff 标记下 onStopped 跳过中止提交)→ 生成 1~3 句
   *  反应回合 → 接回剩余原剧本(未消费的抉择点原样保留)。整集仍单次落盘:
   *  playedAccum 已累计含反应回合的完整真实路径 */
  async function maybeConsumeInterjection(): Promise<void> {
    if (interjectBusy.current || handoff.current) return
    if (!interjectionQueue.current.length || !pendingEpisode.current) return
    if (!player.current!.playing) return // 抉择等待等非播放态不接缝
    const msg = interjectionQueue.current.shift()!
    const p = pendingEpisode.current
    const index = nowPlaying.current?.index ?? -1
    interjectBusy.current = true
    handoff.current = true
    try {
      player.current!.stop() // 安全缝停播(onStopped 被 handoff 跳过)
      stopSpeaking() // 防 TTS 重叠
      const speakerOf = (l: DialogLine) => nameOf(l.speaker)
      // 插话未指定对象时:归当前说话者的对手戏搭档;当前是 C 或无上下文时给甲
      const defaultTarget = (): Speaker => {
        const cur = playingLines.current[index]?.speaker
        if (cur === 'A') return 'B'
        if (cur === 'B') return 'A'
        return 'A'
      }
      let reaction: DialogLine[] = []
      try {
        reaction = await generateInterjectionBatch({
          userText: msg.text,
          target: msg.target ?? defaultTarget(),
          recentPlayed: p.playedAccum.slice(-3).map((l) => `${speakerOf(l)}:${l.text}`),
          bridgeTo: playingLines.current[index + 1]?.text ?? '',
          moodHint: recentMoodHint(p.playedAccum) || undefined,
          window: chatWindow(),
        })
      } catch {
        reaction = [] // 生成失败:跳过反应直接续播,不卡演出
      }
      const plan = planInterjectionTakeover({
        reaction,
        playingLines: playingLines.current,
        index,
        chosen: !!p.chosen,
      })
      for (const l of reaction) {
        pushTurn({ who: l.speaker, text: l.text })
      }
      if (plan.list.length === 0) {
        // 理论不可达(每段最后一句不触发 onLineEnd);保险收尾避免卡死在 performing
        pendingEpisode.current = null
        setRuntimeMode({ type: 'idle' })
        return
      }
      nowPlaying.current = { topic: p.topic, lines: plan.list, total: plan.list.length, index: -1, source: 'gen' }
      playingLines.current = plan.list
      beginPerforming()
      player.current!.play(plan.list, {
        gap: modeOf(p.mode).gap,
        choice: keepChoiceOpts(!!p.chosen, p.choice),
        after: keepChoiceOpts(!!p.chosen, p.after),
      })
    } finally {
      handoff.current = false
      interjectBusy.current = false
    }
  }

  // 抉择 30s 超时:自动随机选边,防止演出卡死
  const modeType = useRuntime().mode.type
  useEffect(() => {
    if (modeType !== 'choosing' || !choice) return
    const t = window.setTimeout(() => {
      const opt = choice.options[Math.floor(Math.random() * choice.options.length)]
      choose(opt)
    }, 30_000)
    return () => window.clearTimeout(t)
    // choose 是组件内函数声明,行为恒定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modeType, choice])

  /** 播出一段短聊天:开场先挥手;可选计入历史。短聊天无话题,清掉残留避免误记上一集 */
  function playShortChat(lines: DialogLine[], opts: { history?: boolean } = {}) {
    lastLines.current = lines
    playingLines.current = lines
    nowPlaying.current = null
    deps.presenter.setPose('A', 'wave')
    deps.presenter.setPose('B', 'wave')
    window.setTimeout(() => {
      beginPerforming()
      player.current!.play(lines, { gap: 700 })
      if (opts.history) dialogue.commitShortChat(lines)
    }, 900)
  }

  /** 自发短聊天:调度器闸门(空闲时长/冷却/配额/勿扰)已过,这里只做最后防御检查与执行。返回是否真的播了 */
  async function spontaneous(): Promise<boolean> {
    if (!deps.isIdle() || player.current!.playing) return false
    const cfg = await getConfig()
    if (!cfg.apiKey.trim()) return false
    try {
      const lines = await generateShortChat('spontaneous', lastLines.current)
      if (!deps.isIdle() || player.current!.playing) return false
      if (lines.length === 0) return false
      proactiveAct.current = { kind: 'spontaneous', since: Date.now() }
      playShortChat(lines)
      return true
    } catch {
      return false // 生成失败静默——自发内容宁可错过
    }
  }

  /** 久坐提醒:调度器已算好工作时长/冷却/守卫,这里只负责生成提醒并播出。返回是否提醒了 */
  async function breakRemind(): Promise<boolean> {
    if (!deps.isIdle() || player.current!.playing) return false
    try {
      const lines = await generateShortChat('break', lastLines.current)
      if (!deps.isIdle() || player.current!.playing || lines.length === 0) return false
      lastLines.current = lines
      playingLines.current = lines
      proactiveAct.current = { kind: 'break', since: Date.now() }
      beginPerforming()
      deps.presenter.setPose('C', 'stretch') // 团宠跟着一起伸懒腰
      player.current!.play(lines, { gap: 700 })
      return true
    } catch {
      return false // 静默:提醒宁可错过
    }
  }

  /** 备忘到点后的甲乙讨论(幂等守卫在调用方):空闲才插播,不写历史 */
  function discuss(lines: DialogLine[]): boolean {
    if (!deps.isIdle() || player.current!.playing || lines.length === 0) return false
    lastLines.current = lines
    playingLines.current = lines
    beginPerforming()
    player.current!.play(lines, { gap: 700 })
    return true
  }

  // 主动行为调度器:备忘扫描/久坐/重放/自发的统一定时、优先级与配额
  useEffect(() => {
    return startScheduler({ sweepMemos: deps.sweepMemos, breakRemind, autoReplay, spontaneous })
    // deps 是组件内函数声明,行为恒定;首帧闭包即可(内部只依赖 ref 与模块函数)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 启动问候:打开应用时按当前时段打招呼(失败静默);占用自发聊天的预算 */
  const greeted = useRef(false)
  useEffect(() => {
    if (greeted.current) return
    greeted.current = true
    void (async () => {
      const cfg = await getConfig()
      if (!cfg.apiKey.trim()) return
      try {
        const lines = await generateShortChat('greeting', lastLines.current)
        if (!deps.isIdle() || player.current!.playing) return
        if (lines.length === 0) return
        noteSpontaneous(Date.now() - 14 * 60_000) // 问候后约 1 分钟起,自发聊天才可用
        playShortChat(lines)
      } catch {
        // 问候失败静默
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 启动恢复:读最近历史,续集生成/即兴时衔接上次聊到的内容
  useEffect(() => {
    void loadRecentHistory(20).then((entries) => {
      if (entries.length > 0) {
        lastLines.current = entries.map(({ ts: _ts, mode: _m, ...l }) => l)
      }
    })
  }, [])

  /** 缓存兼容令牌:话题域 revision/雷区/模式内容/最近指纹/剧情拍号共同决定旧缓存可否消费 */
  async function buildPrefetchCheck(
    cfg: Awaited<ReturnType<typeof getConfig>>,
    mode: Mode,
    manualTopic?: string,
    intent?: TopicIntent,
  ): Promise<PrefetchCheck> {
    const state = await getTopicState()
    const arcStages: Record<string, number> = {}
    try {
      const story = await getStory()
      for (const a of story.arcs) {
        if (a.status === 'active') arcStages[a.id] = a.stage
      }
    } catch {
      // 故事读取失败:剧情缓存条目自然不兼容,不影响普通条目
    }
    return {
      intent: intent ?? 'new',
      ...(manualTopic ? { manualFingerprint: fingerprintOf(manualTopic) } : {}),
      sessionRevision: state.revision,
      banHash: banHashOf(cfg.userProfile.banTopics),
      modeHash: modeHashOf(modeOf(mode)),
      plannerVersion: PLANNER_VERSION,
      recentFingerprints: state.recent.map((r) => r.fingerprint),
      arcStages,
      now: Date.now(),
    }
  }

  /** 单次点播:先采纳兼容预生成缓存(秒开,CAS 成功才消费),未命中则
   *  规划(plan 零副作用)→ 生成 → 采纳(adopt CAS)→ 开播 → 后台预生成下一轮。
   *  arg = 一次性话题字符串(命令面板"来一段关于X的相声")或完整点播请求 */
  async function play(m: Mode, arg?: string | PlayRequest) {
    // 主播模式不走剧本链路:开播 = 连弹幕源 + 事件驱动单句回复
    if (m === 'live') {
      deps.onLive()
      return
    }
    // API Key 与网页模型至少配一个:都没有才不进生成流程,气泡引导去设置
    // (只开网页模型不填 Key 是合法形态:主演出走网页,失败回落内置剧本)
    const cfg = await getConfig()
    if (!cfg.apiKey.trim() && !cfg.webchatEnabled) {
      deps.presenter.say('A', '还没填 API Key,或到设置里开启网页模型生成~', { action: 'surprise', ms: 2600 })
      return
    }

    generateAbort.current?.abort()
    player.current!.stop()
    stopSpeaking()
    deps.presenter.reset()

    const req0: PlayRequest = typeof arg === 'string' ? { topic: arg } : (arg ?? {})
    bumpMode(m)

    // ① 缓存优先:peek 兼容条目 → adopt(topicPlan) CAS → adopted 才删缓存开播;
    //    stale 丢弃缓存(永久作废)走下方规划,绝不误播旧计划
    const manualTopic = req0.topic
    const check = await buildPrefetchCheck(cfg, m, manualTopic, req0.intent)
    const entry = await peekCompatiblePrefetch(m, check)
    if (entry) {
      const adoptRes = await topicDirector.adopt(entry.topicPlan)
      if (adoptRes.status === 'adopted') {
        await dropPrefetchEntry(entry)
        const hitScript = entry.script
        const hitPlan = entry.topicPlan
        const eid = newEpisodeId()
        // 开播记账:started = 旧"seen"(剧情拍不入话题账;反馈唯一写入口)
        if (hitPlan.lane !== 'story') void topicDirector.record({ type: 'started', eid, plan: hitPlan })
        // 真正开播:采纳预生成时暂缓的上下文副作用(注入冷却补记/recap 消费)
        dialogue.adoptDeferred(hitScript)
        nowPlaying.current = { topic: hitPlan.card.title, lines: hitScript.before, total: hitScript.before.length, index: -1, source: 'gen' }
        lastLines.current = hitScript.before
        // 使用后即移出预取缓存;历史在完播/中止时按 eid 一次性提交(onDone/onStopped)
        pendingEpisode.current = {
          eid,
          card: hitScript.card,
          before: hitScript.before,
          after: hitScript.after,
          choice: hitScript.choice,
          playedAccum: [],
          mode: m,
          topic: hitPlan.card.title,
          plan: hitPlan,
          topicRef: {
            fingerprint: hitPlan.card.fingerprint,
            category: hitPlan.card.category,
            source: hitPlan.card.source,
          },
        }
        beginPerforming()
        playingLines.current = hitScript.before
        player.current!.play(withFinalePause(hitScript.before), {
          gap: modeOf(entry.mode).gap,
          choice: hitScript.choice,
          after: Object.fromEntries(
            Object.entries(hitScript.after).map(([id, seg]) => [id, withFinalePause(seg)]),
          ),
        })
        // 当前剧情拍在完播蒸馏前仍占用,补货时不能再次生成同一拍
        void prefetchNext(m, hitScript.before, {
          excludeArcIds: entry.arc ? [entry.arc.id] : [],
        })
        return
      }
      // stale:该条永久失效,丢弃(缓存至多消费一次:冲突允许浪费,不允许误播)
      await dropPrefetchEntry(entry)
    }

    // ② 规划(零副作用):手动话题 > 会话推进 > 剧情拍 30% > 动态评分,全在 director 内
    const topicRequest: TopicRequest = { mode: m }
    if (req0.intent) topicRequest.intent = req0.intent
    if (req0.distance) topicRequest.distance = req0.distance
    if (req0.duration) topicRequest.duration = req0.duration
    if (manualTopic) {
      topicRequest.manualTopic = manualTopic
      if (req0.strict) topicRequest.strict = true
    }
    const plan = await topicDirector.plan(topicRequest)

    // 未命中:生成当前轮(等待期三人进入思考姿势)
    deps.presenter.setPose('A', 'thinking')
    deps.presenter.setPose('B', 'thinking')
    deps.presenter.setPose('C', 'thinking')
    setRuntimeMode({ type: 'generating' })
    const ctrl = new AbortController()
    generateAbort.current = ctrl
    try {
      const { script, eid } = await dialogue.prepareEpisode({
        mode: m,
        topicPlan: plan,
        recentLines: lastLines.current,
        signal: ctrl.signal,
      })
      if (ctrl.signal.aborted) {
        topicDirector.release(plan.planId) // 中止:剧本没播,不采纳不留幽灵话题
        return
      }
      // 采纳在剧本通过校验之后、开播之前:CAS 推进会话/recent;stale = 并发已接管
      const adoptRes = await topicDirector.adopt(plan)
      if (adoptRes.status === 'stale') {
        topicDirector.release(plan.planId) // 幂等(adopt 已收束)
        return
      }
      if (plan.lane !== 'story') void topicDirector.record({ type: 'started', eid, plan })
      nowPlaying.current = { topic: plan.card.title, lines: script.before, total: script.before.length, index: -1, source: 'gen' }
      lastLines.current = script.before
      // 单次落盘:不再生成时先记前半段;完播提交完整路径,中止提交已播前缀(onDone/onStopped)
      pendingEpisode.current = {
        eid,
        card: script.card,
        before: script.before,
        after: script.after,
        choice: script.choice,
        playedAccum: [],
        mode: m,
        topic: plan.card.title,
        plan,
        topicRef: {
          fingerprint: plan.card.fingerprint,
          category: plan.card.category,
          source: plan.card.source,
        },
      }
      beginPerforming()
      playingLines.current = script.before
      player.current!.play(withFinalePause(script.before), {
        gap: modeOf(m).gap,
        choice: script.choice,
        after: Object.fromEntries(
          Object.entries(script.after).map(([id, seg]) => [id, withFinalePause(seg)]),
        ),
      })
      void prefetchNext(m, script.before, {
        excludeArcIds: plan.story ? [plan.story.arcId] : [],
      }) // 请求生成两轮：当前轮 + 后台预生成
    } catch (e) {
      topicDirector.release(plan.planId) // 生成失败:释放故事预约,不采纳(无幽灵话题)
      if (ctrl.signal.aborted) return
      console.error('LLM 生成失败，回退硬编码脚本', e)
      lastLines.current = modeOf(m).script
      nowPlaying.current = null // 兜底剧本与抽中的话题无关,不参与看完/跳过记账
      beginPerforming()
      // 先出提示气泡(带具体原因),短暂停留后再开播,避免被第一句台词立即覆盖
      const reason = await describeLlmError(e)
      if (ctrl.signal.aborted) return
      deps.presenter.say('A', `${reason},先来段内置的~`, { ms: 1800 })
      window.setTimeout(() => {
        if (ctrl.signal.aborted) return // 停止/切换期间不续播
        deps.presenter.reset()
        playingLines.current = modeOf(m).script
        player.current!.play(modeOf(m).script, { gap: modeOf(m).gap })
      }, 1800)
    }
  }

  /** 停止一切:外围清场(下播/道具)→ 记账(跳过/忽略)→ 中止生成 → 停播 → 停语音 → 复位 */
  function stop() {
    deps.teardown()
    // 中途按停止 = 负反馈事件(唯一写入口 TopicDirector.record;≥80% 由其内部视为看完,不罚);
    // 正在生成时无账可记
    const np = nowPlaying.current
    const pe = pendingEpisode.current
    if (np && pe && np.total > 0) {
      const progress = np.index / np.total
      void topicDirector.record({ type: 'skipped', eid: pe.eid, progress })
      // 没看完就走:台上最后说话的角色心情小幅变差(确定性小步,失败静默)
      if (progress < 0.8) {
        const lastLine = np.lines?.[Math.min(np.index, np.lines.length - 1)]
        if (lastLine) void noteEpisodeAbandoned(lastLine.speaker)
      }
    }
    // 主动行为(重放/自发/久坐提醒)开播 15s 内就被掐 → 记一次忽略;连续 3 次该类冷却翻倍
    const act = proactiveAct.current
    if (act && Date.now() - act.since < 15_000) void logDismiss(act.kind)
    proactiveAct.current = null
    nowPlaying.current = null
    generateAbort.current?.abort()
    generateAbort.current = null
    player.current!.stop()
    stopSpeaking()
    setRuntimeMode({ type: 'idle' })
    setChoice(null)
    window.clearTimeout(choiceTimer.current)
    deps.presenter.reset()
  }

  return {
    choice,
    play,
    replay,
    choose,
    stop,
    abortPending,
    autoReplay,
    spontaneous,
    breakRemind,
    discuss,
    playShortChat,
    queueInterjection,
    isPlaying,
    recentLines,
  }
}

export type PerformanceDirector = ReturnType<typeof usePerformanceDirector>
export type { RuntimeMode }
