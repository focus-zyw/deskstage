// 设置会话:设置窗口打开期间的唯一数据源——表单草稿、即存管线(防抖落盘+副作用)、
// 厂商 key 草稿、语音配置、克隆音色列表、B站扫码登录。
// 窗口挂载(mount)即加载磁盘配置回填表单;各数据页(记忆/备忘/历史)由对应 tab 自己加载。
import { useEffect, useMemo, useRef, useState } from 'react'
import { createSettingsSaveQueue } from './saveQueue'
import { createContext, useContext } from 'react'
import {
  DEFAULT_CONFIG,
  getConfig,
  inTauri,
  saveConfig,
  type AppConfig,
} from '../storage/configStore'
import { defaultPersonaText, setCharacterGenders, setCharacterNames, setPersonaOverride } from '../engine/persona'
import { startEnvPolling, stopEnvPolling } from '../engine/envAware'
import { applyScreenshotHotkey } from '../capture'
import { applyAppHotkeys } from '../hotkeys'
import { invoke } from '@tauri-apps/api/core'
import { emitTo } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listCustomVoices, type ClonedVoice } from '../engine/tts'
import type { VoiceConfig } from '../storage/configStore'
import { CUSTOM_VENDOR_ID, vendorIdOfBaseUrl } from '../engine/vendors'
import { startQrLogin, type QrLoginHandle, type QrPhase } from '../live/biliLogin'
import QRCode from 'qrcode'
import type { Episode } from '../storage/historyStore'
import type { Rarity } from '../features/support/pool'
import type { SettingsTab } from './settingsCatalog'

/** apiKeys 的存储键:预设厂商用 id,自定义端点按 baseUrl 区分(与 configStore 注释约定一致) */
export function vendorKeyOf(id: string, baseUrl: string): string {
  return id === CUSTOM_VENDOR_ID ? `custom:${baseUrl.trim()}` : id
}

export interface QrLoginState {
  phase: QrPhase | 'generating'
  /** 二维码轮次号:每次过期刷新递增,UI 凭它丢弃旧轮迟到的渲染结果 */
  round: number
  qrDataUrl?: string
  hint?: string
}

/** 跨模块行为:设置窗口只通过这些回调触碰应用其余部分(回放/布局复位/备忘隐私插话/支持答谢) */
export interface SettingsBridge {
  /** 历史页点击一行:回放该集(窗口关闭由 App 侧负责) */
  onReplay(ep: Episode): void
  /** 基础设置"恢复默认布局" */
  onResetLayout(): void
  /** 基础设置"恢复C的位置":只复位常驻角色 C,A/B 不动 */
  onResetC(): void
  /** 备忘页添加备忘时的隐私提示插话(角色气泡) */
  onPrivacyTip(): void
  /** 支持页抽奖:本轮最高稀有度的感谢语交给舞台角色当场答谢(rarity 决定演出规格) */
  onSupportThanks(content: { rarity: Rarity; text: string }): void
  /** 群聊页发送消息:走主聊天通道(应答/插话/落盘同源),返回受理结果供 UI 提示 */
  onGroupSend(text: string): Promise<'accepted' | 'busy' | 'empty'>
}

export interface SettingsSessionApi {
  form: AppConfig
  setForm: React.Dispatch<React.SetStateAction<AppConfig>>
  /** 字段即存入口:immediate=true 立即落盘(开关/下拉等离散操作),否则 400ms 防抖合并(文本输入) */
  saveField(partial: Partial<AppConfig>, immediate?: boolean): void
  /** 即存反馈:最近一次自动保存/失败的时间戳(渲染 2.5s 后自动消失) */
  savedTick: number
  saveError: boolean
  vendorId: string
  setVendorId: React.Dispatch<React.SetStateAction<string>>
  /** 面板内各厂商 key 的草稿:切换厂商时把输入存回旧键、从新键带出,保存时合并落盘 */
  keyDrafts: Record<string, string>
  setKeyDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>
  voice: VoiceConfig
  setVoice: React.Dispatch<React.SetStateAction<VoiceConfig>>
  /** 账号下的克隆音色(打开设置时拉取),供音色下拉选择 */
  clonedVoices: ClonedVoice[]
  setClonedVoices: React.Dispatch<React.SetStateAction<ClonedVoice[]>>
  qrLogin: QrLoginState | null
  beginQrLogin(): void
  cancelQrLogin(): void
  bridge: SettingsBridge
  /** 搜索跳转的目标卡片(2.2s 高亮);由窗口注入,卡片用它做 flash 定位 */
  flashCard: string | null
  /** 切到指定分页(跨页动作用,如收藏页"导入视频工坊");清空搜索词。本体在 SettingsWindow */
  gotoTab(tab: SettingsTab): void
  /** 视频工坊的素材来源:null = 用最近一集;由收藏页"导入视频工坊"设置,窗口关闭即复位 */
  videoSource: Episode | null
  setVideoSource(ep: Episode | null): void
}

