// 聊天记录:像聊天软件一样通读完整对话——演出整段与聊天消息按时间穿插,跨日插日期分隔。
// 你的消息在右,角色台词在左(名牌 + 固定角色色,气泡工坊的角色色变量随主题走)。
// 数据 = historyStore 分集 + chatLogStore 聊天消息;集的赞/踩/删除仍在「演出历史」页,这里只管重播与收藏。
import { useEffect, useRef, useState } from 'react'
import { listEpisodes, toggleFavorite, type Episode } from '../../storage/historyStore'
import { listChatTurns, clearChatLog, buildFeed, type FeedItem, type ChatLogEntry } from '../../storage/chatLogStore'
import { bumpTopicFavored } from '../../storage/memoryStore'
import { modeOf } from '../../performer/modes'
import { useConfigSnapshot } from '../../storage/configStore'
import type { Speaker } from '../../performer/dialogSchema'
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

export function ChatLogSettings() {
  const { bridge, flashCard } = useSettings()
  const names = useConfigSnapshot().names
  const [episodes, setEpisodes] = useState<Episode[]>([])
  const [turns, setTurns] = useState<ChatLogEntry[]>([])
  const [limit, setLimit] = useState(PAGE)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [clearArmed, setClearArmed] = useState(false)
  const feedRef = useRef<HTMLDivElement>(null)
  const prevHeightRef = useRef(0)

  // 挂载/加载更早时拉取:内联 async + 卸载守卫(同历史页惯例)
  useEffect(() => {
    let alive = true
    void (async () => {
      const [eps, ts] = await Promise.all([listEpisodes(limit), listChatTurns()])
      if (!alive) return
      setEpisodes(eps)
      setTurns(ts)
      setHasMore(eps.length === limit)
      setLoading(false)
    })()
    return () => {
      alive = false
    }
  }, [limit])

  // 首次滚到最新;「加载更早」向前追加后保持视口位置不跳
  useEffect(() => {
    const el = feedRef.current
    if (!el) return
    if (prevHeightRef.current === 0) {
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

  const speakerName = (s: Speaker) => (s === 'A' ? names.a : s === 'B' ? names.b : names.c)
  const items: FeedItem[] = buildFeed(episodes, turns)

  return (
    <SettingsCard
      card="聊天记录"
      flash={flashCard}
      title={`聊天记录(${items.length})`}
      desc="像聊天软件一样翻看完整对话:你的消息在右,角色台词与演出整段在左;集的赞/踩/删除在「演出历史」页"
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
      <div className="chatlog-feed" ref={feedRef}>
        {hasMore && (
          <button className="chatlog-earlier" onClick={() => setLimit(limit + PAGE)}>
            加载更早
          </button>
        )}
        {loading && <div className="hist-empty">加载中…</div>}
        {!loading && items.length === 0 && (
          <div className="hist-empty">还没有聊天记录——在聊天框聊几句,或点 ▶ 来一段演出试试</div>
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
