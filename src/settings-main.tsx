// 设置窗口的独立入口(第二 WebView):窗口在 tauri.conf.json 预建、启动即隐藏,
// 每次打开只 show+focus,不销毁重建。表单/会话/各分页与旧单窗口版完全同一套组件;
// 跨窗口行为(动作/配置保存/关闭/退出)经 eventBridge 走事件,见 bridgeServer。
import { createRef } from 'react'
import { createRoot } from 'react-dom/client'
import './App.css'
import { SettingsWindow } from './settings/SettingsWindow'
import { createEventBridge, hideSettingsWindow, requestAppExit } from './settings/eventBridge'

// 独立窗口形态:设置窗铺满自身 WebView(覆盖 .settings-window 的居中面板定位)
document.body.classList.add('settings-standalone')

createRoot(document.getElementById('root')!).render(
  <SettingsWindow
    innerRef={createRef<HTMLDivElement | null>()}
    bridge={createEventBridge()}
    onClose={() => void hideSettingsWindow()}
    onExit={() => void requestAppExit()}
  />,
)