export const SettingsContext = createContext<SettingsSessionApi | null>(null)

export function useSettings(): SettingsSessionApi {
  const v = useContext(SettingsContext)
  if (!v) throw new Error('useSettings 必须在 SettingsContext.Provider 内使用')
  return v
}

/** 会话本体(不含 bridge/flashCard/gotoTab,由窗口组装进 context) */
export type SettingsSessionState = Omit<SettingsSessionApi, 'bridge' | 'flashCard' | 'gotoTab'>

export function useSettingsSession(): SettingsSessionState {
  const [form, setForm] = useState<AppConfig>(DEFAULT_CONFIG)
  const [savedTick, setSavedTick] = useState(0)
  const [saveError, setSaveError] = useState(false)
  // 设置面板当前选中的厂商(custom = 本地/自定义,baseUrl/model 自由输入)
  const [vendorId, setVendorId] = useState(CUSTOM_VENDOR_ID)
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({})
  // 角色语音配置(开关 + 双角色音色,改即落盘)
  const [voice, setVoice] = useState(DEFAULT_CONFIG.voice)
  const [clonedVoices, setClonedVoices] = useState<ClonedVoice[]>([])
  // B站扫码登录(免手贴 cookie):句柄与展示状态
  const qrHandleRef = useRef<QrLoginHandle | null>(null)
  const [qrLogin, setQrLogin] = useState<QrLoginState | null>(null)
  // 二维码轮次号:丢弃旧轮迟到的渲染结果,防止新一轮被旧图覆盖
  const qrRoundRef = useRef(0)
  // 视频工坊的素材来源:收藏页"导入视频工坊"带过来的整集(跨 tab 载荷,窗口关闭即销毁)
  const [videoSource, setVideoSource] = useState<Episode | null>(null)

  // 即存管线:字段变更 → saveField(队列合并) → commitSettings(落盘+副作用)
  const saveQueue = useMemo(
    () => createSettingsSaveQueue((pack) => commitSettings(pack as Partial<AppConfig>)),
    [],
  )
  useEffect(() => () => saveQueue.dispose(), [saveQueue])

  // 打开设置:读当前配置回填表单(人设输入框显示生效中的全文,编辑后保存即采纳)
  useEffect(() => {
    void (async () => {
      const cfg = await getConfig()
      setForm({
        ...cfg,
        persona: {
          a: cfg.persona.a || defaultPersonaText('A'),
          b: cfg.persona.b || defaultPersonaText('B'),
          c: cfg.persona.c || defaultPersonaText('C'),
        },
      })
      const id = vendorIdOfBaseUrl(cfg.baseUrl)
      setVendorId(id)
      // 各厂商 key 草稿 = 已保存的 apiKeys + 当前生效 key 归位到它的键
      setKeyDrafts({ ...cfg.apiKeys, [vendorKeyOf(id, cfg.baseUrl)]: cfg.apiKey })
      setVoice(cfg.voice)
      // 拉取账号下的克隆音色(失败静默,下拉只是少了自定义项;克隆是硅基流动独有)
      if (cfg.voice.provider === 'siliconflow' && cfg.voice.apiKey.trim()) {
        listCustomVoices(cfg.voice.apiKey)
          .then(setClonedVoices)
          .catch((e) => console.warn('克隆音色列表拉取失败(静默)', e))
      }
    })()
    // 卸载 = 窗口关闭:停掉扫码轮询,防止后台空转
    return () => {
      qrHandleRef.current?.cancel()
      qrHandleRef.current = null
    }
  }, [])

  /** 落盘一批字段并执行关联副作用(快捷键换绑/角色排除/环境轮询/人设采纳) */
  async function commitSettings(partial: Partial<AppConfig>) {
    try {
      // 窗口拆分后,设置窗是唯一运行本会话的窗口:配置统一由主窗落盘
      // (bridgeServer.applyRemoteConfigSave,副作用也在主窗执行),
      // 本地只发请求并亮"已保存";快照更新由 config-changed 广播驱动
      if (inTauri && getCurrentWindow().label === 'settings') {
        await emitTo('main', 'config-save', partial)
        setSavedTick(Date.now())
        window.setTimeout(() => setSavedTick(0), 2500)
        return
      }
      const next = await saveConfig(partial)
      void applyScreenshotHotkey() // 快捷键按新配置换绑
      void applyAppHotkeys() // 演出动作快捷键同理换绑
      void invoke('set_capture_excluded', { enable: next.screenshot.hideSelf }).catch(() => {})
      // 环境感知或久坐提醒任一开启都需要轮询(久坐依赖键鼠空闲传感器,与环境感知解耦)
      if (next.envSense || next.breakReminder.enabled) startEnvPolling()
      else stopEnvPolling()
      if (partial.persona) setPersonaOverride(partial.persona.a, partial.persona.b, partial.persona.c) // 新人设立即采纳
      if (partial.names) setCharacterNames(partial.names.a, partial.names.b, partial.names.c)
      if (partial.genders) setCharacterGenders(partial.genders.a, partial.genders.b, partial.genders.c) // 性别纪律立即采纳
      setSavedTick(Date.now())
      window.setTimeout(() => setSavedTick(0), 2500)
    } catch (e) {
      console.error('配置保存失败', e)
      setSaveError(true)
      window.setTimeout(() => setSaveError(false), 2500)
    }
  }

  function saveField(partial: Partial<AppConfig>, immediate = false) {
    void saveQueue.save(partial, immediate)
  }

  function beginQrLogin() {
    qrHandleRef.current?.cancel()
    setQrLogin({ phase: 'generating', round: qrRoundRef.current, hint: '正在生成二维码…' })
    qrHandleRef.current = startQrLogin({
      onQr: (round, url) => {
        // 旧轮迟到的渲染结果不覆盖新一轮
        if (round < qrRoundRef.current) return
        qrRoundRef.current = round
        // 渲染失败必须可见:吞掉 rejection 会永远停在"生成中";176px/4模块白边为稳妥扫码尺寸
        QRCode.toDataURL(url, { width: 220, margin: 1 })
          .then((dataUrl) => {
            setQrLogin((s) => (s && s.round === round ? { ...s, phase: 'waiting', qrDataUrl: dataUrl } : s))
          })
          .catch((e) => {
            setQrLogin((s) =>
              s && s.round === round
                ? { ...s, phase: 'error', hint: `二维码渲染失败:${String(e?.message ?? e).slice(0, 80)}` }
                : s,
            )
          })
      },
      onPhase: (p, message) => {
        // 过期刷新开始即隐藏旧码,防止用户扫到临界失效图;error/ok 文案由 onPhase/message 带出
        if (p === 'expired') {
          setQrLogin((s) => (s ? { ...s, phase: p, qrDataUrl: undefined, hint: message } : s))
          return
        }
        setQrLogin((s) => (s ? { ...s, phase: p, hint: message } : s))
      },
      onSuccess: ({ cookie, uid }) => {
        // 从配置源取最新 live(闭包里的 form 可能过期),合并后落盘并同步表单
        void (async () => {
          const current = await getConfig()
          const live = { ...current.live, cookie }
          setForm((f) => ({ ...f, live }))
          saveField({ live })
        })()
        // 保留当前轮次号:UI 的旧轮结果丢弃守卫在 ok 态同样生效
        setQrLogin((s) => ({
          phase: 'ok',
          round: s?.round ?? qrRoundRef.current,
          hint: `登录成功(UID ${uid}),Cookie 已回填并保存`,
        }))
      },
    })
  }

  function cancelQrLogin() {
    qrHandleRef.current?.cancel()
    qrHandleRef.current = null
    setQrLogin(null)
  }

  return {
    form,
    setForm,
    saveField,
    savedTick,
    saveError,
    vendorId,
    setVendorId,
    keyDrafts,
    setKeyDrafts,
    voice,
    setVoice,
    clonedVoices,
    setClonedVoices,
    qrLogin,
    beginQrLogin,
    cancelQrLogin,
    videoSource,
    setVideoSource,
  }
}
