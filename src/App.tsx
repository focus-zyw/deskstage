import { useEffect, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { CharacterSprite } from './stage/CharacterSprite'
import { Bubble } from './stage/Bubble'
import {
  initPointerManager,
  registerHitRegion,
  onHoverChange,
} from './input/pointerManager'
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

type Who = 'A' | 'B'

function App() {
  const [hovered, setHovered] = useState<string | null>(null)
  const [reacting, setReacting] = useState<Record<Who, boolean>>({ A: false, B: false })
  const [bubble, setBubble] = useState<Record<Who, string | null>>({ A: null, B: null })
  const timers = useRef<Record<Who, number>>({ A: 0, B: 0 })

  const charA = useRef<HTMLDivElement>(null)
  const charB = useRef<HTMLDivElement>(null)
  const closeBtn = useRef<HTMLButtonElement>(null)

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
    ]
    return () => unsubs.forEach((u) => u())
  }, [])

  function poke(who: Who) {
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

      <div className="actor actor-a">
        {bubble.A && <Bubble text={bubble.A} />}
        <CharacterSprite
          ref={charA}
          name="甲"
          color="#7c6cf0"
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
          hot={hovered === 'charB'}
          reacting={reacting.B}
          onClick={() => poke('B')}
        />
      </div>

      <div className="watermark">M1 穿透验证样例 · 角色区域可交互，空白区域点击穿透</div>
    </div>
  )
}

export default App
