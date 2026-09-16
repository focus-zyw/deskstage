// 聊天面板:桌宠的统一聊天入口(控制栏正下方弹出)。
// 层级式两视图:会话列表 → 单会话(群聊 / 每角色单聊),← 返回列表。
// · 群聊会话走现有 group session(工具/记忆/演出中插话全保留);
// · 单聊会话走 directSession(1对1直答,面板内呈现,不弹舞台气泡、不朗读);
// · 消息流读 chatlog.jsonl 按 sessionId 过滤,chatlog 版本号驱动增量刷新;
// · 未读:面板关闭期间的新消息按 sessionId 记 localStorage 时间戳,列表显未读点。
import { useEffect, useRef, useState } from 'react'
import {
  GROUP_SESSION_ID,
  directSessionId,
  listChatTurns,
  loadConversationSummaries,
  useChatLogVersion,
  type ChatLogEntry,
  type ConversationSummary,
} from '../storage/chatLogStore'
import { getDirectSession, getGroupSession } from '../session/conversations'
import { getConfig } from '../storage/configStore'
import { loadAvatars } from '../storage/avatarStore'
import { nameOf } from '../engine/persona'
import { PANEL_ANCHOR } from '../ui/dockLayout'
import type { ActorId } from '../groupChat/types'

/** 外部直达:角色右键菜单「和TA聊天」(nonce 保证重复点击也生效) */
export interface ChatRoute {
  slot: ActorId
  nonce: number
}

interface Props {
  innerRef: React.RefObject<HTMLDivElement | null>
  pos: { xPct: number; top: number }
  pinned: boolean
  onPinChange: (pinned: boolean) => void
  onClose: () => void
  route?: ChatRoute | null
}

type View = { kind: 'list' } | { kind: 'group' } | { kind: 'direct'; slot: ActorId }

const SLOTS: ActorId[] = ['A', 'B', 'C']
const FEED_TAIL = 50
const SEEN_KEY = 'chat-panel-seen'

function loadSeen(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}')
  } catch {
    return {}
  }
}

