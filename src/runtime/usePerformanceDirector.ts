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
import { deliverySpeed, type SceneCard } from '../performer/dialogSchema'
import { MODES, modeOf, type Mode } from '../performer/modes'
import {
  generateDialog,
  generateShortChat,
  describeLlmError,
  adoptDeferredContext,
} from '../engine/llmClient'
import { appendHistory, listEpisodes, loadRecentHistory, newEpisodeId, type Episode } from '../storage/historyStore'
import { takePrefetch, listPrefetchedArcIds } from '../storage/prefetchStore'
import { reserveArcBeat } from '../engine/arcReservation'
import { getStory } from '../storage/storyStore'
import {
  bumpTopicSeen,
  bumpTopicReplays,
  bumpTopicWatched,
  bumpTopicSkipped,
  bumpMode,
  getTopicWeights,
} from '../storage/memoryStore'
import { logDismiss, type DismissableKind } from '../storage/interactionStore'
import { getConfig } from '../storage/configStore'
import { prefetchNext } from '../engine/dialogPrefetch'
import { pickTopic } from '../engine/topicSeeds'
import { isFullscreenApp } from '../engine/envAware'
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
  /** 手动锁定的聊天主题(null = 随机) */
  getTopicOverride(): string | null
  /** 使用者画像兴趣分割后的候选(点播抽题用) */
  getInterests(): string[]
  /** 点播 'live' 模式时转交主播模式(连接弹幕源) */
  onLive(): void
  /** 停止时的外围清场:下播、道具清空、用户气泡等 */
  teardown(): void
  /** 新生成的集自然播完后的蒸馏(没看完不蒸馏,回放不重复蒸馏);meta.eid 供关系事件记账 */
  onEpisodeCompleted(lines: DialogLine[], meta?: { eid?: string }): void
  /** 到点备忘扫描(调度器每 tick 调,幂等) */
  sweepMemos(): Promise<void>
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
  // 已开播待提交的集:单次落盘——完播提交完整路径,中止提交已播前缀(见 onDone/onStopped)
  const pendingEpisode = useRef<{ eid: string; card?: SceneCard; before: DialogLine[]; after: Record<string, DialogLine[]>; mode: Mode; topic: string; chosen?: string } | null>(null)
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
      onLineEnd: deps.presenter.endLine,
      onChoice: (cp) => {
        setChoice(cp)
        setRuntimeMode({ type: 'choosing', choiceId: String(Date.now()) })
      },
      onDone: () => {
        // 单次落盘:一次提交完整已播路径(铺垫+所选分支);中止路径见 onStopped
        const p = pendingEpisode.current
        let fullPath: DialogLine[] | null = null
        if (p?.chosen) {
          const branchLines = p.after[p.chosen] ?? []
          fullPath = [...p.before, ...branchLines]
          nowPlaying.current = { topic: p.topic, lines: branchLines, total: branchLines.length, index: -1, source: 'gen' }
        } else if (p) {
          fullPath = p.before
        }
        if (p && fullPath) {
          void appendHistory(fullPath, p.mode, { topic: p.topic, card: p.card, eid: p.eid })
          lastLines.current = fullPath // 续播衔接上下文升级为完整路径(选边集原先是前半段)
        }
        pendingEpisode.current = null
        proactiveAct.current = null // 自然播完不算忽略
        setRuntimeMode({ type: 'idle' })
        // 看完一集 = 弱正信号;自动重放是系统行为不计偏好,防"系统自播→自我强化"污染
        const np = nowPlaying.current
        if (np && np.source !== 'auto') bumpTopicWatched(np.topic)
        // 新生成的集自然播完后才蒸馏角色世界:没看完不记,回放不重复蒸馏
        if (np && np.source === 'gen' && np.lines) deps.onEpisodeCompleted(fullPath ?? np.lines, p ? { eid: p.eid } : undefined)
        nowPlaying.current = null
        // 收底拍:响底台词与表情定格 2.6s 给观众笑的时间,然后全员放松回 idle
        deps.presenter.settle(2600)
      },
      onStopped: (played) => {
        // 中止提交:同一集只落真实播出过的前缀(eid 不变);不蒸馏、不推进剧情——仅自然完播走 onDone。
        // 回放/短聊天被打断时 pendingEpisode 为空,自然跳过
        const p = pendingEpisode.current
        if (p && played.length > 0) {
          void appendHistory(played, p.mode, { topic: p.topic, card: p.card, eid: p.eid })
          lastLines.current = played
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

  /** 播放指定的一集(自动重放与历史行点击共用):不调 LLM、不写历史 */
  function replay(ep: Episode, source: 'auto' | 'manual') {
    generateAbort.current?.abort() // 若有生成在途,直接作废
    player.current!.stop()
    stopSpeaking()
    lastReplayTs.current = ep.ts
    lastLines.current = ep.lines // 衔接后续手动生成
    // 仅手动回放是口味正反馈;空闲自动重放是系统行为,计进去会让权重自我强化
    if (source === 'manual') bumpTopicReplays(ep.topic)
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
      if (opts.history) void appendHistory(lines, 'daily')
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

  /** 单次点播：优先消费预生成(秒开,使用后移入 history);
   *  未命中则生成当前轮,开播后后台再静默预生成下一轮(共两轮)。
   *  topicArg = 一次性话题(命令面板"来一段关于X的相声"),不落盘不锁主题 */
  async function play(m: Mode, topicArg?: string) {
    // 主播模式不走剧本链路:开播 = 连弹幕源 + 事件驱动单句回复
    if (m === 'live') {
      deps.onLive()
      return
    }
    // 未配置 API Key:不进生成流程,气泡引导去设置
    const cfg = await getConfig()
    if (!cfg.apiKey.trim()) {
      deps.presenter.say('A', '还没填 API Key,点 ⚙ 去设置里填一下~', { action: 'surprise', ms: 2600 })
      return
    }

    generateAbort.current?.abort()
    player.current!.stop()
    stopSpeaking()
    deps.presenter.reset()

    // 主题:一次性话题(参数) > 手动锁定 > 连续剧情 > 使用者兴趣 > 话题池随机。
    // 先消费预生成再选新题，避免抽到一条剧情拍后却因缓存命中而白占用。
    const fixedTopic = topicArg ?? deps.getTopicOverride()
    const interests = deps.getInterests()
    bumpMode(m)

    // 预生成命中:有主题时只取同主题条目,无主题时 FIFO 任意条目
    const hit = await takePrefetch(m, fixedTopic ?? undefined)
    if (hit) {
      const hitScript = hit.script
      if (!hit.topic.startsWith('连续剧情')) {
        bumpTopicSeen(hit.topic) // 口味记账对齐实际播出的主题(命中缓冲时≠本次抽中的主题)
      }
      // 真正开播:采纳预生成时暂缓的上下文副作用(注入冷却补记/recap 消费)
      if (hitScript.adoption) void adoptDeferredContext(hitScript.adoption)
      nowPlaying.current = { topic: hit.topic, lines: hitScript.before, total: hitScript.before.length, index: -1, source: 'gen' }
      lastLines.current = hitScript.before
      // 使用后即移出预取缓存;历史在完播/中止时按 eid 一次性提交(onDone/onStopped)
      pendingEpisode.current = {
        eid: newEpisodeId(),
        card: hitScript.card,
        before: hitScript.before,
        after: hitScript.after,
        mode: m,
        topic: hit.topic,
      }
      beginPerforming()
      playingLines.current = hitScript.before
      player.current!.play(withFinalePause(hitScript.before), {
        gap: modeOf(hit.mode).gap,
        choice: hitScript.choice,
        after: Object.fromEntries(
          Object.entries(hitScript.after).map(([id, seg]) => [id, withFinalePause(seg)]),
        ),
      })
      // 当前剧情拍在完播蒸馏前仍占用，补货时不能再次生成同一拍。
      void prefetchNext(m, hitScript.before, fixedTopic ?? undefined, hit.arc ? [hit.arc.id] : [])
      return
    }

    // 约 30% 概率演出连续剧情的一拍；生成中与其他模式缓存里的剧情 ID 都视为占用。
    const arcReservation = fixedTopic
      ? null
      : reserveArcBeat((await getStory()).arcs, new Set(await listPrefetchedArcIds()))
    const arcBeat = arcReservation?.beat ?? null
    const actualTopic = arcBeat
      ? `连续剧情《${arcBeat.title}》:${arcBeat.hook}`
      : fixedTopic ??
        (interests.length > 0 && Math.random() < (modeOf(m).interestTopicChance ?? 0)
          ? `使用者感兴趣的事:${interests[Math.floor(Math.random() * interests.length)]}`
          : pickTopic(modeOf(m), {
              ban: cfg.userProfile.banTopics,
              weights: await getTopicWeights(),
            }))

    // 未命中：生成当前轮(等待期两人进入思考姿势)
    deps.presenter.setPose('A', 'thinking')
    deps.presenter.setPose('B', 'thinking')
    setRuntimeMode({ type: 'generating' })
    const ctrl = new AbortController()
    generateAbort.current = ctrl
    const topic = actualTopic
    try {
      const script = await generateDialog(m, topic, lastLines.current, ctrl.signal, fixedTopic != null, arcBeat ?? undefined)
      if (ctrl.signal.aborted) return
      if (!arcBeat) bumpTopicSeen(topic) // 这轮真的播出了才记 seen;剧情线拍不入话题账
      nowPlaying.current = { topic, lines: script.before, total: script.before.length, index: -1, source: 'gen' }
      lastLines.current = script.before
      // 单次落盘:不再生成时先记前半段;完播提交完整路径,中止提交已播前缀(onDone/onStopped)
      pendingEpisode.current = { eid: newEpisodeId(), card: script.card, before: script.before, after: script.after, mode: m, topic }
      beginPerforming()
      playingLines.current = script.before
      player.current!.play(withFinalePause(script.before), {
        gap: MODES[m].gap,
        choice: script.choice,
        after: Object.fromEntries(
          Object.entries(script.after).map(([id, seg]) => [id, withFinalePause(seg)]),
        ),
      })
      void prefetchNext(
        m,
        script.before,
        fixedTopic ?? undefined,
        arcBeat ? [arcBeat.id] : [],
      ) // 请求生成两轮：当前轮 + 后台预生成
    } catch (e) {
      if (ctrl.signal.aborted) return
      console.error('LLM 生成失败，回退硬编码脚本', e)
      lastLines.current = MODES[m].script
      nowPlaying.current = null // 兜底剧本与抽中的话题无关,不参与看完/跳过记账
      beginPerforming()
      // 先出提示气泡(带具体原因),短暂停留后再开播,避免被第一句台词立即覆盖
      const reason = await describeLlmError(e)
      if (ctrl.signal.aborted) return
      deps.presenter.say('A', `${reason},先来段内置的~`, { ms: 1800 })
      window.setTimeout(() => {
        if (ctrl.signal.aborted) return // 停止/切换期间不续播
        deps.presenter.reset()
        playingLines.current = MODES[m].script
        player.current!.play(MODES[m].script, { gap: MODES[m].gap })
      }, 1800)
    } finally {
      arcReservation?.release()
    }
  }

  /** 停止一切:外围清场(下播/道具)→ 记账(跳过/忽略)→ 中止生成 → 停播 → 停语音 → 复位 */
  function stop() {
    deps.teardown()
    // 中途按停止 = 负反馈(演过 80% 以上视为看完,不罚);正在生成时无账可记
    const np = nowPlaying.current
    if (np && np.total > 0 && np.index / np.total < 0.8) bumpTopicSkipped(np.topic)
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

  /** 手动锁定主题后按新主题重新预生成一单(旧缓冲保留,无主题时照常随机补) */
  function rearmPrefetch(m: Mode, topic: string | null): void {
    void prefetchNext(m, lastLines.current, topic ?? undefined)
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
    isPlaying,
    recentLines,
    rearmPrefetch,
  }
}

export type PerformanceDirector = ReturnType<typeof usePerformanceDirector>
export type { RuntimeMode }
