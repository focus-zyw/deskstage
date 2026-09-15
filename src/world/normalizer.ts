// 世界模型 · 归一化与差分(纯函数):传感器原始快照 → WorldState 合并 + WorldEvent 差分。
//
// 这里是"不可信字符串进提示词"的唯一清洗点:窗口标题是页面/文件名可操控的内容,
// 与 tools/observation.ts 同一条纪律——去控制符、折叠空白、硬截断、渲染时包裹,
// 且永不写入长期记忆(世界状态只在内存,重启即清零)。

import type { EnvSnapshotRaw, WorldEvent, WorldState } from './types'

/** 用户活跃判定:键鼠 5 分钟内有动静("连续工作"与"刚回来"的判定基础) */
export const ACTIVE_IDLE_THRESHOLD_MIN = 5

/** 窗口标题入库上限:超长静默截断(防灌入,不因长度丢弃情境) */
export const WINDOW_TITLE_MAX = 60

/** 去控制符 + 折叠空白 + 硬截断。标题里可能出现提示词攻击文本,
 *  这里保证入库的是"干净的一行字",渲染层再包裹成〈标题〉形态 */
export function sanitizeWindowTitle(raw: string): string {
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.slice(0, WINDOW_TITLE_MAX)
}

/**
 * 上一帧状态 + 本帧原始采样 → (新状态, 差分事件)。
 * prev 为 null(首帧/重启)只建立基线不发事件:首帧全是"变化",播报没有意义。
 * 传感器缺数(新字段未到/平台差异)保留 prev 值或落 null,不猜。
 */
export function mergeSnapshot(
  prev: WorldState | null,
  raw: EnvSnapshotRaw,
  ts: number,
): { state: WorldState; events: WorldEvent[] } {
  const state: WorldState = {
    batteryPercent: raw.batteryPercent,
    charging: raw.charging,
    networkOk: raw.networkOk,
    foreground: raw.foreground,
    processName: raw.processName ?? null,
    activeWindowTitle: raw.activeWindowTitle ? sanitizeWindowTitle(raw.activeWindowTitle) : null,
    fullscreenApp: raw.fullscreenApp,
    idleMinutes: raw.idleMinutes,
    audioPlaying: raw.audioPlaying,
    mediaName: raw.mediaName ?? null,
    cpuPercent: raw.cpuPercent ?? null,
    memPercent: raw.memPercent ?? null,
    desktopFileCount: prev?.desktopFileCount ?? null,
    ts,
  }

  if (!prev) return { state, events: [] }

  const events: WorldEvent[] = []
  const wasActive = prev.idleMinutes < ACTIVE_IDLE_THRESHOLD_MIN
  const isActive = state.idleMinutes < ACTIVE_IDLE_THRESHOLD_MIN
  if (wasActive && !isActive) {
    events.push({ kind: 'user-idle', idleMinutes: state.idleMinutes })
  } else if (!wasActive && isActive) {
    events.push({ kind: 'user-returned', awayMinutes: prev.idleMinutes })
  }
  if (!prev.audioPlaying && state.audioPlaying) {
    events.push({ kind: 'media-started', mediaName: state.mediaName })
  } else if (prev.audioPlaying && !state.audioPlaying) {
    events.push({ kind: 'media-stopped' })
  }
  if (prev.foreground !== state.foreground || prev.processName !== state.processName) {
    events.push({
      kind: 'foreground-changed',
      foreground: state.foreground,
      processName: state.processName,
    })
  }
  if (
    state.batteryPercent !== null &&
    state.charging === false &&
    state.batteryPercent <= 20 &&
    !(prev.batteryPercent !== null && prev.batteryPercent <= 20 && prev.charging === false)
  ) {
    events.push({ kind: 'battery-low', percent: state.batteryPercent })
  }
  if (prev.networkOk && !state.networkOk) {
    events.push({ kind: 'network-off' })
  } else if (!prev.networkOk && state.networkOk) {
    events.push({ kind: 'network-on' })
  }
  return { state, events }
}
