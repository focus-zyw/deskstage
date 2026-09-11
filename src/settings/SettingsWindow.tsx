// 设置窗口:680px 居中独立窗口的框架——左栏导航+搜索、标题栏(保存状态/退出)、
// 右侧内容区分发到各分页组件。会话(草稿/即存)经 SettingsContext 下发。
import { useEffect, useRef, useState } from 'react'
import {
  SettingsContext,
  useSettingsSession,
  type SettingsBridge,
  type SettingsSessionApi,
} from './useSettingsSession'
import { SETTINGS_NAV, SETTINGS_SEARCH_INDEX, TAB_GROUP, type SettingsTab } from './settingsCatalog'
import { useConfigSnapshot } from '../storage/configStore'
import { GeneralSettings } from './tabs/GeneralSettings'
import { ModelSettings } from './tabs/ModelSettings'
import { PersonaSettings } from './tabs/PersonaSettings'
import { CustomModesSettings } from './tabs/CustomModesSettings'
import { VoiceSettings } from './tabs/VoiceSettings'
import { LiveSettings } from './tabs/LiveSettings'
import { HotkeysSettings } from './tabs/HotkeysSettings'
import { PrivacySettings } from './tabs/PrivacySettings'
import { MemorySettings } from './tabs/MemorySettings'
import { MemoSettings } from './tabs/MemoSettings'
import { FavoritesSettings } from './tabs/FavoritesSettings'
import { HistorySettings } from './tabs/HistorySettings'

export interface SettingsWindowProps {
  /** 命中区注册用:App 需要拿到窗口根元素的屏幕矩形 */
  innerRef: React.RefObject<HTMLDivElement | null>
  /** 跨模块行为:回放历史 / 复位布局 / 备忘隐私插话 */
  bridge: SettingsBridge
  /** 本次打开要落到的分页(命令面板"添加提醒"直达备忘页用);仅在挂载时生效 */
  initialTab?: SettingsTab
  /** 退出程序(真正关窗在 App 侧;两段确认只服务这里的按钮) */
  onExit(): void
}

const TAB_CONTENT: Record<SettingsTab, () => React.JSX.Element> = {
  general: GeneralSettings,
  model: ModelSettings,
  persona: PersonaSettings,
  modes: CustomModesSettings,
  voice: VoiceSettings,
  live: LiveSettings,
  hotkeys: HotkeysSettings,
  privacy: PrivacySettings,
  memory: MemorySettings,
  memo: MemoSettings,
  favorites: FavoritesSettings,
  history: HistorySettings,
}

