import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { CharacterSprite } from './stage/CharacterSprite'
import { Bubble } from './stage/Bubble'
import { EyeIcon, EyeOffIcon, PlayIcon, StopIcon, GearIcon, PowerIcon, TargetIcon } from './stage/icons'
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
import { MODES, modeList, modeOf, type Mode } from './performer/modes'
import { generateDialog } from './engine/llmClient'
import { prefetchNext } from './engine/dialogPrefetch'
import { TOPIC_SEEDS, pickTopic } from './engine/topicSeeds'
import { takePrefetch } from './storage/prefetchStore'
import { appendHistory, loadRecentHistory, listEpisodes, deleteEpisodes, toggleFavorite, type Episode } from './storage/historyStore'
import {
  getConfig,
  saveConfig,
  DEFAULT_CONFIG,
  type AppConfig,
  type CharactersConfig,
  type CharPos,
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
  // 手动锁定主题;null = 随机。主题面板弹/收与搜索词
  const [topicOverride, setTopicOverride] = useState<string | null>(null)
  const [topicOpen, setTopicOpen] = useState(false)
  const [topicQuery, setTopicQuery] = useState('')
  // 空闲自动重放:频率来自配置,activeTick 用于用户互动后重置计时
  const [autoReplayMin, setAutoReplayMin] = useState(DEFAULT_CONFIG.autoReplayMin)
  const [activeTick, setActiveTick] = useState(0)
  const [episodes, setEpisodes] = useState<Episode[]>([])
  // 角色布局(位置各自独立/缩放共享)与隐藏开关;ref 供拖动/滚轮事件读最新值
  const [charCfg, setCharCfg] = useState<CharactersConfig>(DEFAULT_CONFIG.characters)
  const charCfgRef = useRef(charCfg)
  const [charHidden, setCharHidden] = useState(DEFAULT_CONFIG.charactersHidden)
  const charSaveTimer = useRef(0)
  // 退出两段确认:第一次点亮,3 秒内再点才真正退出
  const [exitArmed, setExitArmed] = useState(false)
  const exitTimer = useRef(0)
  const dragRef = useRef<{ who: Speaker; startX: number; startY: number; orig: CharPos; moved: boolean } | null>(null)
  const draggingWho = useRef<Speaker | null>(null)

  const charA = useRef<HTMLDivElement>(null)
  const charB = useRef<HTMLDivElement>(null)
  const segCtl = useRef<HTMLDivElement>(null)
  const btnGen = useRef<HTMLButtonElement>(null)
  const btnStop = useRef<HTMLButtonElement>(null)
  const btnGear = useRef<HTMLButtonElement>(null)
  const btnEye = useRef<HTMLButtonElement>(null)
  const btnTopic = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const topicPanelRef = useRef<HTMLDivElement>(null)
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
    void getConfig().then((c) => {
      setAutoReplayMin(c.autoReplayMin)
      applyChars(c.characters)
      setCharHidden(c.charactersHidden)
      setTopicOverride(c.topicOverride)
    })
    // 启动恢复：读最近历史，续集生成时衔接上次聊到的内容
    void loadRecentHistory(20).then((entries) => {
      if (entries.length > 0) {
        lastLines.current = entries.map(({ ts: _ts, mode: _m, ...l }) => l)
      }
    })
    const unsubs = [
      onHoverChange(setHovered),
      // 拖动中的角色命中区膨胀为全窗口:快速拖动时光标冲出角色矩形,
      // 否则穿透窗口会立刻恢复 ignoreCursorEvents,拖拽被中断
      registerHitRegion('charA', {
        getRect: () =>
          draggingWho.current === 'A'
            ? new DOMRect(0, 0, window.innerWidth, window.innerHeight)
            : charA.current!.getBoundingClientRect(),
      }),
      registerHitRegion('charB', {
        getRect: () =>
          draggingWho.current === 'B'
            ? new DOMRect(0, 0, window.innerWidth, window.innerHeight)
            : charB.current!.getBoundingClientRect(),
      }),
      registerHitRegion('eye', {
        getRect: () => btnEye.current!.getBoundingClientRect(),
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
      registerHitRegion('topic', {
        getRect: () => btnTopic.current!.getBoundingClientRect(),
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

  // 主题面板打开期间整体可命中
  useEffect(() => {
    if (!topicOpen) return
    return registerHitRegion('topic-panel', {
      getRect: () =>
        topicPanelRef.current?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0),
    })
  }, [topicOpen])

  // Escape 关闭任一打开的面板
  useEffect(() => {
    if (!settingsOpen && !topicOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSettingsOpen(false)
        setTopicOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settingsOpen, topicOpen])

  /** 播放指定的一集(自动重放与历史行点击共用):不调 LLM、不写历史 */
  function playEpisode(ep: Episode) {
    generateAbort.current?.abort() // 若有生成在途,直接作废
    player.current!.stop()
    lastReplayTs.current = ep.ts
    lastLines.current = ep.lines // 衔接后续手动生成
    setBubble({ A: null, B: null })
    setAction({ A: 'idle', B: 'idle' })
    setPhase('performing')
    player.current!.play(ep.lines, { gap: modeOf(ep.mode).gap })
  }

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
    playEpisode(ep)
  }

  /** 点击历史行:关闭面板并回放该集 */
  function replayFromHistory(ep: Episode) {
    setSettingsOpen(false)
    playEpisode(ep)
  }

  /** 空闲自动重放:仅在没有生成/演出、没开设置面板、角色未隐藏时计时;任何依赖变化都会重置计时 */
  useEffect(() => {
    if (phase !== 'idle' || settingsOpen || charHidden || autoReplayMin <= 0) return
    const t = window.setTimeout(() => void autoReplay(), autoReplayMin * 60_000)
    return () => window.clearTimeout(t)
  }, [phase, settingsOpen, charHidden, autoReplayMin, activeTick])

  /** 单次点播：优先消费预生成(秒开,使用后移入 history);
   *  未命中则生成当前轮,开播后后台再静默预生成下一轮(共两轮) */
  async function playMode(m: Mode) {
    generateAbort.current?.abort()
    player.current!.stop()
    setBubble({ A: null, B: null })
    setAction({ A: 'idle', B: 'idle' })

    // 主题:手动锁定则用固定主题(强约束),否则随机挑
    const fixedTopic = topicOverride
    const actualTopic = fixedTopic ?? pickTopic(modeOf(m))

    // 预生成命中:有主题时只取同主题条目,无主题时 FIFO 任意条目
    const hit = await takePrefetch(m, fixedTopic ?? undefined)
    if (hit) {
      lastLines.current = hit.lines
      void appendHistory(hit.lines, hit.mode, hit.topic) // 使用后移入 history(fire-and-forget)
      setPhase('performing')
      player.current!.play(hit.lines, { gap: modeOf(hit.mode).gap })
      void prefetchNext(m, hit.lines, fixedTopic ?? undefined) // 补货下一轮(静默)
      return
    }

    // 未命中：生成当前轮
    setPhase('generating')
    const ctrl = new AbortController()
    generateAbort.current = ctrl
    const topic = actualTopic
    try {
      const lines = await generateDialog(m, topic, lastLines.current, ctrl.signal, fixedTopic != null)
      if (ctrl.signal.aborted) return
      lastLines.current = lines
      void appendHistory(lines, m, topic) // 落盘（fire-and-forget，失败不阻断演出）
      setPhase('performing')
      player.current!.play(lines, { gap: MODES[m].gap })
      void prefetchNext(m, lines, fixedTopic ?? undefined) // 请求生成两轮：当前轮 + 后台预生成
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

  // ---------- 角色布局:拖动移动(各自独立)/ 滚轮缩放(全局一致) ----------

  /** 更新布局;persist='now' 立即落盘,'debounced' 防抖落盘(滚轮连续滚动只写一次) */
  function applyChars(next: CharactersConfig, persist: 'now' | 'debounced' | 'no' = 'no') {
    charCfgRef.current = next
    setCharCfg(next)
    if (persist === 'no') return
    window.clearTimeout(charSaveTimer.current)
    const write = () =>
      saveConfig({ characters: next }).catch((e) => console.warn('布局保存失败(静默)', e))
    if (persist === 'now') void write()
    else charSaveTimer.current = window.setTimeout(write, 500)
  }

  function onCharPointerDown(e: ReactPointerEvent, who: Speaker) {
    dragRef.current = {
      who,
      startX: e.clientX,
      startY: e.clientY,
      orig: { ...charCfgRef.current[who] },
      moved: false,
    }
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      // 合成事件/指针已释放时无活动指针可捕获,忽略
    }
  }

  function onCharPointerMove(e: ReactPointerEvent, who: Speaker) {
    const d = dragRef.current
    if (!d || d.who !== who) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 6) return // 小位移视为点击,留给戳一戳
      d.moved = true
      draggingWho.current = who
    }
    const cur = charCfgRef.current
    applyChars(
      {
        ...cur,
        [who]: {
          xPct: Math.min(97, Math.max(3, d.orig.xPct + (dx / window.innerWidth) * 100)),
          bottom: Math.min(
            Math.max(0, window.innerHeight - 80),
            Math.max(0, d.orig.bottom - dy),
          ),
        },
      },
      'no',
    )
  }

  function onCharPointerUp(who: Speaker) {
    const d = dragRef.current
    dragRef.current = null
    if (!d || d.who !== who) return
    if (d.moved) {
      draggingWho.current = null
      applyChars(charCfgRef.current, 'now')
    } else {
      poke(who) // 原地点一下 = 戳一戳
    }
  }

  function onCharWheel(e: ReactWheelEvent) {
    const cur = charCfgRef.current
    const maxHeight = Math.max(240, window.innerHeight - 40)
    const height = Math.min(maxHeight, Math.max(140, cur.height + (e.deltaY < 0 ? 12 : -12)))
    if (height === cur.height) return
    applyChars({ ...cur, height }, 'debounced') // 缩放全局一致:两个角色同步
  }

  /** 隐藏/显示角色(立即落盘) */
  function setCharsHidden(v: boolean) {
    setCharHidden(v)
    saveConfig({ charactersHidden: v }).catch((e) => console.warn('显示开关保存失败(静默)', e))
  }

  /** 手动锁定主题:立即落盘 + 按新主题预生成一单(旧缓冲保留,无主题时照常消费) */
  function applyTopic(topic: string) {
    const norm = topic.trim()
    setTopicOverride(norm)
    setTopicOpen(false)
    void saveConfig({ topicOverride: norm }).catch((e) => console.warn('主题保存失败(静默)', e))
    if (norm) void prefetchNext(mode, lastLines.current, norm)
  }

  /** 清除主题,回到话题池随机 */
  function clearTopic() {
    setTopicOverride(null)
    setTopicOpen(false)
    void saveConfig({ topicOverride: null }).catch((e) => console.warn('主题清除失败(静默)', e))
    void prefetchNext(mode, lastLines.current) // 重新随机补一单
  }

  /** 退出程序:两段确认,3 秒内再点一次才真正关闭,防误触 */
  function requestExit() {
    if (exitArmed) {
      void getCurrentWindow().close()
      return
    }
    setExitArmed(true)
    window.clearTimeout(exitTimer.current)
    exitTimer.current = window.setTimeout(() => setExitArmed(false), 3000)
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
      <div className="ctrl-bar">
        <div ref={segCtl} className={`seg${hovered === 'modes' ? ' hot' : ''}`}>
          <div
            className="seg-thumb"
            style={{
              width: `calc(${100 / modeList.length}% - 3px)`,
              transform: `translateX(${modeList.findIndex((m) => m.id === mode) * 100}%)`,
            }}
          />
          {modeList.map((m) => (
            <button
              key={m.id}
              className={`seg-btn${mode === m.id ? ' on' : ''}`}
              onClick={() => setMode(m.id)}
            >
              {m.label}
            </button>
          ))}
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

        <button
          ref={btnEye}
          className={`ctrl-btn icon${hovered === 'eye' ? ' hot' : ''}`}
          title={charHidden ? '显示角色' : '隐藏角色'}
          onClick={() => setCharsHidden(!charHidden)}
        >
          {charHidden ? <EyeOffIcon /> : <EyeIcon />}
        </button>

        <button
          ref={btnTopic}
          className={`ctrl-btn icon${hovered === 'topic' ? ' hot' : ''}${topicOverride ? ' on' : ''}`}
          title={topicOverride ? `话题：${topicOverride}` : '设置聊天主题'}
          onClick={() => (topicOpen ? setTopicOpen(false) : (setSettingsOpen(false), setTopicOpen(true)))}
        >
          <TargetIcon />
        </button>
      </div>

      {settingsOpen && (
        <div ref={panelRef} className="settings-panel">
          <div className="panel-head">
            <span>设置</span>
            <button
              className={`panel-btn danger${exitArmed ? ' armed' : ''}`}
              title={exitArmed ? '再点一次确认退出' : '退出程序'}
              onClick={requestExit}
            >
              {exitArmed ? '确认退出?' : <PowerIcon />}
            </button>
          </div>
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
            <label htmlFor="cfg-show">显示角色</label>
            <input
              id="cfg-show"
              type="checkbox"
              checked={!charHidden}
              onChange={(e) => setCharsHidden(!e.target.checked)}
            />
          </div>
          <div className="settings-row">
            <div className="settings-hint">拖动角色可移动 · 悬停滚轮缩放(两角色同步)</div>
            <button
              className="panel-btn"
              onClick={() => applyChars(DEFAULT_CONFIG.characters, 'now')}
            >
              恢复默认布局
            </button>
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
            {episodes.map((ep) => {
              const bm = modeOf(ep.mode)
              return (
                <div
                  className="hist-row"
                  key={ep.ts}
                  title="点击回放此段"
                  onClick={() => replayFromHistory(ep)}
                >
                  <span className="hist-mode" style={{ background: bm.accent }}>
                    {bm.label}
                  </span>
                  <div className="hist-main">
                    <div className="hist-preview">{ep.lines[0]?.text ?? ''}</div>
                    <div className="hist-meta">
                      {fmtTime(ep.ts)} · {ep.lines.length} 句
                      {ep.topic ? ` · ${ep.topic}` : ''}
                    </div>
                  </div>
                  <button
                    className={`hist-fav${ep.fav ? ' on' : ''}`}
                    title={ep.fav ? '取消收藏' : '收藏（不会被删除，重放权重更高）'}
                    onClick={(e) => {
                      e.stopPropagation()
                      void onToggleFav(ep)
                    }}
                  >
                    {ep.fav ? '★' : '☆'}
                  </button>
                  <button
                    className="hist-del"
                    title={ep.fav ? '收藏对话不可删除' : '删除此段'}
                    disabled={ep.fav}
                    onClick={(e) => {
                      e.stopPropagation()
                      void onDeleteEpisode(ep)
                    }}
                  >
                    ✕
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {topicOpen && (
        <div ref={topicPanelRef} className="settings-panel topic-panel">
          <div className="panel-head">
            <span>聊天主题</span>
            {topicOverride && (
              <button className="panel-btn" onClick={clearTopic}>
                清除主题（回到随机）
              </button>
            )}
          </div>
          <input
            className="topic-search"
            value={topicQuery}
            autoFocus
            placeholder="搜索内置话题,或输入自定义主题…"
            onChange={(e) => setTopicQuery(e.target.value)}
          />
          <div className="topic-list">
            {topicQuery.trim() === '' && (
              <div className="topic-empty">输入关键词搜索,或直接点下方话题</div>
            )}
            {topicQuery.trim() !== '' &&
              !TOPIC_SEEDS.some((t) => t.includes(topicQuery.trim())) && (
                <button
                  className="topic-item"
                  onClick={() => applyTopic(topicQuery)}
                >
                  用『{topicQuery.trim()}』作为话题
                </button>
              )}
            {TOPIC_SEEDS.filter((t) => t.includes(topicQuery.trim())).map((t) => (
              <button
                key={t}
                className={`topic-item${topicOverride === t ? ' on' : ''}`}
                onClick={() => applyTopic(t)}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      )}

      <div
        className="actor"
        style={{ left: `${charCfg.A.xPct}%`, bottom: charCfg.A.bottom, display: charHidden ? 'none' : undefined }}
        onPointerDown={(e) => onCharPointerDown(e, 'A')}
        onPointerMove={(e) => onCharPointerMove(e, 'A')}
        onPointerUp={() => onCharPointerUp('A')}
        onWheel={(e) => onCharWheel(e)}
      >
        {bubble.A && <Bubble text={bubble.A} />}
        <CharacterSprite
          ref={charA}
          sprite={SPRITE_SETS.A}
          heightOverride={charCfg.height}
          action={action.A}
          hot={hovered === 'charA'}
          reacting={reacting.A}
        />
      </div>

      <div
        className="actor"
        style={{ left: `${charCfg.B.xPct}%`, bottom: charCfg.B.bottom, display: charHidden ? 'none' : undefined }}
        onPointerDown={(e) => onCharPointerDown(e, 'B')}
        onPointerMove={(e) => onCharPointerMove(e, 'B')}
        onPointerUp={() => onCharPointerUp('B')}
        onWheel={(e) => onCharWheel(e)}
      >
        {bubble.B && <Bubble text={bubble.B} />}
        <CharacterSprite
          ref={charB}
          sprite={SPRITE_SETS.B}
          heightOverride={charCfg.height}
          action={action.B}
          hot={hovered === 'charB'}
          reacting={reacting.B}
        />
      </div>

      <div className="watermark">
        M5 · 空闲自动重放历史 · 选模式点 ▶ 生成一集
      </div>
    </div>
  )
}

export default App
