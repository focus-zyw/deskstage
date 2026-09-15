// 网页站点登录行(共享组件):AI 剧场与群聊角色绑定的网页绑定共用。
// 打开可见 Edge 窗口登录一次,登录态长期有效;状态文本本组件私有。
// 恢复模式(方案 §十四):每站点可选 自动恢复(推荐)/始终标签页/始终独立窗口;
// 选择持久化在配置 webchatSiteModes,并即时回放到 Rust Hub(内存态,启动时
// 由 App 再回放一次)。运行状态(标签页模式/待切换独立窗口/独立窗口)按需拉取。
import { useEffect, useState } from 'react'
import {
  webchatLogin,
  webchatProbe,
  webchatReevaluateSite,
  webchatSetSiteMode,
  webchatSiteStatus,
  type WebchatSite,
  type WebchatSiteStatus,
} from '../engine/webchat'
import type { WebchatSiteMode } from '../storage/configStore'
import { useSettings } from './useSettingsSession'
import { SetLine } from './SettingsPrimitives'
const MODE_LABELS: Record<WebchatSiteMode, string> = {
  auto: '自动恢复(推荐)',
  preferTab: '始终使用标签页',
  preferDedicated: '始终使用独立窗口',
}

const RUNTIME_LABELS: Record<WebchatSiteStatus['mode'], string> = {
  tab: '已就绪 · 标签页模式',
  dedicatedPending: '该站点已标记:下次重建切换独立窗口',
  dedicated: '该站点已自动切换为独立窗口',
}

export function SiteLoginRow({ label, site }: { label: string; site: WebchatSite }) {
  const { form, saveField } = useSettings()
  const [status, setStatus] = useState('')
  const [live, setLive] = useState<WebchatSiteStatus | null>(null)
  const mode: WebchatSiteMode = form.webchatSiteModes?.[site] ?? 'auto'

  /** 拉一次 Hub 侧恢复状态(失败静默:Hub 不可用不影响登录操作) */
  function refreshLive() {
    void webchatSiteStatus(site)
      .then(setLive)
      .catch(() => setLive(null))
  }

  useEffect(refreshLive, [site])

  async function changeMode(next: WebchatSiteMode) {
    saveField({ webchatSiteModes: { ...form.webchatSiteModes, [site]: next } }, true)
    try {
      await webchatSetSiteMode(site, next)
      setStatus(next === 'auto' ? '已恢复自动模式' : `已切换:${MODE_LABELS[next]}`)
    } catch (e) {
      setStatus(`模式设置失败:${String(e)}`)
    }
    refreshLive()
  }

  return (
    <SetLine title={label} hint="打开可见 Edge 窗口登录一次,登录态长期有效">
      <div className="shot-key-row">
        <button
          className="panel-btn"
          onClick={() => {
            setStatus('正在打开 Edge 窗口…')
            void webchatLogin(site)
              .then(() => setStatus('窗口已打开,角色保持显示;登录完成后可查状态'))
              .catch((e) => setStatus(`打开失败:${String(e)}`))
          }}
        >
          打开登录窗口
        </button>
        <button
          className="panel-btn"
          onClick={() => {
            setStatus('检查中…')
            void webchatProbe(site)
              .then((p) => setStatus(p.ready ? '已就绪 ✓' : `未就绪:${p.detail}`))
              .catch((e) => setStatus(`检查失败:${String(e)}`))
          }}
        >
          查状态
        </button>
        <select
          aria-label="恢复模式"
          value={mode}
          onChange={(e) => void changeMode(e.target.value as WebchatSiteMode)}
        >
          {(Object.keys(MODE_LABELS) as WebchatSiteMode[]).map((m) => (
            <option key={m} value={m}>
              {MODE_LABELS[m]}
            </option>
          ))}
        </select>
      </div>
      {status && <div className="set-note">{status}</div>}
      {live && (
        <div className="set-note">
          {RUNTIME_LABELS[live.mode]}
          {live.override === 'preferTab' && '(用户固定标签页)'}
          {live.override === 'preferDedicated' && '(用户固定独立窗口)'}
          {live.mode !== 'tab' && (
            <>
              {' · '}
              <button className="panel-btn" onClick={() => void webchatReevaluateSite(site).then(refreshLive)}>
                重新评估该站点
              </button>
            </>
          )}
        </div>
      )}
    </SetLine>
  )
}