export function ChatPanel({ innerRef, pos, pinned, onPinChange, onClose, route }: Props) {
  const version = useChatLogVersion()
  const [view, setView] = useState<View>({ kind: 'list' })
  const [turns, setTurns] = useState<ChatLogEntry[]>([])
  const [summaries, setSummaries] = useState<ConversationSummary[]>([])
  const [avatars, setAvatars] = useState<Record<string, string>>({})
  const [groupName, setGroupName] = useState('我们的群')
  const [userName, setUserName] = useState('你')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const placeholder =
    view.kind === 'group'
      ? `和「${groupName}」说点什么…(Enter 发送)`
      : view.kind === 'direct'
        ? `和${nameOf(view.slot)}说点什么…(Enter 发送)`
        : '聊天'
  const speakerName = (who: string): string => (who === 'user' ? userName : nameOf(who as ActorId))
  /** 当前会话 busy(角色在生成/回应中):订阅会话快照 */
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  const [seen, setSeen] = useState<Record<string, number>>(() => loadSeen())
  const feedRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const sizerRef = useRef<HTMLSpanElement>(null)
  const viewRef = useRef<View>(view)
  viewRef.current = view

  const sessionIdOf = (v: View): string =>
    v.kind === 'group' ? GROUP_SESSION_ID : v.kind === 'direct' ? directSessionId(v.slot) : ''

  // 配置:群名/用户名(打开面板读一次)
  useEffect(() => {
    let live = true
    void getConfig().then((c) => {
      if (!live) return
      setGroupName(c.groupChat.name || '我们的群')
      setUserName(c.userProfile.userName || '你')
    })
    void loadAvatars().then((m) => {
      if (live) setAvatars(m as Record<string, string>)
    })
    return () => {
      live = false
    }
  }, [])

  // 数据:列表页要摘要;会话页要该房间消息流。chatlog 版本号变化即重拉
  useEffect(() => {
    let live = true
    if (view.kind === 'list') {
      void loadConversationSummaries(500).then((s) => {
        if (live) setSummaries(s)
      })
    } else {
      const id = sessionIdOf(view)
      void listChatTurns(FEED_TAIL, id).then((ts) => {
        if (live) setTurns(ts)
      })
      // 打开会话即标记已读
      setSeen((cur) => {
        const next = { ...cur, [id]: Date.now() }
        try {
          localStorage.setItem(SEEN_KEY, JSON.stringify(next))
        } catch {
          /* 隐私模式等写失败忽略 */
        }
        return next
      })
    }
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, version])

  // 消息流尾随:新消息/首渲染都贴底
  useEffect(() => {
    const el = feedRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns])

  // 输入框宽度跟随内容:默认占位符宽(紧凑),文字放不下才拓宽,顶到发送按钮为止
  // (拓宽上限 = 行内可用宽度;到达上限后高度自长,封顶 120px)
  // 输入框宽度跟随内容:默认占位符宽(紧凑),文字放不下才拓宽,顶到面板右缘为止;
  // 到达宽度上限后高度自长(封顶 104px)。发送按钮在输入框内部右下角(ChatGPT 式)
  useEffect(() => {
    const sizer = sizerRef.current
    const wrap = rowRef.current
    const input = inputRef.current
    if (!sizer || !wrap || !input) return
    sizer.textContent = draft || placeholder
    const available = Math.max(wrap.parentElement?.clientWidth ?? 432, 160)
    const content = sizer.offsetWidth + 56 // 左 padding 10 + 右侧按钮区 44 + 边框 2
    wrap.style.width = `${Math.max(Math.min(content, available), 160)}px`
    input.style.height = 'auto'
    input.style.height = `${Math.min(104, input.scrollHeight)}px`
  }, [draft, view, placeholder])

  // 当前会话 busy 订阅(回应中提示;群聊 busy 不阻断继续输入)
  useEffect(() => {
    if (view.kind === 'list') {
      setBusy(false)
      return undefined
    }
    const session = view.kind === 'group' ? getGroupSession() : getDirectSession(view.slot)
    const sync = () => setBusy(session.getSnapshot().busy)
    sync()
    return session.subscribe(sync)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])

  // 外部直达(角色右键「和TA聊天」)
  useEffect(() => {
    if (!route) return
    setView({ kind: 'direct', slot: route.slot })
  }, [route?.nonce])

  const summaryOf = (id: string): ConversationSummary | undefined => summaries.find((s) => s.sessionId === id)
  const isUnread = (id: string): boolean => {
    const s = summaryOf(id)
    if (!s) return false
    return s.ts > (seen[id] ?? 0)
  }

  async function send() {
    const text = draft.trim()
    if (!text || sending || view.kind === 'list') return
    setSending(true)
    setDraft('')
    const session = view.kind === 'group' ? getGroupSession() : getDirectSession(view.slot)
    const res = await session.send(text).catch(() => 'busy' as const)
    if (res !== 'accepted') {
      setDraft((cur) => (cur.trim() ? cur : text)) // 已有新输入就不覆盖
      setHint(res === 'busy' ? '角色正忙,消息已保留在输入框…' : '发送失败,消息已保留在输入框…')
      window.setTimeout(() => setHint(''), 3000)
    }
    setSending(false)
  }


  function renderFeed() {
    if (turns.length === 0) {
      return <div className="chatp-empty">还没有消息,打个招呼吧</div>
    }
    return turns.map((t, i) => {
      const mine = t.who === 'user'
      return (
        <div key={`${t.ts}-${i}`} className={`chatp-row${mine ? ' mine' : ''}`}>
          <span className="chatp-who">{speakerName(t.who)}</span>
          <span className="chatp-text">{t.text}</span>
        </div>
      )
    })
  }

  return (
    <div
      ref={innerRef}
      className="tr-panel chatp"
      style={{ left: `${pos.xPct}%`, top: pos.top + PANEL_ANCHOR }}
    >
      <div className="tr-head">
        {view.kind !== 'list' && (
          <button
            className="chatp-back"
            title="返回会话列表"
            onClick={() => {
              setView({ kind: 'list' })
              setTurns([])
            }}
          >
            ←
          </button>
        )}
        <span className="tr-title">{view.kind === 'direct' ? nameOf(view.slot) : view.kind === 'group' ? groupName : '聊天'}</span>
        <button
          className={`tr-pin${pinned ? ' on' : ''}`}
          title={pinned ? '取消固定(点外部/Esc 会收起)' : '固定面板(点外部/Esc 不收起)'}
          onClick={() => onPinChange(!pinned)}
        >
          📌
        </button>
        <button className="tr-close" title="关闭" onClick={onClose}>
          ✕
        </button>
      </div>

      {view.kind === 'list' && (
        <div className="chatp-list">
          <button
            className={`chatp-item${isUnread(GROUP_SESSION_ID) ? ' unread' : ''}`}
            onClick={() => setView({ kind: 'group' })}
          >
            <span className="chatp-avatar group">👥</span>
            <span className="chatp-item-main">
              <span className="chatp-item-name">{groupName}</span>
              <span className="chatp-item-preview">{summaryOf(GROUP_SESSION_ID)?.text ?? '大家都在,进来说两句'}</span>
            </span>
            {isUnread(GROUP_SESSION_ID) && <span className="chatp-dot" />}
          </button>
          {SLOTS.map((slot) => {
            const id = directSessionId(slot)
            const s = summaryOf(id)
            return (
              <button
                key={slot}
                className={`chatp-item${isUnread(id) ? ' unread' : ''}`}
                onClick={() => setView({ kind: 'direct', slot })}
              >
                {avatars[slot] ? (
                  <img className="chatp-avatar" src={avatars[slot]} alt="" />
                ) : (
                  <span className="chatp-avatar">{nameOf(slot).slice(0, 1)}</span>
                )}
                <span className="chatp-item-main">
                  <span className="chatp-item-name">{nameOf(slot)}</span>
                  <span className="chatp-item-preview">{s?.text ?? '打个招呼吧'}</span>
                </span>
                {isUnread(id) && <span className="chatp-dot" />}
              </button>
            )
          })}
        </div>
      )}

      {view.kind !== 'list' && (
        <>
          <div className="chatp-feed" ref={feedRef}>
            {renderFeed()}
          </div>
          <div className="chatp-input-wrap" ref={rowRef}>
            <span ref={sizerRef} className="chatp-sizer" aria-hidden="true" />
            <textarea
              ref={inputRef}
              className="chatp-input"
              rows={1}
              placeholder={placeholder}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
            <button
              className="chatp-send"
              title={busy ? '回应中…' : '发送'}
              disabled={sending || !draft.trim()}
              onClick={() => void send()}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
              </svg>
            </button>
          </div>
          {hint && <div className="tr-err">{hint}</div>}
        </>
      )}

      <div className="tr-privacy">文本会发送给各角色绑定的模型;密码、密钥等敏感内容请勿聊天</div>
    </div>
  )
}
