import { useEffect, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { CharacterSprite } from './stage/CharacterSprite'
import { Bubble } from './stage/Bubble'
import { PlayIcon, StopIcon, GearIcon } from './stage/icons'
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
import { appendHistory, loadRecentHistory, listEpisodes, deleteEpisodes, toggleFavorite, type Episode } from './storage/historyStore'
import {
  getConfig,
  saveConfig,
  DEFAULT_CONFIG,
  type AppConfig,
} from './storage/configStore'
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
type SaveState = 'idle' | 'saving' | 'saved' | 'error'

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

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
  // 分段选择器当前选中模式；生成按钮按它点播
  const [mode, setMode] = useState<Mode>('daily')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [form, setForm] = useState<AppConfig>(DEFAULT_CONFIG)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  // 空闲自动重放:频率来自配置,activeTick 用于用户互动后重置计时
  const [autoReplayMin, setAutoReplayMin] = useState(DEFAULT_CONFIG.autoReplayMin)
  const [activeTick, setActiveTick] = useState(0)
  const [episodes, setEpisodes] = useState<Episode[]>([])

  const charA = useRef<HTMLDivElement>(null)
  const charB = useRef<HTMLDivElement>(null)
  const segCtl = useRef<HTMLDivElement>(null)
  const closeBtn = useRef<HTMLButtonElement>(null)
  const btnGen = useRef<HTMLButtonElement>(null)
  const btnStop = useRef<HTMLButtonElement>(null)
  const btnGear = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
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
      },
    })
  }
  const generateAbort = useRef<AbortController | null>(null)
  // 上一段台词（内存中），续播时喂给 LLM 做衔接
  const lastLines = useRef<DialogLine[]>([])
  // 上一次自动重放的集,连续重放时避开
  const lastReplayTs = useRef(0)

  useEffect(() => {
    void initPointerManager()
    preloadSprites(Object.values(SPRITE_SETS)) // 预热立绘,演出中切换动作零延迟
    void getConfig().then((c) => setAutoReplayMin(c.autoReplayMin))
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
      registerHitRegion('modes', {
        getRect: () => segCtl.current!.getBoundingClientRect(),
      }),
      registerHitRegion('gen', {
        getRect: () => btnGen.current!.getBoundingClientRect(),
      }),
      registerHitRegion('stop', {
        getRect: () => btnStop.current!.getBoundingClientRect(),
      }),
      registerHitRegion('settings', {
        getRect: () => btnGear.current!.getBoundingClientRect(),
      }),
    ]
    return () => unsubs.forEach((u) => u())
  }, [])

  // 设置面板打开期间整体可命中（否则穿透窗口里输入框点不进去）
  useEffect(() => {
    if (!settingsOpen) return
    return registerHitRegion('panel', {
      getRect: () =>
        panelRef.current?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0),
    })
  }, [settingsOpen])

  // Escape 关闭面板（窗口持有焦点时生效）
  useEffect(() => {
    if (!settingsOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settingsOpen])

  /** 加权随机抽一集历史重放(收藏权重 5):不调 LLM、不写历史 */
  async function autoReplay() {
    if (player.current!.playing) return
    const eps = await listEpisodes(100)
    if (eps.length === 0) return
    const pool = eps.length > 1 ? eps.filter((e) => e.ts !== lastReplayTs.current) : eps
    const bag: Episode[] = []
    for (const e of pool) {
      for (let i = 0; i < (e.fav ? 5 : 1); i++) bag.push(e)
    }
    const ep = bag[Math.floor(Math.random() * bag.length)]
    lastReplayTs.current = ep.ts
    lastLines.current = ep.lines // 重放也算"最近内容",衔接后续手动生成
    setBubble({ A: null, B: null })
    setAction({ A: 'idle', B: 'idle' })
    setPhase('performing')
    // 历史里的 mode 是 string,不认识的值回退日常节奏
    const gap = ep.mode === 'crosstalk' ? MODES.crosstalk.gap : MODES.daily.gap
    player.current!.play(ep.lines, { gap })
  }

  /** 空闲自动重放:仅在没有生成/演出、没开设置面板时计时;任何依赖变化都会重置计时 */
  useEffect(() => {
    if (phase !== 'idle' || settingsOpen || autoReplayMin <= 0) return
    const t = window.setTimeout(() => void autoReplay(), autoReplayMin * 60_000)
    return () => window.clearTimeout(t)
  }, [phase, settingsOpen, autoReplayMin, activeTick])

  /** 单次点播：生成一集 → 播放；失败兜底播硬编码脚本 */
  async function playMode(m: Mode) {
    generateAbort.current?.abort()
    player.current!.stop()
    setPhase('generating')
    setBubble({ A: null, B: null })
    setAction({ A: 'idle', B: 'idle' })

    const ctrl = new AbortController()
    generateAbort.current = ctrl
    const topic = pickTopic()
    try {
      const lines = await generateDialog(m, topic, lastLines.current, ctrl.signal)
      if (ctrl.signal.aborted) return
      lastLines.current = lines
      void appendHistory(lines, m) // 落盘（fire-and-forget，失败不阻断演出）
      setPhase('performing')
      player.current!.play(lines, { gap: MODES[m].gap })
    } catch (e) {
      if (ctrl.signal.aborted) return
      console.error('LLM 生成失败，回退硬编码脚本', e)
      lastLines.current = MODES[m].script
      setPhase('performing')
      player.current!.play(MODES[m].script, { gap: MODES[m].gap })
    }
  }

  /** 停止一切：中止生成 + 停止演出 + 复位 */
  function stopEverything() {
    generateAbort.current?.abort()
    generateAbort.current = null
    player.current!.stop()
    setPhase('idle')
    setBubble({ A: null, B: null })
    setAction({ A: 'idle', B: 'idle' })
  }

  /** 打开设置：读当前配置回填表单，加载历史分集 */
  async function openSettings() {
    setSaveState('idle')
    setSettingsOpen(true)
    setForm(await getConfig())
    setEpisodes(await listEpisodes())
  }

  /** 保存配置：落盘 + 刷新缓存，下一次生成即生效 */
  async function saveSettings() {
    setSaveState('saving')
    try {
      const next = await saveConfig(form)
      setAutoReplayMin(next.autoReplayMin) // 空闲计时按新频率重新武装
      setSaveState('saved')
      window.setTimeout(() => setSettingsOpen(false), 900)
    } catch (e) {
      console.error('配置保存失败', e)
      setSaveState('error')
    }
  }

  async function onToggleFav(ep: Episode) {
    await toggleFavorite(ep)
    setEpisodes(await listEpisodes())
  }

  async function onDeleteEpisode(ep: Episode) {
    await deleteEpisodes(new Set([ep.ts]))
    setEpisodes(await listEpisodes())
  }

  async function onClearUnfavorited() {
    await deleteEpisodes(new Set(episodes.filter((e) => !e.fav).map((e) => e.ts)))
    setEpisodes(await listEpisodes())
  }

  function poke(who: Speaker) {
    setActiveTick((t) => t + 1) // 用户互动,重置自动重放计时
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
        <div ref={segCtl} className={`seg${hovered === 'modes' ? ' hot' : ''}`}>
          <div className={`seg-thumb${mode === 'crosstalk' ? ' right' : ''}`} />
          <button
            className={`seg-btn${mode === 'daily' ? ' on' : ''}`}
            onClick={() => setMode('daily')}
          >
            日常
          </button>
          <button
            className={`seg-btn${mode === 'crosstalk' ? ' on' : ''}`}
            onClick={() => setMode('crosstalk')}
          >
            相声
          </button>
        </div>

        <button
          ref={btnGen}
          className={`ctrl-btn icon${hovered === 'gen' ? ' hot' : ''}${busy ? ' loading' : ''}`}
          disabled={busy}
          title="生成"
          onClick={() => void playMode(mode)}
        >
          <PlayIcon />
          <span className="label">生成</span>
        </button>

        <button
          ref={btnStop}
          className={`ctrl-btn icon${hovered === 'stop' ? ' hot' : ''}`}
          disabled={phase === 'idle'}
          title="停止"
          onClick={stopEverything}
        >
          <StopIcon />
          <span className="label">停止</span>
        </button>

        <button
          ref={btnGear}
          className={`ctrl-btn icon gear${hovered === 'settings' ? ' hot' : ''}${settingsOpen ? ' on' : ''}`}
          title="设置"
          onClick={() => (settingsOpen ? setSettingsOpen(false) : void openSettings())}
        >
          <GearIcon />
        </button>
      </div>

      {settingsOpen && (
        <div ref={panelRef} className="settings-panel">
          <div className="settings-row">
            <label htmlFor="cfg-key">API Key</label>
            <input
              id="cfg-key"
              type="password"
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            />
          </div>
          <div className="settings-row">
            <label htmlFor="cfg-url">接口地址</label>
            <input
              id="cfg-url"
              value={form.baseUrl}
              placeholder="https://api.deepseek.com/v1"
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
            />
          </div>
          <div className="settings-row">
            <label htmlFor="cfg-model">模型</label>
            <input
              id="cfg-model"
              value={form.model}
              placeholder="deepseek-chat"
              onChange={(e) => setForm({ ...form, model: e.target.value })}
            />
          </div>
          <div className="settings-row">
            <label htmlFor="cfg-replay">空闲自动重放</label>
            <select
              id="cfg-replay"
              value={form.autoReplayMin}
              onChange={(e) => setForm({ ...form, autoReplayMin: Number(e.target.value) })}
            >
              <option value={0}>关闭</option>
              <option value={5}>每 5 分钟</option>
              <option value={10}>每 10 分钟</option>
              <option value={30}>每 30 分钟</option>
              <option value={60}>每 60 分钟</option>
            </select>
          </div>
          <div className="settings-actions">
            <button className="panel-btn" onClick={() => setSettingsOpen(false)}>
              取消
            </button>
            <button
              className="panel-btn primary"
              disabled={saveState === 'saving'}
              onClick={() => void saveSettings()}
            >
              {saveState === 'saving' ? '保存中…' : '保存'}
            </button>
          </div>
          {saveState === 'saved' && (
            <div className="settings-tip ok">✓ 已保存，下次生成即生效</div>
          )}
          {saveState === 'error' && (
            <div className="settings-tip err">保存失败，详见控制台日志</div>
          )}

          <div className="settings-sep">
            <span>历史记录（{episodes.length}）</span>
            <button
              className="hist-clear"
              disabled={episodes.every((e) => e.fav) || episodes.length === 0}
              onClick={() => void onClearUnfavorited()}
            >
              清空未收藏
            </button>
          </div>
          <div className="hist-list">
            {episodes.length === 0 && (
              <div className="hist-empty">还没有历史对话，点 ▶ 生成一集试试</div>
            )}
            {episodes.map((ep) => (
              <div className="hist-row" key={ep.ts}>
                <span className={`hist-mode m-${ep.mode === 'crosstalk' ? 'x' : 'd'}`}>
                  {ep.mode === 'crosstalk' ? '相声' : '日常'}
                </span>
                <div className="hist-main">
                  <div className="hist-preview">{ep.lines[0]?.text ?? ''}</div>
                  <div className="hist-meta">
                    {fmtTime(ep.ts)} · {ep.lines.length} 句
                  </div>
                </div>
                <button
                  className={`hist-fav${ep.fav ? ' on' : ''}`}
                  title={ep.fav ? '取消收藏' : '收藏（不会被删除，重放权重更高）'}
                  onClick={() => void onToggleFav(ep)}
                >
                  {ep.fav ? '★' : '☆'}
                </button>
                <button
                  className="hist-del"
                  title={ep.fav ? '收藏对话不可删除' : '删除此段'}
                  disabled={ep.fav}
                  onClick={() => void onDeleteEpisode(ep)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

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
        M5 · 空闲自动重放历史 · 选模式点 ▶ 生成一集
      </div>
    </div>
  )
}

export default App
