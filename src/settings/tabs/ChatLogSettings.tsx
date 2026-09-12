// 群聊:聊天记录页 = 一个群——可发言(@ 补全)、群名可改、背景图/头像可自定义上传。
// 发送走 bridge.onGroupSend(与主聊天框同源:角色应答/演出插话/消息落盘一条链);
// 消息流靠 chatLogStore 版本订阅实时刷新——角色逐句应答落盘即冒出。
// 分页按"条数"计(台词+消息,初始 80 条):一次渲染太多文本既慢也看不过来。
// 演出集块以"转发卡片"样式穿插;集管理(赞/踩/删除)仍在「演出历史」页。
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { listEpisodes, type Episode } from '../../storage/historyStore'
import {
  listChatTurns,
  clearChatLog,
  buildFeed,
  useChatLogVersion,
  type FeedItem,
  type ChatLogEntry,
} from '../../storage/chatLogStore'
import { loadGroupBg, saveGroupBg, clearGroupBg } from '../../storage/groupBgStore'
import {
  loadAvatars,
  saveAvatar,
  clearAvatar,
  AVATAR_KEYS,
  type AvatarKey,
  type AvatarMap,
} from '../../storage/avatarStore'
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

/** 每页条数(集内台词逐句计数,至少保最新一集)与消息条数上限 */
const PAGE_LINES = 80
const MAX_TURNS = 100
/** 单次最多翻到的集数(与 listEpisodes 上限一致) */
const MAX_EPS = 200
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

/** 背景图压缩:最长边 ≤1920、JPEG 0.85(白底填充防透明区变黑),返回 data URL 控制落盘体积 */
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

// ---------- 头像裁剪(拖拽平移 + 缩放自选区域;纯几何,便于测试) ----------

/** 裁剪视口边长(显示像素);输出固定 128×128 */
const CROP_VIEW = 240
const CROP_OUT = 128

/** 图片恰好盖满视口的比例(短边贴齐) */
function coverScale(natW: number, natH: number): number {
  return Math.max(CROP_VIEW / natW, CROP_VIEW / natH)
}

/** 平移钳制:图片任意时刻盖满视口,不允许露出底(左上角偏移取值范围 [VIEW - size, 0]) */
function clampOffset(off: number, viewSize: number, imgSize: number): number {
  if (imgSize <= viewSize) return (viewSize - imgSize) / 2
  return Math.min(0, Math.max(viewSize - imgSize, off))
}

/** 按当前缩放钳制 {x,y} 偏移——显示与最终裁剪必须用同一份钳制值,
 *  否则拖过边界后 state 与视觉位置分叉,"确定的区域"和"看到的区域"对不上 */
function clampCropOffset(o: { x: number; y: number }, natW: number, natH: number, z: number): { x: number; y: number } {
  const s = coverScale(natW, natH) * z
  return { x: clampOffset(o.x, CROP_VIEW, natW * s), y: clampOffset(o.y, CROP_VIEW, natH * s) }
}

/** 视口矩形映射回原图自然坐标的裁剪框 */
function cropRect(ox: number, oy: number, scale: number) {
  return { sx: -ox / scale, sy: -oy / scale, side: CROP_VIEW / scale }
}

/** 按当前裁剪框从原图产出 128×128 JPEG data URL */
async function cropToDataUrl(img: HTMLImageElement, ox: number, oy: number, scale: number): Promise<string> {
  const { sx, sy, side } = cropRect(ox, oy, scale)
  const canvas = document.createElement('canvas')
  canvas.width = CROP_OUT
  canvas.height = CROP_OUT
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 不可用')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, CROP_OUT, CROP_OUT)
  ctx.drawImage(img, sx, sy, side, side, 0, 0, CROP_OUT, CROP_OUT)
  return canvas.toDataURL('image/jpeg', 0.85)
}

