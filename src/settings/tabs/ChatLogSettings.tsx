// 群聊:聊天记录页 = 一个群——可发言(@ 补全)、群名可改、背景图可自定义上传。
// 发送走 bridge.onGroupSend(与主聊天框同源:角色应答/演出插话/消息落盘一条链);
// 消息流靠 chatLogStore 版本订阅实时刷新——角色逐句应答落盘即冒出。
// 演出集块以"转发卡片"样式穿插;集管理(赞/踩/删除)仍在「演出历史」页。
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { listEpisodes, toggleFavorite, type Episode } from '../../storage/historyStore'
import {
  listChatTurns,
  clearChatLog,
  buildFeed,
  useChatLogVersion,
  type FeedItem,
  type ChatLogEntry,
} from '../../storage/chatLogStore'
import { loadGroupBg, saveGroupBg, clearGroupBg } from '../../storage/groupBgStore'
import { bumpTopicFavored } from '../../storage/memoryStore'
import { modeOf } from '../../performer/modes'
import { useConfigSnapshot } from '../../storage/configStore'
import type { Speaker } from '../../performer/dialogSchema'
import {
  applyMention,
  filterMentionTargets,
  mentionContext,
  mentionTargets,
  type MentionTarget,
} from '../../ui/mention'
import { useSettings } from '../useSettingsSession'
import { SettingsCard } from '../SettingsPrimitives'
import { fmtTime } from '../format'

const PAGE = 50
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const DELIVERY_LABEL: Record<string, string> = { deadpan: '面瘫', excited: '兴奋', slow: '慢条斯理' }

