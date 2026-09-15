// 世界模型 · 生产入口(模块级单例,envAware 的接替者)。
// WorldState 是"世界"的唯一事实源:传感器归一、差分事件、注记渲染都收在 world/ 里,
// Brain(llmClient/群聊 actor/主动调度/话题候选)只经这里的访问器与 note() 消费。
//
// 感知开关语义:
// · envSense / breakReminder.enabled 任一开启 → 轮询(久坐依赖键鼠空闲传感器,与环境感知解耦)
// · contextSense.windowTitle → 决定 Rust 是否采集窗口标题(不采,不是采了不渲染)
// · contextSense.desktopDigest → 低频桌面文件数摘要(10 分钟一拍,只取数量)

import { invoke } from '@tauri-apps/api/core'
import { getConfig } from '../storage/configStore'
import { createWorldEngine } from './engine'
import { fetchEnvSnapshot } from './sensors/envSensor'
import type { WorldEvent, WorldState } from './types'

export { friendlyAppName } from './render'
export type { EnvSnapshotRaw, WorldEvent, WorldState } from './types'

const DESKTOP_DIGEST_INTERVAL_MS = 10 * 60_000

const engine = createWorldEngine({ fetch: () => fetchEnvSnapshot() })

let digestTimer: number | null = null

/** 启动世界采样(幂等)。envAware.startEnvPolling 的接替者 */
export function startWorld(intervalMs = 60_000): void {
  engine.start(intervalMs)
  if (digestTimer === null) {
    digestTimer = window.setInterval(() => void refreshDesktopDigest(), DESKTOP_DIGEST_INTERVAL_MS)
  }
}

/** 停止采样并清空状态(感知关闭时;账本随状态一并清零) */
export function stopWorld(): void {
  engine.stop()
  if (digestTimer !== null) {
    window.clearInterval(digestTimer)
    digestTimer = null
  }
}

export function worldState(): WorldState | null {
  return engine.snapshot()
}

/** 生成注入用世界注记:每条在冷却窗口内只出现一次,无可用素材返回 undefined。
 *  全局唯一账本:演出通道消费过的注记,聊天通道不会在冷却期内复读 */
export function worldNote(cooldownMs: number): string | undefined {
  return engine.note(cooldownMs)
}

/** 差分事件订阅:返回退订函数(App 卸载时清理) */
export function onWorldEvent(fn: (event: WorldEvent) => void): () => void {
  return engine.onEvent(fn)
}

/** 用户活跃(键鼠 5 分钟内有动静)——"连续工作"的判定基础 */
export function isUserActive(): boolean {
  return (engine.snapshot()?.idleMinutes ?? 99) < 5
}

/** 前台是否全屏应用(视频/游戏/演示)——安静陪伴/闭麦的闸门 */
export function isFullscreenApp(): boolean {
  return !!engine.snapshot()?.fullscreenApp
}

/** 前台应用类别(editor/browser/terminal/media;null=自己在前台或未感知)。
 *  话题候选的环境源用:只取类别级标签,不含任何原始窗口/屏幕内容 */
export function envForegroundCategory(): string | null {
  const fg = engine.snapshot()?.foreground ?? null
  return fg && fg !== 'other' ? fg : null
}

async function refreshDesktopDigest(): Promise<void> {
  try {
    const cfg = await getConfig()
    if (cfg.contextSense.desktopDigest !== true) return
    const files = await invoke<{ name: string }[]>('desktop_files_list')
    engine.noteDesktopFileCount(files.length)
  } catch {
    // 摘要失败不进状态,下个周期再试
  }
}
