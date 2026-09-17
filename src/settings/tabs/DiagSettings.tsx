// 链路诊断 · 开发者面板:一次交互从输入到播出的完整事件时间轴。
// 只读消费镜像数据(主窗采集,跨窗推送已脱敏);本页负责三件事:
//   · 详情捕获开关(三档隐私模型的第 2 档:临时脱敏详情,重启自动关闭);
//   · 会话回放:列表 → 派生结论 + 逐事件时间轴(耗时瀑布);
//   · 导出(预览清单 + 默认不含正文)与清空。
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { appDataDir, join } from '@tauri-apps/api/path'
import { exists, readTextFile } from '@tauri-apps/plugin-fs'
import { SettingsCard } from '../SettingsPrimitives'
import {
  useDiagData,
  requestDiagSnapshot,
  armDetailRemote,
  disarmDetailRemote,
  clearDiagRemote,
} from '../../diag/settingsRemote'
import { buildDiagExportJson } from '../../diag/store'
import { redactText } from '../../diag/redact'
import type { DiagEvent, DiagSession } from '../../diag/types'
import { getMemory } from '../../storage/memoryStore'
import { inTauri, saveConfig, useConfigSnapshot } from '../../storage/configStore'
import { countShadowRecords, clearShadowArchive } from '../../brain/shadowStore'
import { writeDiagExportFile } from '../../diag/exportFile'

const SOURCE_LABEL: Record<string, string> = {
  chat: '聊天',
  voice: '语音',
  performance: '演出',
  danmaku: '弹幕',
  interjection: '插话',
}

const OUTCOME_LABEL: Record<string, { text: string; tone: string }> = {
  spoke: { text: '已出声', tone: '#3a9d5c' },
  silent: { text: '无声', tone: '#c07f2d' },
  failed: { text: '失败', tone: '#c0483d' },
  cancelled: { text: '已取消', tone: '#7a7f8c' },
  queued: { text: '已入队', tone: '#7a7f8c' },
  open: { text: '进行中', tone: '#5b7fd0' },
}

/** 结果标签:spoke 在零 TTS 段的会话(单聊面板模式不朗读)实为「已回复」,语境化显示 */
function outcomeLabelOf(outcome: string, ttsSegments: number): { text: string; tone: string } {
  const base = OUTCOME_LABEL[outcome]
  if (outcome === 'spoke' && ttsSegments === 0) return { text: '已回复', tone: base.tone }
  return base
}