/** 取最新若干集,累计台词不超过条数预算(至少保最新一集,长集完整呈现) */
function takeNewestByLineBudget(eps: Episode[], budget: number): Episode[] {
  const out: Episode[] = []
  let used = 0
  for (let i = eps.length - 1; i >= 0; i--) {
    const ep = eps[i] // listEpisodes 倒序(新→旧)
    if (out.length > 0 && used + ep.lines.length > budget) break
    out.unshift(ep)
    used += ep.lines.length
  }
  return out
}

export function ChatLogSettings() {
  const { bridge, flashCard, saveField } = useSettings()
  const config = useConfigSnapshot()
  const names = config.names
  const group = config.groupChat
  const [allEps, setAllEps] = useState<Episode[]>([])
  const [budget, setBudget] = useState(PAGE_LINES)
  const [turns, setTurns] = useState<ChatLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [clearArmed, setClearArmed] = useState(false)
  // 群设置展开 / 背景图 / 头像
  const [showSettings, setShowSettings] = useState(false)
  const [bgDataUrl, setBgDataUrl] = useState<string | null>(null)
  const [bgBusy, setBgBusy] = useState(false)
  const [bgTick, setBgTick] = useState(0)
  const [avatars, setAvatars] = useState<AvatarMap>({ a: null, b: null, c: null, user: null })
  // 头像裁剪弹窗:cropKey 非 null 时打开;zoom 相对 cover 比例(1 = 恰好盖满),off = 图片左上角在视口内的偏移
  const [cropKey, setCropKey] = useState<AvatarKey | null>(null)
  const [cropImg, setCropImg] = useState<HTMLImageElement | null>(null)
  const [zoom, setZoom] = useState(1)
  const [off, setOff] = useState({ x: 0, y: 0 })
  const [cropUrl, setCropUrl] = useState<string | null>(null)
  const viewRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null)
  // 群聊输入与 @ 补全(状态机同主聊天框:mention 语境 → 候选过滤 → 键盘选择)
  const [draft, setDraft] = useState('')
  const [mention, setMention] = useState<{ query: string } | null>(null)
  const [mentionIdx, setMentionIdx] = useState(0)
  const [sendHint, setSendHint] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // 演出集:一次拉足(与历史页同源,上限内),渲染侧按条数预算截取
  useEffect(() => {
    let alive = true
    void listEpisodes(MAX_EPS).then((eps) => {
      if (!alive) return
      setAllEps(eps)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [])

  // 聊天消息:订阅落盘版本号——append/清空各 bump 一次,这里重拉(含挂载首拉)
  const chatLogVersion = useChatLogVersion()
  useEffect(() => {
    let alive = true
    void listChatTurns(MAX_TURNS).then((ts) => {
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

  // 头像:挂载读取一次,上传/清除后本地即时更新
  useEffect(() => {
    let alive = true
    void loadAvatars().then((m) => {
      if (alive) setAvatars(m)
    })
    return () => {
      alive = false
    }
  }, [])

  // 滚动:接近底部(40px 内)= 跟随模式,新消息自动滚到底;向上前置加载后保持视口。
  // 双 rAF:等一轮布局再落位,防字体/图片晚到把内容撑高后停在半途
  const feedRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const prevHeightRef = useRef(0)
  const prependAtRef = useRef(0)
  const [scrollable, setScrollable] = useState(false)
  const visibleEps = useMemo(() => takeNewestByLineBudget(allEps, budget), [allEps, budget])
  useEffect(() => {
    let raf2 = 0
    const settle = () => {
      const el = feedRef.current
      if (!el) return
      if (prevHeightRef.current === 0 || stickRef.current) {
        el.scrollTop = el.scrollHeight
      } else {
        el.scrollTop += el.scrollHeight - prevHeightRef.current
      }
      prevHeightRef.current = el.scrollHeight
      setScrollable(el.scrollHeight > el.clientHeight + 4)
    }
    settle()
    raf2 = requestAnimationFrame(() => requestAnimationFrame(settle))
    return () => cancelAnimationFrame(raf2)
  }, [visibleEps, turns, showSettings])

  async function onClearTurns() {
    await clearChatLog()
    setTurns(await listChatTurns(MAX_TURNS))
  }

  // ---------- 群设置:群名即存、背景与头像 ----------

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

  /** 选图 → 打开裁剪弹窗(不直接落盘,由 confirmCrop 收尾) */
  async function onPickAvatar(k: AvatarKey, e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const url = URL.createObjectURL(file)
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image()
        el.onload = () => resolve(el)
        el.onerror = reject
        el.src = url
      })
      if (cropUrl) URL.revokeObjectURL(cropUrl)
      const cs = coverScale(img.naturalWidth, img.naturalHeight)
      setCropImg(img)
      setCropKey(k)
      setZoom(1)
      setCropUrl(url)
      setOff(
        clampCropOffset(
          { x: (CROP_VIEW - img.naturalWidth * cs) / 2, y: (CROP_VIEW - img.naturalHeight * cs) / 2 },
          img.naturalWidth,
          img.naturalHeight,
          1,
        ),
      )
    } catch {
      URL.revokeObjectURL(url) // 解码失败:释放,不打开弹窗
    }
  }

  function closeCrop() {
    setCropKey(null)
    setCropImg(null)
    if (cropUrl) {
      URL.revokeObjectURL(cropUrl)
      setCropUrl(null)
    }
  }

  /** 缩放围绕视口中心:中心点的原图坐标在缩放前后不变;结果钳制在盖满范围内 */
  function applyZoom(next: number) {
    if (!cropImg) return
    const cs = coverScale(cropImg.naturalWidth, cropImg.naturalHeight)
    const z = Math.min(5, Math.max(1, next))
    const sOld = cs * zoom
    const sNew = cs * z
    const natW = cropImg.naturalWidth
    const natH = cropImg.naturalHeight
    setZoom(z)
    setOff((o) =>
      clampCropOffset(
        {
          x: CROP_VIEW / 2 - ((CROP_VIEW / 2 - o.x) / sOld) * sNew,
          y: CROP_VIEW / 2 - ((CROP_VIEW / 2 - o.y) / sOld) * sNew,
        },
        natW,
        natH,
        z,
      ),
    )
  }

  async function confirmCrop() {
    if (!cropImg || !cropKey) return
    const s = coverScale(cropImg.naturalWidth, cropImg.naturalHeight) * zoom
    try {
      // 用与渲染相同的钳制值(cropOx/cropOy)裁剪:看到的区域 = 得到的区域
      const dataUrl = await cropToDataUrl(cropImg, cropOx, cropOy, s)
      if (await saveAvatar(cropKey, dataUrl)) setAvatars((m) => ({ ...m, [cropKey]: dataUrl }))
    } catch {
      // 静默
    }
    closeCrop()
  }

  // wheel 挂原生监听(React 合成 wheel 被动化,preventDefault 无效会连滚外层)
  useEffect(() => {
    const el = viewRef.current
    if (!el || !cropImg) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      applyZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  async function onClearAvatar(k: AvatarKey) {
    await clearAvatar(k)
    setAvatars((m) => ({ ...m, [k]: null }))
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
  const items: FeedItem[] = buildFeed(visibleEps, turns)
  const bgActive = group.bg && !!bgDataUrl
  const hasMore = visibleEps.length < allEps.length
  // 裁剪弹窗几何:显示尺寸与钳制后的偏移(拖拽/滑杆/滚轮共用一套钳制)
  const cs = cropImg ? coverScale(cropImg.naturalWidth, cropImg.naturalHeight) : 1
  const cropScale = cs * zoom
  const dispW = cropImg ? cropImg.naturalWidth * cropScale : 0
  const dispH = cropImg ? cropImg.naturalHeight * cropScale : 0
  const cropOx = clampOffset(off.x, CROP_VIEW, dispW)
  const cropOy = clampOffset(off.y, CROP_VIEW, dispH)
  const avatarOf = (k: AvatarKey) => avatars[k]
  const avatarAccent = (k: AvatarKey) =>
    k === 'a' ? 'var(--bubble-acc-a)' : k === 'b' ? 'var(--bubble-acc-b)' : k === 'c' ? 'var(--bubble-acc-c)' : 'var(--accent)'
  const avatarLetter = (k: AvatarKey) =>
    k === 'user' ? '我' : ((k === 'a' ? names.a : k === 'b' ? names.b : names.c)[0] ?? '?')

  return (
    <SettingsCard
      card="聊天记录"
      flash={flashCard}
      title="聊天记录"
      desc="像群聊一样翻看与发言:你的消息在右,角色消息在左;点角色消息即从那句开始播放,收藏/删除在「演出历史」页"
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
            <div className="group-field">
              <span>头像</span>
              {AVATAR_KEYS.map((k) => (
                <label key={k} className="avatar-slot" title={`${k === 'user' ? '我' : speakerName(k.toUpperCase() as Speaker)} 的头像,点击更换`}>
                  <Avatar src={avatarOf(k)} letter={avatarLetter(k)} accent={avatarAccent(k)} />
                  {avatarOf(k) && (
                    <button
                      className="avatar-x"
                      title="恢复默认头像"
                      onClick={(e) => {
                        e.preventDefault() // 取消 label 默认行为,不弹文件框
                        e.stopPropagation()
                        void onClearAvatar(k)
                      }}
                    >
                      ✕
                    </button>
                  )}
                  <input type="file" accept="image/*" hidden onChange={(e) => void onPickAvatar(k, e)} />
                </label>
              ))}
            </div>
          </div>
        )}

        <div
          className="chatlog-feed"
          onScroll={() => {
            const el = feedRef.current
            if (!el) return
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
            // 离开底部后顶到上方 80px 内自动前置加载(节流防惯性滚动连发);前置后视口锚定由 settle 负责。
            // 要求已离开底部:总内容略超视口时,贴底状态的 scrollTop 绝对值本身就 < 80,不算"向上滚"
            const now = Date.now()
            if (!stickRef.current && el.scrollTop < 80 && hasMore && now - prependAtRef.current > 150) {
              prependAtRef.current = now
              setBudget((b) => b + PAGE_LINES)
            }
          }}
        >
          {hasMore && !scrollable && !loading && (
            <button className="chatlog-earlier" onClick={() => setBudget((b) => b + PAGE_LINES)}>
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
                    avatars={avatars}
                    names={names}
                    onReplay={bridge.onReplay}
                  />
                ) : (
                  <ChatRow
                    entry={item.entry}
                    speakerName={speakerName}
                    avatars={avatars}
                    userLetter={avatarLetter('user')}
                    onReplay={bridge.onReplay}
                  />
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

      {cropKey && cropImg && (
        <div
          className="avatar-crop-mask"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeCrop() // 点遮罩空白处取消
          }}
        >
          <div className="avatar-crop-panel">
            <div className="avatar-crop-title">调整头像区域(拖动平移,滚轮/滑杆缩放)</div>
            <div
              className="avatar-crop-view"
              ref={viewRef}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId)
                dragRef.current = { px: e.clientX, py: e.clientY, ox: off.x, oy: off.y }
              }}
              onPointerMove={(e) => {
                const d = dragRef.current
                if (!d || !cropImg) return
                // 写入即钳制:state 永远等于视觉位置,拖过边界也不会在确定时偏移
                setOff(
                  clampCropOffset(
                    { x: d.ox + (e.clientX - d.px), y: d.oy + (e.clientY - d.py) },
                    cropImg.naturalWidth,
                    cropImg.naturalHeight,
                    zoom,
                  ),
                )
              }}
              onPointerUp={() => {
                dragRef.current = null
              }}
              onPointerCancel={() => {
                dragRef.current = null
              }}
            >
              <img
                className="avatar-crop-img"
                src={cropUrl ?? undefined}
                alt=""
                draggable={false}
                style={{ width: dispW, height: dispH, left: cropOx, top: cropOy }}
              />
            </div>
            <input
              className="avatar-crop-slider"
              type="range"
              min={1}
              max={5}
              step={0.01}
              value={zoom}
              onChange={(e) => applyZoom(Number(e.target.value))}
            />
            <div className="avatar-crop-actions">
              <button className="group-bg-btn" onClick={closeCrop}>
                取消
              </button>
              <button className="group-bg-btn primary" onClick={() => void confirmCrop()}>
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </SettingsCard>
  )
}

/** 头像:自定义图或名字首字彩色圆底 */
function Avatar(props: { src: string | null; letter: string; accent: string }) {
  if (props.src) return <img className="chatlog-avatar" src={props.src} alt="" draggable={false} />
  return (
    <span className="chatlog-avatar letter" style={{ background: props.accent }}>
      {props.letter}
    </span>
  )
}

/** 一段演出:不再框成卡片——台词平铺为普通聊天气泡(真实聊天软件的样子)。
 *  点任意一句从那里开始回放(取该句到结尾的切片,不写历史) */
function EpisodeBlock(props: {
  ep: Episode
  speakerName(s: Speaker): string
  avatars: AvatarMap
  names: { a: string; b: string; c: string }
  onReplay(ep: Episode): void
}) {
  const { ep, speakerName, avatars, names, onReplay } = props
  return (
    <>
      {ep.lines.map((l, i) => (
        <div className={`chatlog-row spk-${l.speaker.toLowerCase()}`} key={i}>
          <Avatar
            src={avatars[l.speaker.toLowerCase() as 'a' | 'b' | 'c']}
            letter={(l.speaker === 'A' ? names.a : l.speaker === 'B' ? names.b : names.c)[0] ?? '?'}
            accent={`var(--bubble-acc-${l.speaker.toLowerCase()})`}
          />
          <div className="chatlog-main">
            <span className="chatlog-name">
              {speakerName(l.speaker)} · {hhmm(ep.ts)}
              {l.delivery && DELIVERY_LABEL[l.delivery] ? ` · ${DELIVERY_LABEL[l.delivery]}` : ''}
            </span>
            <div
              className="chatlog-bubble click"
              title="点击:从这里开始播放"
              onClick={() => onReplay({ ...ep, lines: ep.lines.slice(i) })}
            >
              {l.text}
            </div>
          </div>
        </div>
      ))}
    </>
  )
}

/** 一条聊天消息:user 右侧(不可点),角色左侧——点角色消息单句重说 */
function ChatRow(props: {
  entry: ChatLogEntry
  speakerName(s: Speaker): string
  avatars: AvatarMap
  userLetter: string
  onReplay(ep: Episode): void
}) {
  const { entry, speakerName, avatars, userLetter, onReplay } = props
  const who = entry.who
  const spk: Speaker | null = who === 'user' ? null : who
  if (!spk) {
    return (
      <div className="chatlog-row me" title={fmtTime(entry.ts)}>
        <Avatar src={avatars.user} letter={userLetter} accent="var(--accent)" />
        <div className="chatlog-main">
          <div className="chatlog-bubble">{entry.text}</div>
        </div>
      </div>
    )
  }
  return (
    <div className={`chatlog-row spk-${spk.toLowerCase()}`} title={fmtTime(entry.ts)}>
      <Avatar src={avatars[spk.toLowerCase() as 'a' | 'b' | 'c']} letter={speakerName(spk)[0] ?? '?'} accent={`var(--bubble-acc-${spk.toLowerCase()})`} />
      <div className="chatlog-main">
        <span className="chatlog-name">
          {speakerName(spk)} · {hhmm(entry.ts)}
        </span>
        <div
          className="chatlog-bubble click"
          title="点击:再说一遍这句"
          onClick={() =>
            onReplay({ ts: entry.ts, mode: 'daily', fav: false, lines: [{ speaker: spk, text: entry.text, action: 'talk' }] })
          }
        >
          {entry.text}
        </div>
      </div>
    </div>
  )
}