function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function dayLabel(ts: number): string {
  const d = new Date(ts)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`
}

function hhmm(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 选图压缩:最长边 ≤1920、JPEG 0.85(白底填充防透明区变黑),返回 data URL 控制落盘体积 */
async function compressImage(file: File): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = reject
      el.src = url
    })
    const scale = Math.min(1, 1920 / Math.max(img.naturalWidth, img.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 不可用')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.85)
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function ChatLogSettings() {
  const { bridge, flashCard, saveField } = useSettings()
  const config = useConfigSnapshot()
  const names = config.names
  const group = config.groupChat
  const [episodes, setEpisodes] = useState<Episode[]>([])
  const [turns, setTurns] = useState<ChatLogEntry[]>([])
  const [limit, setLimit] = useState(PAGE)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [clearArmed, setClearArmed] = useState(false)
  // 群设置展开 / 背景图状态(bgTick:替换图片时 config 标记不变,手动触发重读)
  const [showSettings, setShowSettings] = useState(false)
  const [bgDataUrl, setBgDataUrl] = useState<string | null>(null)
  const [bgBusy, setBgBusy] = useState(false)
  const [bgTick, setBgTick] = useState(0)
  // 群聊输入与 @ 补全(状态机同主聊天框:mention 语境 → 候选过滤 → 键盘选择)
  const [draft, setDraft] = useState('')
  const [mention, setMention] = useState<{ query: string } | null>(null)
  const [mentionIdx, setMentionIdx] = useState(0)
  const [sendHint, setSendHint] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // 演出集:挂载/加载更早时拉取(卸载守卫同历史页惯例)
  useEffect(() => {
    let alive = true
    void listEpisodes(limit).then((eps) => {
      if (!alive) return
      setEpisodes(eps)
      setHasMore(eps.length === limit)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [limit])

  // 聊天消息:订阅落盘版本号——append/清空各 bump 一次,这里重拉(含挂载首拉)
  const chatLogVersion = useChatLogVersion()
  useEffect(() => {
    let alive = true
    void listChatTurns().then((ts) => {
      if (alive) setTurns(ts)
    })
    return () => {
      alive = false
    }
  }, [chatLogVersion])

  // 背景图:挂载与(上传/移除/标记切换)后重读
  useEffect(() => {
    let alive = true
    void loadGroupBg().then((d) => {
      if (alive) setBgDataUrl(d)
    })
    return () => {
      alive = false
    }
  }, [group.bg, bgTick])

  // 滚动:接近底部(40px 内)= 跟随模式,新消息自动滚到底;「加载更早」向前追加保持视口
  const feedRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const prevHeightRef = useRef(0)
  useEffect(() => {
    const el = feedRef.current
    if (!el) return
    if (prevHeightRef.current === 0 || stickRef.current) {
      el.scrollTop = el.scrollHeight
    } else {
      el.scrollTop += el.scrollHeight - prevHeightRef.current
    }
    prevHeightRef.current = el.scrollHeight
  }, [episodes, turns])

  async function refreshEpisodes() {
    const eps = await listEpisodes(limit)
    setEpisodes(eps)
    setHasMore(eps.length === limit)
  }

  async function onToggleFav(ep: Episode) {
    const nowFav = await toggleFavorite(ep)
    if (nowFav) bumpTopicFavored(ep.topic) // 收藏 = 口味正信号(同历史页)
    await refreshEpisodes()
  }

  async function onClearTurns() {
    await clearChatLog()
    setTurns(await listChatTurns())
  }

  // ---------- 群设置:群名即存、背景上传/清除 ----------

  function renameGroup(name: string) {
    const v = name.trim()
    if (!v || v === group.name) return
    saveField({ groupChat: { ...group, name: v } }, true)
  }

  async function onPickBg(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // 允许重选同一张
    if (!file) return
    setBgBusy(true)
    try {
      const dataUrl = await compressImage(file)
      if (await saveGroupBg(dataUrl)) {
        saveField({ groupChat: { ...group, bg: true } }, true)
        setBgDataUrl(dataUrl) // 即时生效,不等配置回流
        setBgTick((t) => t + 1)
      }
    } catch {
      // 压缩失败静默:不上传不换背景
    } finally {
      setBgBusy(false)
    }
  }

  async function onClearBg() {
    await clearGroupBg()
    saveField({ groupChat: { ...group, bg: false } }, true)
    setBgDataUrl(null)
    setBgTick((t) => t + 1)
  }

  // ---------- 发送与 @ 补全 ----------

  async function sendDraft() {
    const text = draft.trim()
    if (!text) return
    const res = await bridge.onGroupSend(text)
    if (res === 'accepted') {
      setDraft('')
      setMention(null)
      stickRef.current = true // 自己发言后回到跟随模式
    } else if (res === 'busy') {
      setSendHint('角色正忙,稍后再发…')
      window.setTimeout(() => setSendHint(''), 2500)
    }
  }

  function pickMention(c: MentionTarget) {
    const input = inputRef.current
    const caret = input?.selectionStart ?? draft.length
    const { text, caret: nextCaret } = applyMention(draft, caret, c.name)
    setDraft(text)
    setMention(null)
    requestAnimationFrame(() => {
      input?.focus()
      input?.setSelectionRange(nextCaret, nextCaret)
    })
  }

  /** @ 按钮:光标处插入 "@",补全面板随即唤起 */
  function insertAt() {
    const input = inputRef.current
    const caret = input?.selectionStart ?? draft.length
    const next = draft.slice(0, caret) + '@' + draft.slice(caret)
    setDraft(next)
    requestAnimationFrame(() => {
      input?.focus()
      input?.setSelectionRange(caret + 1, caret + 1)
      setMention(mentionContext(next.slice(0, caret + 1)))
      setMentionIdx(0)
    })
  }

  const mentionCandidates = useMemo(
    () => mentionTargets({ A: names.a, B: names.b, C: names.c }),
    [names.a, names.b, names.c],
  )
  const mentionMatches = mention ? filterMentionTargets(mentionCandidates, mention.query) : []

  const speakerName = (s: Speaker) => (s === 'A' ? names.a : s === 'B' ? names.b : names.c)
  const items: FeedItem[] = buildFeed(episodes, turns)
  const bgActive = group.bg && !!bgDataUrl

  return (
    <SettingsCard
      card="聊天记录"
      flash={flashCard}
      title="聊天记录"
      desc="像群聊一样翻看与发言:你的消息在右,角色台词与演出整段在左;集的赞/踩/删除在「演出历史」页"
      action={
        <button
          className={`hist-clear${clearArmed ? ' danger' : ''}`}
          disabled={turns.length === 0}
          onClick={() => {
            if (!clearArmed) {
              setClearArmed(true)
              window.setTimeout(() => setClearArmed(false), 3000)
              return
            }
            setClearArmed(false)
            void onClearTurns()
          }}
        >
          {clearArmed ? '确认清空?' : '清空聊天消息'}
        </button>
      }
    >
      <div className={`group-chat${bgActive ? ' has-bg' : ''}`}>
        {bgActive && <div className="group-bg" style={{ backgroundImage: `url(${bgDataUrl})` }} />}

        <div className="group-head">
          <span className="group-name">{group.name}</span>
          <button
            className={`group-gear${showSettings ? ' on' : ''}`}
            title="群设置"
            onClick={() => setShowSettings(!showSettings)}
          >
            ⚙
          </button>
        </div>

        {showSettings && (
          <div className="group-settings">
            <label className="group-field">
              <span>群名</span>
              <input
                type="text"
                defaultValue={group.name}
                maxLength={20}
                placeholder="我们的群"
                onBlur={(e) => renameGroup(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
              />
            </label>
            <div className="group-field">
              <span>聊天背景</span>
              <label className="group-bg-btn">
                {bgBusy ? '处理中…' : '上传图片'}
                <input type="file" accept="image/*" hidden onChange={(e) => void onPickBg(e)} />
              </label>
              {bgActive && (
                <button className="group-bg-btn" onClick={() => void onClearBg()}>
                  恢复默认
                </button>
              )}
            </div>
          </div>
        )}

        <div className="chatlog-feed" ref={feedRef} onScroll={() => {
          const el = feedRef.current
          if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}>
          {hasMore && (
            <button className="chatlog-earlier" onClick={() => setLimit(limit + PAGE)}>
              加载更早
            </button>
          )}
          {loading && <div className="hist-empty">加载中…</div>}
          {!loading && items.length === 0 && (
            <div className="hist-empty">还没有聊天记录——在下面说一句,或点 ▶ 来一段演出试试</div>
          )}
          {items.map((item, i) => {
            const day = dayKey(item.ts)
            const prevDay = i > 0 ? dayKey(items[i - 1].ts) : null
            return (
              <div key={item.kind === 'episode' ? `ep${item.ts}` : `chat${item.ts}-${i}`}>
                {day !== prevDay && <div className="chatlog-day">{dayLabel(item.ts)}</div>}
                {item.kind === 'episode' ? (
                  <EpisodeBlock
                    ep={item.ep}
                    speakerName={speakerName}
                    onReplay={bridge.onReplay}
                    onToggleFav={onToggleFav}
                  />
                ) : (
                  <ChatRow entry={item.entry} speakerName={speakerName} />
                )}
              </div>
            )
          })}
        </div>

        <div className="group-input">
          {sendHint && <div className="group-hint">{sendHint}</div>}
          {mention && mentionMatches.length > 0 && (
            <div className="group-mention">
              {mentionMatches.map((c: MentionTarget, i: number) => (
                <button
                  key={c.id}
                  type="button"
                  className={`mention-item${i === mentionIdx % mentionMatches.length ? ' on' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault() // 保持输入框焦点
                    pickMention(c)
                  }}
                >
                  @{c.name}
                  <span className="mention-key">{c.key}</span>
                </button>
              ))}
            </div>
          )}
          <div className="group-input-row">
            <button className="group-at" title="@ 角色" onClick={insertAt}>
              @
            </button>
            <input
              ref={inputRef}
              type="text"
              placeholder="在群里说点什么…(@ 指定谁回)"
              value={draft}
              onChange={(e) => {
                const v = e.target.value
                setDraft(v)
                const caret = e.target.selectionStart ?? v.length
                setMention(mentionContext(v.slice(0, caret)))
                setMentionIdx(0)
              }}
              onKeyDown={(e) => {
                if (mention && mentionMatches.length > 0) {
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault()
                    const step = e.key === 'ArrowDown' ? 1 : mentionMatches.length - 1
                    setMentionIdx((i) => (i + step) % mentionMatches.length)
                    return
                  }
                  if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault()
                    pickMention(mentionMatches[mentionIdx % mentionMatches.length])
                    return
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    e.stopPropagation() // 只收起补全
                    setMention(null)
                    return
                  }
                }
                if (e.key === 'Enter') void sendDraft()
              }}
            />
            <button className="panel-btn primary" disabled={!draft.trim()} onClick={() => void sendDraft()}>
              发送
            </button>
          </div>
        </div>
      </div>
    </SettingsCard>
  )
}

