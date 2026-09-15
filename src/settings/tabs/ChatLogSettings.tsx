// 群聊(方案A沉浸式):页面即群——无卡片套娃,占满设置窗内容区。
// 发送走 bridge.onGroupSend(与主聊天框同源);消息靠 chatLogStore 版本订阅实时刷新。
// 信息结构(对齐 chatlog-prototype.html 方案A + C 的演出卡片):
//  - 连续同一角色只显示一次头像/名字/时间,后续气泡紧跟(follow);
//  - 时间只在换人、间隔较久或跨日期时出现;
//  - 演出开场插系统事件行「小桌剧场开始了一段日常 [▶ 从头播放]」;
//  - 长演出(≥10 句)折叠成演出卡片避免刷屏,可展开通读;
//  - 角色气泡悬停出现小型 ▶,从该句回放(不占整个气泡当按钮)。
// 集管理(赞/踩/删除/收藏)仍在「演出历史」页。
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ChangeEvent, KeyboardEvent } from 'react'
import { emitTo, listen } from '@tauri-apps/api/event'
import {
  createGroupChatReadController,
  type EntriesCause,
  type GroupChatReadController,
  type ReadEffect,
} from '../../groupChat/readController'
import {
  flushGroupChatRead,
  getGroupChatReadState,
  loadGroupChatReadState,
  publishGroupChatUnread,
  setGroupChatReadCursor,
} from '../../storage/groupChatReadStore'

import {
  listChatTurns,
  clearChatLog,
  useChatLogVersion,
  type ChatLogEntry,
} from '../../storage/chatLogStore'
import type { Episode } from '../../storage/historyStore'
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
import { getMemory, type MemoryFact } from '../../storage/memoryStore'
import { effectiveStatus } from '../../storage/memoryPolicy'

const MEM_SENS_LABEL: Record<string, string> = { normal: '普通', private: '私密', restricted: '高敏' }
const SENS_LABEL_OR = (s: string | undefined): string => (s ? MEM_SENS_LABEL[s] ?? s : '')
import type { Speaker } from '../../performer/dialogSchema'
import {
  applyMention,
  filterMentionTargets,
  mentionContext,
  mentionTargets,
  type MentionTarget,
} from '../../ui/mention'
import { useSettings } from '../useSettingsSession'


/** 消息条数上限 */
const MAX_TURNS = 100
/** 同一角色连续发言时,间隔超过该值重新显示头像/名字/时间 */
const REGROUP_GAP_MS = 5 * 60 * 1000
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

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

// ---------- 信息流行渲染模型(纯结构,分组规则集中在此) ----------

type MsgRow = {
  kind: 'msg'
  key: string
  who: Speaker | 'user'
  text: string
  ts: number
  /** true = 显示头像(+角色的名字/时间);false = 同人紧跟气泡 */
  header: boolean
  /** 非空 = 悬停 ▶ 从该句回放(角色消息;用户消息不可回放) */
  replay?: Episode
  /** 原始日志条目(带 memoryRefs/trace 时渲染"参考记忆"折叠块) */
  entry?: ChatLogEntry
  /** 稳定消息 ID(§3):已读观察器与未读定位的锚点 */
  eid?: string
}
type Row =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'unread-divider'; key: string; count: number }
  | MsgRow

/** 把聊天消息编织成消息流:日期分隔/分组气泡/未读分割线(§8)。
 *  群聊页只显示群聊对话——日常/相声等演出模式生成的消息在「演出历史」页,
 *  不再混入本信息流(产品决策) */