function fmtMs(ms: number | undefined): string {
  if (ms === undefined) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 事件 → 一行摘要(结构信息,正文只在 detail_text 且已脱敏);ids = 可查现状的记忆 id */
function describeEvent(ev: DiagEvent, ttsSegments = 0): { badge: string; text: string; ids?: string[] } {
  switch (ev.kind) {
    case 'turn_started':
      return { badge: '输入', text: `${SOURCE_LABEL[ev.source] ?? ev.source} · ${ev.inputChars} 字 · ${ev.language} · ${ev.fingerprint}${ev.voice ? ' · 语音路径' : ''}${ev.target ? ` · @${ev.target}` : ''}` }
    case 'turn_finished':
      return { badge: '完成', text: `结果 ${outcomeLabelOf(ev.outcome, ttsSegments).text} · 总耗时 ${fmtMs(ev.totalMs)} · 回复 ${ev.replySentences} 句 ${ev.replyChars} 字` }
    case 'llm_started':
      return { badge: 'LLM ▶', text: `${ev.call} → ${ev.transport}${ev.model ? ` · ${ev.model}` : ''}${ev.endpointHost ? ` · ${ev.endpointHost}` : ''} · prompt ${ev.promptChars} 字符(system ${ev.systemChars})· 上下文 ${ev.contextLines} 行 · 约 ${ev.estTokens} token${ev.timeoutMs ? ` · 超时 ${fmtMs(ev.timeoutMs)}` : ''}` }
    case 'llm_first_token':
      return { badge: '首token', text: `${ev.ms}ms(${ev.call})` }
    case 'llm_first_sentence':
      return { badge: '首句', text: `闭合 ${ev.ms}ms(开口延迟的决定项)` }
    case 'llm_finished':
      return {
        badge: 'LLM ■',
        text: `${ev.ok ? '成功' : ev.cancelled ? '被取消' : `失败:${ev.errorKind ?? '?'}`}${ev.status ? ` · HTTP ${ev.status}` : ''} · ${fmtMs(ev.elapsedMs)} · 输出 ${ev.outputChars} 字符${ev.serverMsg ? ` · ${ev.serverMsg}` : ''}`,
      }
    case 'fallback':
      return { badge: '回退', text: `${ev.call}:${ev.from} — ${ev.reason}` }
    case 'webchat_stages':
      return { badge: 'CDP', text: ev.stages.map((s) => `${s.stage}@${fmtMs(s.ms)}`).join(' → ') || '(无阶段)' }
    case 'tts_request':
      return { badge: 'TTS ▶', text: `第 ${ev.seg + 1} 段 · ${ev.speaker} · ${ev.chars} 字 · ${ev.channel} · epoch ${ev.epoch}${ev.action ? ` · ${ev.action}` : ''}` }
    case 'tts_segment': {
      const parts = [`第 ${ev.seg + 1} 段 · ${ev.outcome}`]
      if (ev.synthMs !== undefined) parts.push(`合成 ${fmtMs(ev.synthMs)}`)
      if (ev.playbackMs !== undefined) parts.push(`播放 ${fmtMs(ev.playbackMs)}`)
      if (ev.cacheHit) parts.push('缓存命中')
      if (ev.reason) parts.push(ev.reason)
      return { badge: 'TTS ■', text: parts.join(' · ') }
    }
    case 'tts_stopped':
      return { badge: 'TTS停', text: `${ev.trigger === 'cancel' ? '回合取消' : '全局停止'} · 在播=${ev.hadActiveSession} · epoch ${ev.epochBefore}→${ev.epochAfter}` }
    case 'cancel_requested':
      return { badge: '取消', text: `generation→${ev.generation} · 句柄=${ev.hadHandle} · 请求=${ev.hadAbort}` }
    case 'action_fired':
      return { badge: '动作', text: `${ev.speaker} · ${ev.action}` }
    case 'tools_prepare':
      return { badge: '工具', text: `${fmtMs(ev.ms)}${ev.clarified ? ' · 反问用户' : ''}${ev.hasNote ? ' · 带观察块' : ''} · 记忆引用 ${ev.memoryRefs}` }
    case 'memory_selection':
      return { badge: '记忆', text: `检索 ${fmtMs(ev.ms)} · 未中候选 ${ev.candidates.length} 条`, ids: ev.selected.map((s) => s.id) }
    case 'memory_write':
      return { badge: '记忆✎', text: `候选 ${ev.candidates} · 写入 ${ev.changed} · 拒绝 ${ev.rejected} · ${fmtMs(ev.ms)}${ev.error ? ` · ${ev.error}` : ''}`, ids: [...ev.addedIds, ...ev.supersededIds] }
    case 'asr_result':
      return { badge: 'ASR', text: `${fmtMs(ev.ms)} · ${ev.chars} 字${ev.audioMs ? ` · 音频 ${fmtMs(ev.audioMs)}` : ''}${ev.errorKind ? ` · ${ev.errorKind}` : ''}` }
    case 'detail_text':
      return { badge: ev.textKind === 'prompt' ? 'prompt' : '正文', text: ev.text }
    default:
      return { badge: '?', text: '' }
  }
}

const BADGE_TONE: Record<string, string> = {
  LLM: '#5b7fd0',
  TTS: '#8a63c9',
  记忆: '#3a9d5c',
  回退: '#c07f2d',
  取消: '#c0483d',
  CDP: '#c07f2d',
}

function MemoryIdChip(props: { id: string }) {
  const [info, setInfo] = useState<string | null>(null)
  async function lookup() {
    if (info !== null) {
      setInfo(null)
      return
    }
    try {
      const mem = await getMemory()
      const f = mem.facts.find((x) => x.id === props.id)
      if (!f) {
        setInfo('该记忆已删除(诊断不留正文副本)')
        return
      }
      const state = f.status === 'superseded' ? '已被替代(旧值)' : '生效中'
      const excerpt = f.evidence.reduceRight<string>(
        (found, e) =>
          found ||
          ((e.kind === 'model-extraction' || e.kind === 'explicit-command') && e.excerpt) ||
          (e.kind === 'user-edited' && e.text) ||
          '',
        '',
      )
      setInfo(`${state} · ${redactText(f.content, 120)}${excerpt ? ` · 来源:${redactText(excerpt, 60)}` : ''}`)
    } catch {
      setInfo('读取失败')
    }
  }
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start' }}>
      <button className="panel-btn" style={{ fontSize: 11, padding: '1px 6px' }} onClick={() => void lookup()} title="查看该记忆现状(按 id 实时解析)">
        {props.id}
      </button>
      {info && <span style={{ fontSize: 11, opacity: 0.75, margin: '2px 0 4px' }}>{info}</span>}
    </span>
  )
}

