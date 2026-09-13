// CSP 违规监视:CSP 与真实资源需求之间可能有未知落差(延迟任务、错误回退
// 路径、站点改版引入的加载),仅靠人工开页面容易漏。把 securitypolicyviolation
// 事件转发到 Rust 日志,`pnpm tauri dev` 终端立即可见;按 指令+资源 去重,
// 会话内总量封顶防刷屏。两个入口(main/settings)各装一次,窗口独立无共享。
import { invoke } from '@tauri-apps/api/core'
import { inTauri } from '../storage/configStore'

const MAX_REPORTS = 50

export function installCspMonitor(): void {
  if (!inTauri || typeof window === 'undefined') return
  const seen = new Set<string>()
  let reported = 0
  window.addEventListener('securitypolicyviolation', (e) => {
    if (reported >= MAX_REPORTS) return
    const key = `${e.effectiveDirective}|${e.blockedURI}`
    if (seen.has(key)) return
    seen.add(key)
    reported++
    void invoke('report_csp_violation', {
      directive: e.effectiveDirective,
      blocked: e.blockedURI,
      source: e.sourceFile ?? '',
    }).catch(() => {})
  })
}
