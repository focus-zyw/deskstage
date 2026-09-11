// 角色呈现器:气泡/动作/语气/说话态/惊讶脉冲/连戳反应的唯一归属。
// 此前直播、聊天、演出、戳角色各自直改 bubble/action/speaking,计时器分散,
// 互相覆盖(慢计时器会清掉新气泡)。现在所有呈现都经这里:
// - say():插话/短句呈现,按角色单计时器回收,且只回收自己的话(新话顶掉旧话后旧计时器不再生效)
// - showTalk/hush/endLine/settle:演出播放器逐句驱动的上屏与回收
// - reset():停止/开播前的立即清场
// 视觉之外的事(TTS、演出推进)不归这里。
import { useEffect, useRef, useState } from 'react'
import type { DialogLine, Speaker } from '../performer/player'
import { listenersOf, reactionsOf } from '../performer/dialogSchema'
import { moodOf } from '../storage/moodStore'
import { tintedRelaxPose } from '../engine/moodState'

const NO_BUBBLE: Record<Speaker, string | null> = { A: null, B: null, C: null }
const IDLE_POSE: Record<Speaker, string> = { A: 'idle', B: 'idle', C: 'idle' }
const NO_DELIVERY: Record<Speaker, string | undefined> = { A: undefined, B: undefined, C: undefined }
const NO_FLAGS: Record<Speaker, boolean> = { A: false, B: false, C: false }

export interface SayOptions {
  /** 伴随动作;不传则保持当前动作 */
  action?: string
  /** 展示时长(默认 1600ms) */
  ms?: number
  /** 远距离喊话:气泡加大加粗 */
  loud?: boolean
  /** 连戳反应高亮(sprite 抖一下) */
  reacting?: boolean
  /** 同时置为说话态(聊天/弹幕回复走 TTS 时);到期一并熄灯 */
  speaking?: boolean
}