function Timeline(props: { session: DiagSession }) {
  const t0 = props.session.ts
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 8 }}>
      {props.session.events.map((ev, i) => {
        const d = describeEvent(ev, props.session.summary.ttsSegments)
        const tone = BADGE_TONE[d.badge.replace(/[▶■✎停]/g, '')] ?? '#7a7f8c'
        return (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12, lineHeight: 1.5 }}>
            <span style={{ fontFamily: 'monospace', opacity: 0.6, flexShrink: 0, width: 62, textAlign: 'right' }}>
              +{fmtMs(ev.ts - t0)}
            </span>
            <span
              style={{
                flexShrink: 0,
                color: '#fff',
                background: tone,
                borderRadius: 4,
                fontSize: 11,
                padding: '0 6px',
                minWidth: 58,
                textAlign: 'center',
              }}
            >
              {d.badge}
            </span>
            <span style={{ wordBreak: 'break-all', opacity: 0.9 }}>{d.text}</span>
            {d.ids && d.ids.length > 0 && (
              <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                {d.ids.map((id) => (
                  <MemoryIdChip key={id} id={id} />
                ))}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

function SummaryChips(props: { session: DiagSession }) {
  const s = props.session.summary
  const chips: { text: string; tone: string }[] = []
  const outcome = outcomeLabelOf(s.outcome, s.ttsSegments)
  if (outcome) chips.push({ text: outcome.text, tone: outcome.tone })
  if (s.noSpeechReason) chips.push({ text: `未说话:${s.noSpeechReason}`, tone: '#c07f2d' })
  for (const f of s.fallbacks) chips.push({ text: `回退:${f.from} — ${f.reason}`, tone: '#c07f2d' })
  if (s.cancelLeak) chips.push({ text: '取消后仍有出声(泄漏)', tone: '#c0483d' })
  if (s.errorKind) chips.push({ text: `错误:${s.errorKind}${s.errorText ? ` — ${s.errorText}` : ''}`, tone: '#c0483d' })
  if (s.firstTokenMs !== undefined) chips.push({ text: `首token ${fmtMs(s.firstTokenMs)}`, tone: '#5b7fd0' })
  if (s.firstSentenceMs !== undefined) chips.push({ text: `首句闭合 ${fmtMs(s.firstSentenceMs)}`, tone: '#5b7fd0' })
  if (s.ttsSegments > 0) chips.push({ text: `TTS ${s.ttsSpoken}/${s.ttsSegments} 段出声`, tone: '#8a63c9' })
  if (s.memoryInjected > 0 || s.memoryWritten > 0) {
    chips.push({ text: `记忆 注入${s.memoryInjected} / 写入${s.memoryWritten}`, tone: '#3a9d5c' })
  }
  if (chips.length === 0) return null
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '6px 0 2px' }}>
      {chips.map((c, i) => (
        <span key={i} style={{ fontSize: 11, color: c.tone, border: `1px solid ${c.tone}55`, borderRadius: 10, padding: '1px 8px' }}>
          {c.text}
        </span>
      ))}
    </div>
  )
}

/** bridge.json(桥发现文件)内容:Agent 侧据此获知端口与 token */
interface BridgeDiscovery {
  token?: string
  port?: number
}

interface BridgeStatus {
  running?: boolean
  port?: number
  inputs?: number
  counts?: { decisions?: number; speaks?: number; offers?: number; pushes?: number }
}

const MODE_OPTIONS: { value: 'off' | 'shadow' | 'takeover'; label: string; hint: string }[] = [
  { value: 'off', label: '关闭', hint: '桥不启动' },
  { value: 'shadow', label: '影子对照', hint: '外部决策只落盘不执行' },
  { value: 'takeover', label: '接管', hint: '候选触发前问外部大脑,超时回落本地' },
]

/** 影子大脑卡:仅 dev 构建显示(release 无桥,配置字段无害)。
 *  外部编码 Agent 经 127.0.0.1 桥读运行现场、提交决策,影子对照调主动发言参数。
 *  设计与 Agent 接入指引见 docs/影子大脑桥接设计方案.md */
function ShadowBrainCard() {
  const shadowBrain = useConfigSnapshot().shadowBrain
  const dev = import.meta.env.DEV && inTauri
  const [status, setStatus] = useState<BridgeStatus | null>(null)
  const [archive, setArchive] = useState<{ inputs: number; decisions: number } | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    if (!dev) return
    const refresh = () => {
      void invoke<BridgeStatus>('bridge_status')
        .then(setStatus)
        .catch(() => setStatus(null))
      void countShadowRecords().then(setArchive)
    }
    refresh()
    const t = window.setInterval(refresh, 30_000)
    return () => window.clearInterval(t)
  }, [dev])

  // token 从桥发现文件读(端口/token 的持久事实源);桥没开过就是 null
  useEffect(() => {
    if (!dev || !shadowBrain.enabled) return
    void (async () => {
      try {
        const file = await join(await appDataDir(), 'data', 'bridge.json')
        if (await exists(file)) {
          setToken((JSON.parse(await readTextFile(file)) as BridgeDiscovery).token ?? null)
        }
      } catch {
        // 读取失败按未知处理
      }
    })()
  }, [dev, shadowBrain.enabled, status?.running])

  if (!dev) return null

  async function setMode(mode: 'off' | 'shadow' | 'takeover'): Promise<void> {
    await saveConfig({ shadowBrain: { ...shadowBrain, mode, enabled: mode !== 'off' } })
  }

  async function copy(text: string, what: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      setMsg(`已复制${what}`)
    } catch {
      setMsg('复制失败(浏览器剪贴板不可用)')
    }
  }

  const modeDesc = MODE_OPTIONS.find((m) => m.value === shadowBrain.mode)?.hint ?? ''
  const port = status?.running ? status.port : null

  return (
    <SettingsCard
      card="影子大脑"
      title="影子大脑(Shadow Brain)"
      desc={modeDesc}
      action={
        <>
          {MODE_OPTIONS.map((m) => (
            <label key={m.value} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 13, marginRight: 10 }}>
              <input
                type="radio"
                name="shadow-brain-mode"
                checked={shadowBrain.mode === m.value}
                onChange={() => void setMode(m.value)}
              />
              {m.label}
            </label>
          ))}
        </>
      }
    >
      <div className="set-note" style={{ lineHeight: 1.7 }}>
        仅监听 127.0.0.1 的本地桥(正式版整体剔除):外部编码 Agent 读取运行现场快照,
        提交「该不该说话/什么表情」的决策。影子模式只落盘不执行——拿 Agent 的判断和
        本地大脑对照,把「主动发言的感觉」变成可调的规则。
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center', margin: '8px 0 4px', fontSize: 13 }}>
        <span>
          状态:{status?.running ? `运行中 :${port}` : shadowBrain.enabled ? '启动中/未运行' : '未运行'}
        </span>
        {port !== null && (
          <button className="panel-btn" onClick={() => void copy(String(port), '端口')}>
            复制端口
          </button>
        )}
        {token && (
          <button className="panel-btn" onClick={() => void copy(token, 'token')}>
            复制 token
          </button>
        )}
        <span style={{ opacity: 0.75 }}>
          环内输入 {status?.inputs ?? 0} · 决策 {status?.counts?.decisions ?? 0} · 指挥 {status?.counts?.speaks ?? 0}
        </span>
        <span style={{ opacity: 0.75 }}>
          存档:输入 {archive?.inputs ?? 0} / 决策 {archive?.decisions ?? 0}
        </span>
        <button
          className="panel-btn"
          onClick={() => {
            void clearShadowArchive().then(() => {
              setMsg('已清空影子存档')
              void countShadowRecords().then(setArchive)
            })
          }}
        >
          清空存档
        </button>
      </div>
      <div className="set-note" style={{ marginTop: 4 }}>
        接入:Agent 读 <code>appData/data/bridge.json</code> 取端口与 token,
        <code>GET /brain/inputs</code> 拉现场、<code>POST /brain/decisions</code> 交影子决策、
        <code>POST /brain/speak</code> 现场指挥。语料在 <code>data/shadow-brain/</code>(JSONL)。
      </div>
      {msg && <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>{msg}</div>}
    </SettingsCard>
  )
}

