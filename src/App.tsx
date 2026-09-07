import { useEffect, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { CharacterSprite } from './stage/CharacterSprite'
import { Bubble } from './stage/Bubble'
import { SPRITE_SETS, preloadSprites } from './stage/spriteSets'
import {
  initPointerManager,
  registerHitRegion,
  onHoverChange,
} from './input/pointerManager'
import {
  PerformancePlayer,
  type DialogLine,
  type Speaker,
} from './performer/player'
import { MODES, type Mode } from './performer/scripts'
import { generateDialog } from './engine/llmClient'
import { pickTopic } from './engine/topicSeeds'
import { appendHistory, loadRecentHistory } from './storage/historyStore'
import './App.css'

// 点击反应台词池（后续可改为 LLM 即兴生成）
const POKE_LINES = [
  '干嘛点我！',
  '再点要收费了！',
  '诶嘿嘿~',
  '别闹，正聊着呢',
  '摸鱼被发现了？！',
  '（默默挪开半步）',
]

type Phase = 'idle' | 'generating' | 'performing'

function App() {
  const [hovered, setHovered] = useState<string | null>(null)
  const [reacting, setReacting] = useState<Record<Speaker, boolean>>({
    A: false,
    B: false,
  })
  const [bubble, setBubble] = useState<Record<Speaker, string | null>>({
    A: null,
    B: null,
  })
  const [action, setAction] = useState<Record<Speaker, string>>({
    A: 'idle',
    B: 'idle',
  })
  const [phase, setPhase] = useState<Phase>('idle')
  const [genMode, setGenMode] = useState<Mode | null>(null)

  const charA = useRef<HTMLDivElement>(null)
  const charB = useRef<HTMLDivElement>(null)
  const closeBtn = useRef<HTMLButtonElement>(null)
  const btnDaily = useRef<HTMLButtonElement>(null)
  const btnCross = useRef<HTMLButtonElement>(null)
  const btnStop = useRef<HTMLButtonElement>(null)
  const timers = useRef<Record<Speaker, number>>({ A: 0, B: 0 })

  // 演出播放器：LLM 生成的 DialogLine[] 与硬编码脚本走同一条路
  const player = useRef<PerformancePlayer | null>(null)
  if (!player.current) {
    player.current = new PerformancePlayer({
      onLine: (line) => {
        setBubble((b) => ({ ...b, [line.speaker]: line.text }))
        setAction((a) => ({ ...a, [line.speaker]: line.action || 'talk' }))
      },
      onLineEnd: (speaker) => {
        setBubble((b) => ({ ...b, [speaker]: null }))
        setAction((a) => ({ ...a, [speaker]: 'idle' }))
      },
      onDone: () => {
        setPhase('idle')
        setGenMode(null)
      },
    })
  }
  const generateAbort = useRef<AbortController | null>(null)
  // 上一段台词（内存中），续播时喂给 LLM 做衔接
  const lastLines = useRef<DialogLine[]>([])

  useEffect(() => {
    void initPointerManager()
    preloadSprites(Object.values(SPRITE_SETS)) // 预热立绘,演出中切换动作零延迟
    // 启动恢复：读最近历史，续集生成时衔接上次聊到的内容
    void loadRecentHistory(20).then((entries) => {
      if (entries.length > 0) {
        lastLines.current = entries.map(({ ts: _ts, mode: _m, ...l }) => l)
      }
    })
    const unsubs = [
      onHoverChange(setHovered),
      registerHitRegion('charA', {
        getRect: () => charA.current!.getBoundingClientRect(),
      }),
      registerHitRegion('charB', {
        getRect: () => charB.current!.getBoundingClientRect(),
      }),
      registerHitRegion('close', {
        getRect: () => closeBtn.current!.getBoundingClientRect(),
      }),
      registerHitRegion('daily', {
        getRect: () => btnDaily.current!.getBoundingClientRect(),
      }),
      registerHitRegion('crosstalk', {
        getRect: () => btnCross.current!.getBoundingClientRect(),
      }),
      registerHitRegion('stop', {
        getRect: () => btnStop.current!.getBoundingClientRect(),
      }),
    ]
    return () => unsubs.forEach((u) => u())
  }, [])

  /** 单次点播：生成一集 → 播放；失败兜底播硬编码脚本 */
  async function playMode(mode: Mode) {
    generateAbort.current?.abort()
    player.current!.stop()
    setGenMode(mode)
    setPhase('generating')
    setBubble({ A: null, B: null })
    setAction({ A: 'idle', B: 'idle' })

    const ctrl = new AbortController()
    generateAbort.current = ctrl
    const topic = pickTopic()
    try {
      const lines = await generateDialog(mode, topic, lastLines.current, ctrl.signal)
      if (ctrl.signal.aborted) return
      lastLines.current = lines
      void appendHistory(lines, mode) // 落盘（fire-and-forget，失败不阻断演出）
      setPhase('performing')
      player.current!.play(lines, { gap: MODES[mode].gap })
    } catch (e) {
      if (ctrl.signal.aborted) return
      console.error('LLM 生成失败，回退硬编码脚本', e)
      lastLines.current = MODES[mode].script
      setPhase('performing')
      player.current!.play(MODES[mode].script, { gap: MODES[mode].gap })
    }
  }

  /** 停止一切：中止生成 + 停止演出 + 复位 */
  function stopEverything() {
    generateAbort.current?.abort()
    generateAbort.current = null
    player.current!.stop()
    setPhase('idle')
    setGenMode(null)
    setBubble({ A: null, B: null })
    setAction({ A: 'idle', B: 'idle' })
  }

  function poke(who: Speaker) {
    const line = POKE_LINES[Math.floor(Math.random() * POKE_LINES.length)]
    setBubble((b) => ({ ...b, [who]: line }))
    setReacting((r) => ({ ...r, [who]: true }))
    window.clearTimeout(timers.current[who])
    timers.current[who] = window.setTimeout(() => {
      setBubble((b) => ({ ...b, [who]: null }))
      setReacting((r) => ({ ...r, [who]: false }))
    }, 1600)
  }

  const busy = phase === 'generating'

  function modeBtnCls(mode: Mode): string {
    const id = mode === 'daily' ? 'daily' : 'crosstalk'
    return (
      `ctrl-btn${hovered === id ? ' hot' : ''}` +
      `${phase === 'performing' && genMode === mode ? ' on' : ''}` +
      `${busy && genMode === mode ? ' loading' : ''}`
    )
  }

  return (
    <div className="stage">
      <button
        ref={closeBtn}
        className={`close-btn${hovered === 'close' ? ' hot' : ''}`}
        title="关闭"
        onClick={() => void getCurrentWindow().close()}
      >
        ✕
      </button>

      <div className="ctrl-bar">
        <button
          ref={btnDaily}
          className={modeBtnCls('daily')}
          disabled={busy}
          onClick={() => void playMode('daily')}
        >
          {busy && genMode === 'daily' ? '… 生成中' : '▶ 日常'}
        </button>
        <button
          ref={btnCross}
          className={modeBtnCls('crosstalk')}
          disabled={busy}
          onClick={() => void playMode('crosstalk')}
        >
          {busy && genMode === 'crosstalk' ? '… 生成中' : '▶ 相声'}
        </button>
        <button
          ref={btnStop}
          className={`ctrl-btn${hovered === 'stop' ? ' hot' : ''}`}
          disabled={phase === 'idle'}
          onClick={stopEverything}
        >
          ⏹ 停止
        </button>
      </div>

      <div className="actor actor-a">
        {bubble.A && <Bubble text={bubble.A} />}
        <CharacterSprite
          ref={charA}
          sprite={SPRITE_SETS.A}
          action={action.A}
          hot={hovered === 'charA'}
          reacting={reacting.A}
          onClick={() => poke('A')}
        />
      </div>

      <div className="actor actor-b">
        {bubble.B && <Bubble text={bubble.B} />}
        <CharacterSprite
          ref={charB}
          sprite={SPRITE_SETS.B}
          action={action.B}
          hot={hovered === 'charB'}
          reacting={reacting.B}
          onClick={() => poke('B')}
        />
      </div>

      <div className="watermark">
        M3 · 立绘精灵 · 点模式按钮生成一集 · 播完再点可续集
      </div>
    </div>
  )
}

export default App