function buildRows(
  turns: ChatLogEntry[],
  divider?: { beforeId: string; count: number } | null,
): Row[] {
  const out: Row[] = []
  let prevWho: Speaker | 'user' | null = null
  let prevTs = 0
  let prevDay: string | null = null
  for (const e of turns) {
    const k = dayKey(e.ts)
    if (k !== prevDay) {
      out.push({ kind: 'day', key: `day${e.ts}-${out.length}`, label: dayLabel(e.ts) })
      prevWho = null // 跨日期重新分组
      prevDay = k
    }
    const who: Speaker | 'user' = e.who === 'user' ? 'user' : e.who
    const header = prevWho === null || who !== prevWho || e.ts - prevTs > REGROUP_GAP_MS
    // 未读分割线:插在第一条未读角色消息之前(§8;虚拟行,不落盘)
    if (divider && e.id === divider.beforeId) {
      out.push({ kind: 'unread-divider', key: 'unread-divider', count: divider.count })
      prevWho = null
    }
    out.push({
      kind: 'msg',
      key: `chat${e.ts}-${out.length}`, // 同批应答共享 ts,按位置保唯一
      who,
      text: e.text,
      eid: e.id,
      ts: e.ts,
      header,
      entry: e,
      replay:
        who === 'user'
          ? undefined
          : { ts: e.ts, mode: 'daily', fav: false, lines: [{ speaker: who as Speaker, text: e.text, action: 'talk' }] },
    })
    prevWho = who
    prevTs = e.ts
  }
  return out
}

