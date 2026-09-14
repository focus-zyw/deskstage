// 网页站点登录行(共享组件):AI 剧场与群聊角色绑定的网页绑定共用。
// 打开可见 Edge 窗口登录一次,登录态长期有效;状态文本本组件私有。
import { useState } from 'react'
import { webchatLogin, webchatProbe, type WebchatSite } from '../engine/webchat'
import { SetLine } from './SettingsPrimitives'

export function SiteLoginRow({ label, site }: { label: string; site: WebchatSite }) {
  const [status, setStatus] = useState('')
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
      </div>
      {status && <div className="set-note">{status}</div>}
    </SetLine>
  )
}
