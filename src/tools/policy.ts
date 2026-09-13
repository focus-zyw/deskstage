// 工具权限策略(纯函数):风险分级 × 本地设置 → 自动执行/需要确认/拒绝。
// 唯一事实源是本地配置——模型输出里没有任何能影响这里的字段,
// 这是"模型只建议、不决定安全"的机制保证。
//
// 矩阵:
//   开关关            → denied(候选门槛已挡,这里是双保险)
//   read              → allow-auto
//   external + 已记住 → allow-auto(autoApproved 只能由用户在设置/确认卡勾选)
//   external          → need-confirm(角色演绎确认,见 App 的 ToolHost 桥)
//   local-write       → need-confirm(一期没有此类工具,规则先立好)

import type { ToolManifest, ToolSettings, PolicyVerdict } from './types'

export function toolEnabled(settings: ToolSettings, manifest: ToolManifest): boolean {
  const v = settings.switches?.[manifest.id]
  return typeof v === 'boolean' ? v : manifest.defaultEnabled
}

export function decidePolicy(settings: ToolSettings, manifest: ToolManifest): PolicyVerdict {
  if (!toolEnabled(settings, manifest)) return 'denied'
  if (manifest.risk === 'read') return 'allow-auto'
  return settings.autoApproved?.[manifest.id] === true ? 'allow-auto' : 'need-confirm'
}