/** 一段演出 = 集头(模式徽标/时间/主题 + 重播/收藏)+ 全部台词逐句气泡 */
function EpisodeBlock(props: {
  ep: Episode
  speakerName(s: Speaker): string
  onReplay(ep: Episode): void
  onToggleFav(ep: Episode): void
}) {
  const { ep, speakerName, onReplay, onToggleFav } = props
  const bm = modeOf(ep.mode)
  return (
    <div className="chatlog-ep">
      <div className="chatlog-ep-head">
        <span className="hist-mode" style={{ background: bm.accent }}>
          {bm.label}
        </span>
        <span className="chatlog-ep-meta">
          {fmtTime(ep.ts)} · {ep.lines.length} 句
          {ep.topic ? ` · ${ep.topic}` : ''}
          {ep.card?.scene ? ` · ${ep.card.scene}` : ''}
        </span>
        <span className="chatlog-ep-actions">
          <button className="chatlog-act" title="重播这段演出" onClick={() => onReplay(ep)}>
            ▶
          </button>
          <button
            className={`chatlog-act${ep.fav ? ' on' : ''}`}
            title={ep.fav ? '取消收藏' : '收藏(不会被清理,重放权重更高)'}
            onClick={() => void onToggleFav(ep)}
          >
            {ep.fav ? '★' : '☆'}
          </button>
        </span>
      </div>
      {ep.lines.map((l, i) => (
        <div className={`chatlog-row spk-${l.speaker.toLowerCase()}`} key={i}>
          <span className="chatlog-name">
            {speakerName(l.speaker)} · {hhmm(ep.ts)}
            {l.delivery && DELIVERY_LABEL[l.delivery] ? ` · ${DELIVERY_LABEL[l.delivery]}` : ''}
          </span>
          <div className="chatlog-bubble">{l.text}</div>
        </div>
      ))}
    </div>
  )
}

/** 一条聊天消息:user 右侧,角色左侧(名字随人设配置) */
function ChatRow(props: { entry: ChatLogEntry; speakerName(s: Speaker): string }) {
  const { entry, speakerName } = props
  const who = entry.who
  const spk: Speaker | null = who === 'user' ? null : who
  if (!spk) {
    return (
      <div className="chatlog-row me" title={fmtTime(entry.ts)}>
        <div className="chatlog-bubble">{entry.text}</div>
      </div>
    )
  }
  return (
    <div className={`chatlog-row spk-${spk.toLowerCase()}`} title={fmtTime(entry.ts)}>
      <span className="chatlog-name">
        {speakerName(spk)} · {hhmm(entry.ts)}
      </span>
      <div className="chatlog-bubble">{entry.text}</div>
    </div>
  )
}
