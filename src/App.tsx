import { useEffect, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { CharacterSprite } from './stage/CharacterSprite'
import { Bubble } from './stage/Bubble'
import {
  initPointerManager,
  registerHitRegion,
  onHoverChange,
} from './input/pointerManager'
import {
  PerformancePlayer,
  type Speaker,
} from './performer/player'
import { MODES, type Mode } from './performer/scripts'
import './App.css'

// 点击反应台词池（M2 起由 LLM 生成替代）
const POKE_LINES = [
  '干嘛点我！',
  '再点要收费了！',
  '诶嘿嘿~',
  '别闹，正聊着呢',
  '摸鱼被发现了？！',
  '（默默挪开半步）',
]

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
  const [playing, setPlaying] = useState<Mode | null>(null)

  const charA = useRef<HTMLDivElement>(null)
  const charB = useRef<HTMLDivElement>(null)
  const closeBtn = useRef<HTMLButtonElement>(null)
  const btnDaily = useRef<HTMLButtonElement>(null)
  const btnCross = useRef<HTMLButtonElement>(null)
  const btnStop = useRef<HTMLButtonElement>(null)
  const timers = useRef<Record<Speaker, number>>({ A: 0, B: 0 })

  // 演出播放器：消费 DialogLine[]，驱动气泡与动作（M2 换 LLM 数据源）
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
      onDone: () => setPlaying(null),
    })
  }

  useEffect(() => {
    void initPointerManager()
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

  function playMode(mode: Mode) {
    setPlaying(mode)
    player.current!.play(MODES[mode].script, { gap: MODES[mode].gap })
  }

  function stopPlaying() {
    player.current!.stop()
    setPlaying(null)
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
          className={`ctrl-btn${hovered === 'daily' ? ' hot' : ''}${
            playing === 'daily' ? ' on' : ''
          }`}
          onClick={() => playMode('daily')}
        >
          ▶ 日常
        </button>
        <button
          ref={btnCross}
          className={`ctrl-btn${hovered === 'crosstalk' ? ' hot' : ''}${
            playing === 'crosstalk' ? ' on' : ''
          }`}
          onClick={() => playMode('crosstalk')}
        >
          ▶ 相声
        </button>
        <button
          ref={btnStop}
          className={`ctrl-btn${hovered === 'stop' ? ' hot' : ''}`}
          disabled={!playing}
          onClick={stopPlaying}
        >
          ⏹ 停止
        </button>
      </div>

      <div className="actor actor-a">
        {bubble.A && <Bubble text={bubble.A} />}
        <CharacterSprite
          ref={charA}
          name="甲"
          color="#7c6cf0"
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
          name="乙"
          color="#f08c5a"
          action={action.B}
          hot={hovered === 'charB'}
          reacting={reacting.B}
          onClick={() => poke('B')}
        />
      </div>

      <div className="watermark">
        M1 演出队列 · 顶部按钮播放脚本 · 点击角色互动 · 空白区域点击穿透
      </div>
    </div>
  )
}

export default App