export function useActorPresenter() {
  const [bubble, setBubble] = useState<Record<Speaker, string | null>>(NO_BUBBLE)
  const [action, setAction] = useState<Record<Speaker, string>>(IDLE_POSE)
  const [delivery, setDelivery] = useState<Record<Speaker, string | undefined>>(NO_DELIVERY)
  const [speaking, setSpeaking] = useState<Speaker | null>(null)
  const [pulseFor, setPulseFor] = useState<Speaker | null>(null)
  const [reacting, setReacting] = useState<Record<Speaker, boolean>>(NO_FLAGS)
  const [loudBubble, setLoudBubble] = useState<Record<Speaker, boolean>>(NO_FLAGS)
  // 回收守卫用的镜像(setBubble 函数式更新读不到当前值);经 effect 同步避免渲染期写 ref
  const bubbleRef = useRef(bubble)
  const speakingRef = useRef(speaking)
  useEffect(() => {
    bubbleRef.current = bubble
    speakingRef.current = speaking
  }, [bubble, speaking])
  // 每角色一个回收计时器:同角色新话顶掉旧话(旧计时器先取消)
  const timers = useRef<Record<Speaker, number>>({ A: 0, B: 0, C: 0 })
  const pulseTimer = useRef(0)
  const finaleTimer = useRef(0)
  // 姿势放松计时器:句间保持上一个表情姿势,停顿超过 RELAX_MS 才回 idle——
  // 之前句尾立即回 idle,快节奏对白里每 200~600ms 就 "talk→idle→talk" 弹跳一次,视觉不协调
  const relaxTimers = useRef<Record<Speaker, number>>({ A: 0, B: 0, C: 0 })
  // 情绪染色姿势的回收计时器:染色一拍(2.4~4s)后仍要回 idle
  const tintTimers = useRef<Record<Speaker, number>>({ A: 0, B: 0, C: 0 })
  const RELAX_MS = 1500

  function cancelRelax(who: Speaker): void {
    window.clearTimeout(relaxTimers.current[who])
    window.clearTimeout(tintTimers.current[who])
  }

  function scheduleRelax(who: Speaker, ms = RELAX_MS): void {
    cancelRelax(who)
    relaxTimers.current[who] = window.setTimeout(() => {
      setDelivery((d) => ({ ...d, [who]: undefined }))
      // 情绪余波:负向强情绪回 idle 前先落到染色姿势一拍,让"还在生气/蔫着"看得见
      // (限一拍防画面常年苦脸;C 的动作归常驻行为机器管,不参与染色)
      const tint = who === 'C' ? null : tintedRelaxPose(moodOf(who))
      if (!tint) {
        setAction((a) => ({ ...a, [who]: 'idle' }))
        return
      }
      setAction((a) => ({ ...a, [who]: tint }))
      tintTimers.current[who] = window.setTimeout(() => {
        setAction((a) => ({ ...a, [who]: 'idle' }))
      }, 2400 + Math.floor(Math.random() * 1600))
    }, ms)
  }

  /** 插话/短句呈现;到期只回收这一句(气泡已被别的话顶掉时不再动动作与说话灯) */
  function say(who: Speaker, text: string, opts: SayOptions = {}) {
    const { action: act, ms = 1600, loud = false, reacting: react = false, speaking: talk = false } = opts
    window.clearTimeout(timers.current[who])
    cancelRelax(who)
    setBubble((b) => ({ ...b, [who]: text }))
    if (act !== undefined) setAction((a) => ({ ...a, [who]: act }))
    setLoudBubble((l) => ({ ...l, [who]: loud }))
    setReacting((r) => ({ ...r, [who]: react }))
    if (talk) setSpeaking(who)
    timers.current[who] = window.setTimeout(() => {
      if (bubbleRef.current[who] !== text) return // 已被新话顶掉
      setBubble((b) => ({ ...b, [who]: null }))
      setAction((a) => ({ ...a, [who]: 'idle' }))
      setReacting((r) => ({ ...r, [who]: false }))
      setLoudBubble((l) => ({ ...l, [who]: false }))
      if (talk && speakingRef.current === who) setSpeaking(null)
    }, ms)
  }

  /** 演出逐句上屏:气泡/表情/语气/说话态 + 各角色同步反应与惊讶脉冲。
   *  台词在笑 → 用大笑表情(LLM 词表有 laugh 时直接命中,否则启发式兜底) */
  function showTalk(line: DialogLine) {
    const laughing = /哈哈+|嘿嘿|嘻嘻|笑死|233/.test(line.text)
    const act = laughing ? 'laugh' : line.action || 'talk'
    cancelRelax(line.speaker)
    setBubble((b) => ({ ...b, [line.speaker]: line.text }))
    setAction((a) => ({ ...a, [line.speaker]: act }))
    setSpeaking(line.speaker)
    setDelivery((d) => ({ ...d, [line.speaker]: line.delivery }))
    // 各角色同步无声反应:reactions(三人协议,A 说话时 B 害羞/C 惊讶可同帧)优先,
    // 缺省按旧协议从 listenerAction 按 target 转换——转换逻辑收在 dialogSchema
    const reactions = reactionsOf(line)
    for (const who of Object.keys(reactions) as Speaker[]) {
      const reaction = reactions[who]
      if (!reaction) continue
      cancelRelax(who)
      setAction((a) => ({ ...a, [who]: reaction }))
    }
    // 台词带感叹/问号 → 指定听者惊讶脉冲(room 时取任一听者,脉冲只是视觉点缀)
    const listeners = listenersOf(line)
    if (/[!?！？]/.test(line.text) && listeners.length > 0) pulse(listeners[0])
  }

  /** 声音结束:立即闭嘴;姿势保持到放松计时(句间不再弹回 idle) */
  function hush(speaker: Speaker) {
    setSpeaking(null)
    scheduleRelax(speaker)
  }

  /** 句尾留白结束:清气泡;其他角色的反应动作同样延迟放松,句间保持画面张力 */
  function endLine(speaker: Speaker) {
    setBubble((b) => ({ ...b, [speaker]: null }))
    for (const who of ['A', 'B', 'C'] as const) {
      if (who !== speaker) scheduleRelax(who)
    }
    setDelivery((d) => ({ ...d, [speaker]: undefined }))
  }

  /** 听者惊讶脉冲(聊天/弹幕回复旁听反应) */
  function pulse(listener: Speaker) {
    setPulseFor(listener)
    window.clearTimeout(pulseTimer.current)
    pulseTimer.current = window.setTimeout(() => setPulseFor(null), 600)
  }

  /** 收底拍:响底台词与表情定格片刻给观众笑的时间,然后全员经情绪染色放松回 idle */
  function settle(ms = 2600) {
    setSpeaking(null)
    setDelivery(NO_DELIVERY)
    window.clearTimeout(finaleTimer.current)
    finaleTimer.current = window.setTimeout(() => {
      setBubble(NO_BUBBLE)
      for (const w of ['A', 'B', 'C'] as const) scheduleRelax(w, 0)
    }, ms)
  }

  /** 单角色做动作(如开场挥手) */
  function setPose(who: Speaker, pose: string) {
    setAction((a) => ({ ...a, [who]: pose }))
  }

  /** 立即清场(停止/开播前):气泡与动作全复位 */
  function reset() {
    for (const w of ['A', 'B', 'C'] as const) {
      window.clearTimeout(timers.current[w])
      window.clearTimeout(relaxTimers.current[w])
      window.clearTimeout(tintTimers.current[w])
    }
    window.clearTimeout(finaleTimer.current)
    setBubble(NO_BUBBLE)
    setAction(IDLE_POSE)
    setSpeaking(null)
    setDelivery(NO_DELIVERY)
  }

  return {
    bubble, action, delivery, speaking, pulseFor, reacting, loudBubble,
    say, showTalk, hush, endLine, pulse, settle, setPose, reset,
  }
}

export type ActorPresenter = ReturnType<typeof useActorPresenter>
