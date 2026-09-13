// 运行时诊断监视:CSP 违规 + 未捕获异常/拒绝 转发到 Rust 日志。
// CSP 与真实资源需求之间可能有未知落差(延迟任务、错误回退路径、站点改版
// 引入的加载),仅靠人工开页面容易漏;前端 console 的报错在 `pnpm tauri dev`
// 终端里也看不到。两者统一经 report_csp_violation 上报,dev 终端立即可见;
// 按 指令+资源 去重,会话内总量封顶防刷屏。两个入口(main/settings)各装一次。
import { invoke } from '@tauri-apps/api/core'
import { inTauri } from '../storage/configStore'

const MAX_REPORTS = 50

export function installCspMonitor(): void {
  if (!inTauri || typeof window === 'undefined') return
  const seen = new Set<string>()
  let reported = 0

  const report = (tag: string, detail: string): void => {
    if (reported >= MAX_REPORTS) return
    const key = `${tag}|${detail}`
    if (seen.has(key)) return
    seen.add(key)
    reported++
    void invoke('report_csp_violation', {
      directive: tag,
      blocked: detail,
      source: '',
    }).catch(() => {})
  }

  window.addEventListener('securitypolicyviolation', (e) => {
    report(`CSP:${e.effectiveDirective}`, e.blockedURI)
  })
  window.addEventListener('error', (e) => {
    const detail =
      e instanceof ErrorEvent
        ? `${e.message} @${e.filename}:${e.lineno}`
        : String((e as ErrorEvent).error ?? e)
    report('error', detail.slice(0, 300))
  })
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason instanceof Error ? `${e.reason.name}: ${e.reason.message}` : String(e.reason)
    report('unhandledrejection', reason.slice(0, 300))
  })
}