export function DiagSettings() {
  const { sessions, detail } = useDiagData()
  const [expanded, setExpanded] = useState<string | null>(null)
  const [rawCapture, setRawCapture] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [includeDetail, setIncludeDetail] = useState(false)
  const [exportMsg, setExportMsg] = useState('')
  // 详情捕获倒计时需要周期重渲染:时刻放 state,渲染期不再调 Date.now()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    requestDiagSnapshot()
    const t = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(t)
  }, [])

  const detailText = !detail.armed
    ? '未开启:诊断只记录结构与耗时,无任何可读正文(默认档)'
    : detail.mode === 'once'
      ? `将捕获下一次交互的脱敏正文${detail.rawText ? '(含原文,已强制密钥扫描)' : ''}`
      : `捕获中,剩余约 ${Math.max(1, Math.ceil((detail.untilTs - now) / 60_000))} 分钟${detail.rawText ? '(含原文,已强制密钥扫描)' : ''}`

  async function doExport() {
    if (!inTauri) {
      setExportMsg('浏览器原型不支持导出文件')
      return
    }
    try {
      const json = buildDiagExportJson(sessions, { includeDetailText: includeDetail })
      const file = await writeDiagExportFile(json)
      setExportMsg(`已导出 ${sessions.length} 个会话 → ${file}`)
    } catch (e) {
      setExportMsg(`导出失败:${String((e as Error)?.message ?? e).slice(0, 120)}`)
    }
  }

  return (
    <>
      <SettingsCard card="链路诊断" title="链路诊断(开发者)" desc="本机内存环 · 不落盘 · 重启即清">
        <div className="set-note" style={{ lineHeight: 1.7 }}>
          记录一次交互的完整链路:用户输入 → 模型选择(API/网页) → prompt 与上下文 → 首 Token 延迟 → TTS 分段耗时 → 动作触发 → 记忆写入。
          <br />
          隐私三档:① 默认只记结构与耗时(长度/语言/会话盐哈希/id/决策码),零可读正文;② 详情捕获临时保存脱敏正文,重启自动关闭;③ 导出时逐次授权是否包含文本。
          密钥/Cookie/音频/截图任何档位都不进入诊断。
        </div>
      </SettingsCard>

      <SettingsCard
        card="详情捕获"
        title="详情捕获"
        desc={detailText}
        action={
          <>
            <button className="panel-btn" onClick={() => armDetailRemote({ once: true, rawText: rawCapture })}>
              捕获下一次交互
            </button>{' '}
            <button className="panel-btn" onClick={() => armDetailRemote({ minutes: 10, rawText: rawCapture })}>
              开启 10 分钟
            </button>{' '}
            {detail.armed && (
              <button className="panel-btn" onClick={() => disarmDetailRemote()}>
                停止
              </button>
            )}
          </>
        }
      >
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={rawCapture} onChange={(e) => setRawCapture(e.target.checked)} />
          捕获时保留原文(仍强制密钥/Cookie 扫描;完整对话可能包含私人信息,请勿外传)
        </label>
        <div className="set-note" style={{ marginTop: 6 }}>
          脱敏会掩码:称呼/手机号/证件/邮箱/银行卡/地址/路径/健康词;无格式的隐私(病情、打算等)不做承诺——默认档不存正文才是硬保证。
        </div>
      </SettingsCard>

      <SettingsCard
        card="诊断数据"
        title="会话回放"
        desc={`最近 ${sessions.length} 次`}
        action={
          <>
            <button className="panel-btn" onClick={() => setExportOpen((v) => !v)}>
              导出诊断包
            </button>{' '}
            <button className="panel-btn" onClick={() => clearDiagRemote()}>
              清空
            </button>
          </>
        }
      >
        {exportOpen && (
          <div style={{ border: '1px solid var(--set-border, #8884)', borderRadius: 8, padding: '10px 12px', marginBottom: 10, fontSize: 13 }}>
            <div>将包含:</div>
            <div>✓ 事件时间线与耗时 ✓ 错误码与运行状态 ✓ 记忆 id 与决策 {includeDetail ? '✓ 脱敏后的对话文本' : '✗ 对话文本'}</div>
            <div>✗ API Key 和 Cookie ✗ 麦克风音频 ✗ 截图和上传文件</div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <input type="checkbox" checked={includeDetail} onChange={(e) => setIncludeDetail(e.target.checked)} />
              包含详情捕获的对话文本(已脱敏;若捕获时选了原文则仅做密钥扫描,勿发给不可信对象)
            </label>
            <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
              <button className="panel-btn primary" onClick={() => void doExport()}>
                导出到数据目录
              </button>
              {exportMsg && <span style={{ fontSize: 12, opacity: 0.8 }}>{exportMsg}</span>}
            </div>
          </div>
        )}
        {sessions.length === 0 && <div className="set-note">还没有诊断会话 — 和角色说句话,或播一段演出</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {sessions.map((s) => {
            const oc = outcomeLabelOf(s.summary.outcome, s.summary.ttsSegments)
            const open = expanded === s.id
            return (
              <div key={s.id} style={{ borderBottom: '1px solid var(--set-border, #8882)', padding: '6px 2px' }}>
                <button
                  style={{ all: 'unset', cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'baseline', width: '100%', boxSizing: 'border-box' }}
                  onClick={() => setExpanded(open ? null : s.id)}
                >
                  <span style={{ fontFamily: 'monospace', fontSize: 12, opacity: 0.7, flexShrink: 0 }}>{fmtTime(s.ts)}</span>
                  <span style={{ fontSize: 12, flexShrink: 0 }}>
                    {SOURCE_LABEL[s.source] ?? s.source}
                    {s.room?.startsWith('direct:') && `(单聊·${s.room.slice(7)})`}
                  </span>
                  <span style={{ fontSize: 12, color: oc?.tone, flexShrink: 0 }}>{oc?.text ?? s.summary.outcome}</span>
                  <span style={{ fontSize: 12, opacity: 0.65, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.summary.errorKind ? s.summary.errorText ?? s.summary.errorKind : `${s.events.length} 个事件`}
                  </span>
                  <span style={{ fontSize: 12, opacity: 0.65, flexShrink: 0 }}>{fmtMs(s.summary.totalMs)}</span>
                </button>
                {open && (
                  <>
                    <SummaryChips session={s} />
                    <Timeline session={s} />
                  </>
                )}
              </div>
            )
          })}
        </div>
      </SettingsCard>

      <ShadowBrainCard />
    </>
  )
}