export function ChatLogSettings() {
  const { bridge, saveField } = useSettings()
  const config = useConfigSnapshot()
  const names = config.names
  const group = config.groupChat
  const cfg = useConfigSnapshot()
  const [turns, setTurns] = useState<ChatLogEntry[]>([])
  /** 参考记忆 id → 事实(打开详情时解析;已删除的 id 解析不到 → 显示"已删除") */
  const [memFacts, setMemFacts] = useState<Map<string, MemoryFact>>(new Map())
  const [memOpen, setMemOpen] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [clearArmed, setClearArmed] = useState(false)
  // 群设置抽屉 / 背景图 / 头像
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [actorStatus, setActorStatus] = useState<Partial<Record<'A' | 'B' | 'C', { status?: string; queueDepth?: number }>>>({})
  // ---------- 未读与视口控制(方案 §5/§6):页面只喂事实、只执行效果 ----------
  // active = 窗口有焦点(挂载中 ⟺ 当前就是群聊分页,条件等价于 §13 三条与)
  const nameOf = (a: 'A' | 'B' | 'C') => (a === 'A' ? names.a : a === 'B' ? names.b : names.c)
  const readCtlRef = useRef<GroupChatReadController | null>(null)
  function readCtl(): GroupChatReadController {
    if (!readCtlRef.current) {
      readCtlRef.current = createGroupChatReadController({
        getCursor: () => getGroupChatReadState().lastReadEntryId,
        setCursor: (id) => setGroupChatReadCursor(id),
        nameOf,
      })
    }
    return readCtlRef.current
  }
  const readSnap = useSyncExternalStore(readCtl().subscribe, readCtl().getSnapshot)
  const winActiveRef = useRef(true)
  const distRef = useRef(9999)
  const lastVisibleRef = useRef<string | null>(null)
  const [winActive, setWinActive] = useState(true)
  const viewSyncRafRef = useRef(0)
  const prevTurnsRef = useRef<ChatLogEntry[] | null>(null)
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
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // 聊天消息:订阅落盘版本号——append/清空各 bump 一次,这里重拉(含挂载首拉)
  const chatLogVersion = useChatLogVersion()
  useEffect(() => {
    let alive = true
    // 首拉前先装载持久游标(§4):initial 分类依赖它,避免误把历史判为未读
    void Promise.all([listChatTurns(MAX_TURNS), loadGroupChatReadState()]).then(([ts]) => {
      if (!alive) return
      setTurns(ts)
      setLoading(false)
    })
    void getMemory().then((m) => {
      if (alive) setMemFacts(new Map(m.facts.map((f) => [f.id, f])))
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

  // 群聊 Actor 状态条(P4):主窗节流推送,这里只渲染;dot 状态语义见 statusDot
  useEffect(() => {
    const un = listen<{
      actors: Partial<Record<'A' | 'B' | 'C', { status?: string; queueDepth?: number }>>
    }>('group-actor-status', (e) => {
      setActorStatus(e.payload.actors ?? {})
    })
    return () => {
      void un.then((f) => f())
    }
  }, [])

  // 窗口焦点/可见性(§13):失焦即离开群聊 → 未读累计 + 立即落盘
  useEffect(() => {
    const onFocus = () => setWinActive(true)
    const onBlur = () => setWinActive(false)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [])
  useEffect(() => {
    winActiveRef.current = winActive
    syncView()
    if (!winActive) flushGroupChatRead()
  }, [winActive])
  useEffect(() => () => flushGroupChatRead(), [])

  // 未读数发布给主窗(柔和角标,§2)
  useEffect(() => {
    publishGroupChatUnread(readSnap.unreadCount, { broadcast: true })
  }, [readSnap.unreadCount])

  // 角色思考状态文案(§11):「正在想」比「正在输入」准确——角色最后可能 listen
  const thinkingLine = useMemo(() => {
    const roster = (['A', 'B', 'C'] as const).map((id) => ({
      name: id === 'A' ? names.a : id === 'B' ? names.b : names.c,
      st: actorStatus[id]?.status,
    }))
    const invoking = roster.filter((r) => r.st === 'invoking')
    const collecting = roster.filter((r) => r.st === 'collecting')
    if (invoking.length >= 2) return '他们正在接话…'
    if (invoking.length === 1) return `${invoking[0].name}正在想…`
    if (collecting.length === 1) return `${collecting[0].name}正在看新消息…`
    if (collecting.length >= 2) return '他们正在看新消息…'
    return null
  }, [actorStatus, names])

  // 兜底:窗口重新聚焦(从主窗切回来)时重拉一次列表——跨窗事件万一错漏也不丢消息
  useEffect(() => {
    const refetch = () => {
      void listChatTurns(MAX_TURNS).then((ts) => setTurns(ts))
    }
    window.addEventListener('focus', refetch)
    return () => window.removeEventListener('focus', refetch)
  }, [])

  const feedRef = useRef<HTMLDivElement>(null)
  const rows = useMemo(
    () =>
      buildRows(turns, readSnap.firstUnreadId ? { beforeId: readSnap.firstUnreadId, count: readSnap.unreadCount } : null),
    [turns, readSnap.firstUnreadId, readSnap.unreadCount],
  )

  // ---------- 效果应用(§5):页面只执行控制器给的效果 ----------
  function applyReadEffect(effect: ReadEffect) {
    const el = feedRef.current
    if (!el) return
    if (effect.type === 'scroll-bottom') {
      el.scrollTop = el.scrollHeight
    } else if (effect.type === 'scroll-message') {
      const target = el.querySelector(`[data-eid="${effect.id}"]`)
      target?.scrollIntoView({ block: 'start' })
    }
    // preserve-viewport:保持当前像素位置(§12 底部追加不做补偿)
  }
  function syncView() {
    const el = feedRef.current
    if (!el) return
    distRef.current = el.scrollHeight - el.scrollTop - el.clientHeight
    applyReadEffect(
      readCtl().setView({
        active: winActiveRef.current,
        distanceToBottom: distRef.current,
        lastFullyVisibleId: lastVisibleRef.current,
      }),
    )
  }

  // 日志变化 → 识别 initial/append/prepend/clear,喂给控制器并执行效果(§12)
  useEffect(() => {
    const prev = prevTurnsRef.current
    let cause: EntriesCause = 'append'
    if (!prev) cause = 'initial'
    else if (turns.length === 0) cause = 'clear'
    else if (prev.length > 0 && turns.length >= prev.length && prev[0]?.id === turns[0]?.id) cause = 'append'
    else if (turns.length >= prev.length && prev[prev.length - 1]?.id === turns[turns.length - 1]?.id) cause = 'prepend'
    prevTurnsRef.current = turns
    applyReadEffect(readCtl().setEntries(turns, cause))
  }, [turns])

  // 完全可见观察器(§7):消息完全进入可视区才推进游标;按消息顺序取最后一条
  const orderedEids = useMemo(() => turns.map((t) => t.id ?? ''), [turns])
  useEffect(() => {
    const el = feedRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const visible = new Map<string, boolean>()
    const io = new IntersectionObserver(
      (changes) => {
        for (const c of changes) {
          const id = (c.target as HTMLElement).dataset.eid
          if (id) visible.set(id, c.intersectionRatio >= 1)
        }
        let last: string | null = null
        for (let i = orderedEids.length - 1; i >= 0; i--) {
          const id = orderedEids[i]
          if (id && visible.get(id)) {
            last = id
            break
          }
        }
        lastVisibleRef.current = last
        syncView()
      },
      { root: el, threshold: 1 },
    )
    el.querySelectorAll('[data-eid]').forEach((n) => io.observe(n))
    return () => io.disconnect()
  }, [rows, orderedEids])

  // 输入框随内容自长(1 行起,封顶后内部滚动)
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(110, el.scrollHeight)}px`
  }, [draft])

  async function onClearTurns() {
    // 统一清空(评审①):文件写入与运行时重置都在主窗完成,设置窗不自写
    if (bridge.onClearChatlog) await bridge.onClearChatlog()
    else await clearChatLog()
    setTurns(await listChatTurns(MAX_TURNS))
  }

  // ---------- 群设置抽屉:群名即存、背景与头像 ----------

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

  // ---------- 发送与 @ 补全 ----------

  async function sendDraft() {
    const text = draft.trim()
    if (!text) return
    const res = await bridge.onGroupSend(text)
    if (res === 'accepted') {
      setDraft('')
      setMention(null)
      // 自己发言:贴底跟随(§6),不产生未读
      applyReadEffect(readCtl().notifyOwnSend())
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

  function onDraftKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return // 输入法组词中的 Enter/方向键不归我们管
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault() // Enter 发送,Shift+Enter 换行
      void sendDraft()
    }
  }

  const mentionCandidates = useMemo(
    () => mentionTargets({ A: names.a, B: names.b, C: names.c }),
    [names.a, names.b, names.c],
  )
  const mentionMatches = mention ? filterMentionTargets(mentionCandidates, mention.query) : []

  const speakerName = (s: Speaker) => (s === 'A' ? names.a : s === 'B' ? names.b : names.c)
  const bgActive = group.bg && !!bgDataUrl
  // 裁剪弹窗几何:显示尺寸与钳制后的偏移(拖拽/滑杆/滚轮共用一套钳制)
  const cs = cropImg ? coverScale(cropImg.naturalWidth, cropImg.naturalHeight) : 1
  const cropScale = cs * zoom
  const dispW = cropImg ? cropImg.naturalWidth * cropScale : 0
  const dispH = cropImg ? cropImg.naturalHeight * cropScale : 0
  const cropOx = clampOffset(off.x, CROP_VIEW, dispW)
  const cropOy = clampOffset(off.y, CROP_VIEW, dispH)
  const avatarAccent = (k: AvatarKey) =>
    k === 'a' ? 'var(--bubble-acc-a)' : k === 'b' ? 'var(--bubble-acc-b)' : k === 'c' ? 'var(--bubble-acc-c)' : 'var(--accent)'
  const avatarLetter = (k: AvatarKey) =>
    k === 'user' ? '我' : ((k === 'a' ? names.a : k === 'b' ? names.b : names.c)[0] ?? '?')

  return (
    <div className={`group-chat${bgActive ? ' has-bg' : ''}`} data-card="聊天记录">
      {bgActive && <div className="group-bg" style={{ backgroundImage: `url(${bgDataUrl})` }} />}

      <div className="group-head">
        <span className="group-name">{group.name}</span>
        <span
          style={{ display: 'inline-flex', gap: 4, marginLeft: 8, alignItems: 'center' }}
          title="群聊角色状态:灰=空闲 橙=生成中 红=退避/暂停 深=未参与"
        >
          {(['A', 'B', 'C'] as const).map((id) => {
            const st = actorStatus[id]?.status ?? 'idle'
            const depth = actorStatus[id]?.queueDepth ?? 0
            const name = id === 'A' ? names.a : id === 'B' ? names.b : names.c
            const color =
              st === 'invoking' || st === 'collecting'
                ? '#e8a33d'
                : st === 'backoff' || st === 'paused'
                  ? '#d4574e'
                  : st === 'disabled'
                    ? 'rgba(128,128,128,.3)'
                    : 'rgba(128,128,128,.55)'
            return (
              <span
                key={id}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 8,
                  background: color,
                  display: 'inline-block',
                  opacity: depth > 0 ? 1 : 0.7,
                }}
                title={`${name}:${st}${depth > 0 ? `(待读 ${depth})` : ''}`}
              />
            )
          })}
        </span>
        <button
          className={`group-gear${drawerOpen ? ' on' : ''}`}
          title="群设置"
          onClick={() => setDrawerOpen(!drawerOpen)}
        >
          ⚙
        </button>
      </div>

      <div
        ref={feedRef}
        className="chatlog-feed"
        onScroll={() => {
          const el = feedRef.current
          if (!el) return
          // 视口事实同步 rAF 节流:一帧最多一次
          if (!viewSyncRafRef.current) {
            viewSyncRafRef.current = requestAnimationFrame(() => {
              viewSyncRafRef.current = 0
              syncView()
            })
          }
        }}
      >
        {loading && <div className="hist-empty">加载中…</div>}
        {!loading && rows.length === 0 && (
          <div className="hist-empty">还没有聊天记录——在下面说一句,或点 ▶ 来一段演出试试</div>
        )}
        {rows.map((row) => {
          if (row.kind === 'day') {
            return (
              <div className="chatlog-day" key={row.key}>
                {row.label}
              </div>
            )
          }
          if (row.kind === 'unread-divider') {
            return (
              <div className="unread-divider" key={row.key}>
                <span>你离开后有 {row.count} 条消息</span>
              </div>
            )
          }
          // 消息行:header 行带头像(+角色名/时间);follow 行同人紧跟
          const isMe = row.who === 'user'
          return (
            <div
              key={row.key}
              data-eid={row.eid}
              className={[
                'chatlog-row',
                isMe ? 'me' : `spk-${row.who.toLowerCase()}`,
                row.header ? '' : 'follow',
              ].join(' ')}
            >
              {row.header && (
                <Avatar
                  src={isMe ? avatars.user : avatars[row.who.toLowerCase() as 'a' | 'b' | 'c']}
                  letter={isMe ? '我' : speakerName(row.who as Speaker)[0] ?? '?'}
                  accent={avatarAccent(isMe ? 'user' : (row.who.toLowerCase() as AvatarKey))}
                />
              )}
              <div className="chatlog-main">
                {row.header && !isMe && (
                  <span className="chatlog-name">
                    {speakerName(row.who as Speaker)} · {hhmm(row.ts)}
                  </span>
                )}
                <div className="bubble-wrap">
                  <div className="chatlog-bubble">{row.text}</div>
                  {row.replay && (
                    <button
                      className="bubble-play"
                      title={isMe ? '' : '从这句播放'}
                      onClick={() => row.replay && bridge.onReplay(row.replay)}
                    >
                      ▶
                    </button>
                  )}
                  {row.entry?.memoryRefs && row.entry.memoryRefs.length > 0 && !isMe && (
                    <button
                      className="bubble-play"
                      title="参考记忆"
                      style={{ right: undefined, position: 'static', marginLeft: 6 }}
                      onClick={() =>
                        setMemOpen((prev) => {
                          const next = new Set(prev)
                          if (next.has(row.key)) next.delete(row.key)
                          else next.add(row.key)
                          return next
                        })
                      }
                    >
                      🧠 {row.entry.memoryRefs.length}{memOpen.has(row.key) ? ' ▾' : ' ▸'}
                    </button>
                  )}
                </div>
                {memOpen.has(row.key) && row.entry?.memoryRefs && (
                  <div className="set-note" style={{ margin: '2px 0 6px 46px' }}>
                    参考了 {row.entry.memoryRefs.length} 条自动记忆:
                    {row.entry.memoryRefs.map((r) => {
                      const f = memFacts.get(r.id)
                      const eff = f ? effectiveStatus(f, Date.now()) : null
                      const debug = cfg.memoryDisplay === 'debug'
                      const tr = debug ? (row.entry?.trace as { candidates?: { id: string; score: number; outcome: string }[] } | undefined) : undefined
                      const cand = tr?.candidates?.find((c) => c.id === r.id)
                      return (
                        <div key={r.id}>
                          {f ? `"${f.content}"` : '该记忆已删除'}
                          {f ? ` · ${SENS_LABEL_OR(f.sensitivity)} · 首次 ${f.createdAt ? new Date(f.createdAt).toLocaleDateString() : ''}` : ''}
                          {eff === 'needs_confirmation' && ' · 待确认'}
                          {f?.status === 'superseded' && ' · 已被替代'}
                          {cand && ` · 检索分 ${cand.score.toFixed(2)}(${cand.outcome})`}
                          {r.source === 'search-tool' && ' · 经查记忆工具'}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div className="group-input">
        {readSnap.unreadCount > 0 && !readSnap.nearBottom && (
          <button
            className="jump-latest"
            onClick={() => applyReadEffect(readCtl().requestJump())}
          >
            ↓ {readSnap.label ?? `${readSnap.unreadCount} 条新消息`}
          </button>
        )}
        {thinkingLine && <div className="actor-typing">{thinkingLine}</div>}
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
          <textarea
            ref={inputRef}
            className="group-textarea"
            rows={1}
            placeholder="在群里说点什么…(Enter 发送,Shift+Enter 换行,@ 指定谁回)"
            value={draft}
            onChange={(e) => {
              const v = e.target.value
              setDraft(v)
              const caret = e.target.selectionStart ?? v.length
              setMention(mentionContext(v.slice(0, caret)))
              setMentionIdx(0)
            }}
            onKeyDown={onDraftKeyDown}
          />
          <button className="group-send" disabled={!draft.trim()} onClick={() => void sendDraft()}>
            发送
          </button>
        </div>
      </div>

      {drawerOpen && (
        <div className="group-drawer">
          <div className="drawer-head">
            <span>群设置</span>
            <button className="drawer-close" title="关闭" onClick={() => setDrawerOpen(false)}>
              ✕
            </button>
          </div>
          <button
            className="drawer-field"
            style={{ cursor: 'pointer', textAlign: 'left' }}
            title="为甲/乙/丙各自选择 API 模型或网页模型"
            onClick={() => {
              setDrawerOpen(false)
              void emitTo('settings', 'settings-goto', { tab: 'model', card: '群聊角色绑定' })
            }}
          >
            <span>角色模型绑定</span>
            <span style={{ opacity: 0.75 }}>去选择 →</span>
          </button>
          <label className="drawer-field">
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
          <div className="drawer-field">
            <span>聊天背景</span>
            <div className="drawer-row">
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
          <div className="drawer-field">
            <span>头像</span>
            <div className="avatar-grid">
              {AVATAR_KEYS.map((k) => (
                <label
                  key={k}
                  className="avatar-slot"
                  title={`${k === 'user' ? '我' : speakerName(k.toUpperCase() as Speaker)} 的头像,点击更换`}
                >
                  <Avatar src={avatars[k]} letter={avatarLetter(k)} accent={avatarAccent(k)} />
                  {avatars[k] && (
                    <button
                      className="avatar-x"
                      title="恢复默认头像"
                      onClick={(e) => {
                        e.preventDefault() // 取消 label 默认行为,不弹文件框
                        e.stopPropagation()
                        void clearAvatar(k).then(() => setAvatars((m) => ({ ...m, [k]: null })))
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
          <div className="drawer-danger">
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
            <p>只清聊天消息,演出历史不受影响;收藏/删除整段演出在「演出历史」页</p>
          </div>
        </div>
      )}

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
    </div>
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