export function SettingsWindow({ innerRef, bridge, initialTab = 'general', onExit }: SettingsWindowProps) {
  const session = useSettingsSession()
  // 界面主题:读已落盘配置(基础设置里切换,保存即发布快照,窗口即时换肤)
  const theme = useConfigSnapshot().theme
  // 分页与搜索:关键词非空时右侧改为搜索结果列表,点击结果跳转分页并高亮卡片
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(initialTab)
  const [settingsQuery, setSettingsQuery] = useState('')
  // 退出两段确认:第一次点亮,3 秒内再点才真正退出(防误触)
  const [exitArmed, setExitArmed] = useState(false)
  const exitTimer = useRef(0)
  const [flashCard, setFlashCard] = useState<string | null>(null)
  const flashTimer = useRef(0)
  const setBodyRef = useRef<HTMLDivElement>(null)

  /** 退出程序:3 秒内再点一次才真正关闭 */
  function requestExit() {
    if (exitArmed) {
      onExit()
      return
    }
    setExitArmed(true)
    window.clearTimeout(exitTimer.current)
    exitTimer.current = window.setTimeout(() => setExitArmed(false), 3000)
  }

  // 搜索结果跳转:清关键词 → 切分页 → 高亮目标卡片并滚动到位
  function jumpToSetting(tab: SettingsTab, card: string) {
    setSettingsQuery('')
    setSettingsTab(tab)
    setFlashCard(card)
    window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setFlashCard(null), 2200)
  }

  // 高亮卡片渲染完成后滚动到可视区(切分页时内容尚未挂载,稍等一拍)
  useEffect(() => {
    if (!flashCard) return
    const t = window.setTimeout(() => {
      const el = setBodyRef.current?.querySelector(`[data-card="${CSS.escape(flashCard)}"]`)
      el?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }, 40)
    return () => window.clearTimeout(t)
  }, [flashCard])

  const value: SettingsSessionApi = { ...session, bridge, flashCard }

  // 设置搜索:标签/卡片/关键词任一包含即命中(不区分大小写)
  const settingsQueryNorm = settingsQuery.trim().toLowerCase()
  const searchHits = settingsQueryNorm
    ? SETTINGS_SEARCH_INDEX.filter((e) =>
        `${e.label} ${e.card} ${e.keywords ?? ''}`.toLowerCase().includes(settingsQueryNorm),
      )
    : []
  const currentTabLabel =
    SETTINGS_NAV.flatMap((g) => g.items).find((i) => i.id === settingsTab)?.label ?? '设置'
  const TabContent = TAB_CONTENT[settingsTab]

  return (
    <SettingsContext.Provider value={value}>
      <div ref={innerRef} className={`settings-window${theme === 'light' ? ' light' : ''}`}>
        <aside className="set-side">
          <div className="set-brand">
            <span className="set-brand-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33 1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82 1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </span>
            <strong>设置</strong>
          </div>
          <div className="set-search">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <line x1="16.5" y1="16.5" x2="21" y2="21" />
            </svg>
            <input
              type="text"
              value={settingsQuery}
              placeholder="搜索设置…"
              onChange={(e) => setSettingsQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation() // 先清搜索词,别把整个设置窗口关了
                  setSettingsQuery('')
                } else if (e.key === 'Enter' && searchHits[0]) {
                  jumpToSetting(searchHits[0].tab, searchHits[0].card)
                }
              }}
            />
          </div>
          {SETTINGS_NAV.map((group) => (
            <div key={group.group} className="set-nav-group">
              <div className="set-nav-caption">{group.group}</div>
              <nav className="set-nav">
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    className={`set-nav-item${settingsTab === item.id ? ' on' : ''}`}
                    onClick={() => {
                      setSettingsQuery('')
                      setSettingsTab(item.id)
                    }}
                  >
                    <span className="set-nav-icon">{item.icon}</span>
                    {item.label}
                  </button>
                ))}
              </nav>
            </div>
          ))}
          <div className="set-side-note">所有设置自动保存,仅保存在本机。</div>
        </aside>
        <section className="set-main">
          <header className="set-head">
            <div className="set-head-title">
              <span className="set-eyebrow">{TAB_GROUP[settingsTab]}</span>
              <h1>{currentTabLabel}</h1>
            </div>
            <div className="set-head-actions">
              <span
                className={`set-save${session.saveError ? ' err' : session.savedTick !== 0 ? ' ok' : ''}`}
                title={session.saveError ? '保存失败,详见控制台日志' : '所有更改自动保存,即时生效'}
              >
                {session.saveError ? '保存失败' : session.savedTick !== 0 ? '已保存' : '自动保存'}
              </span>
              <button
                className={`set-exit${exitArmed ? ' armed' : ''}`}
                title={exitArmed ? '再点一次确认退出' : '退出程序(3 秒内再点确认)'}
                onClick={requestExit}
              >
                {exitArmed ? '确认退出' : '退出程序'}
              </button>
            </div>
          </header>
          <div ref={setBodyRef} className="set-body">
            {settingsQuery.trim() !== '' ? (
              <div className="set-results">
                <div className="set-note">
                  {searchHits.length > 0
                    ? `找到 ${searchHits.length} 个设置项,点击跳转`
                    : `没有找到与「${settingsQuery.trim()}」相关的设置`}
                </div>
                {searchHits.map((hit) => (
                  <button
                    key={`${hit.tab}-${hit.card}-${hit.label}`}
                    className="set-result"
                    onClick={() => jumpToSetting(hit.tab, hit.card)}
                  >
                    <span className="set-result-label">{hit.label}</span>
                    <span className="set-result-crumb">
                      {TAB_GROUP[hit.tab]} · {hit.card}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <TabContent />
            )}
          </div>
        </section>
      </div>
    </SettingsContext.Provider>
  )
}
