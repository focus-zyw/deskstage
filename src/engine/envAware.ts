// 桌面环境感知(方案5):低频轮询 Rust 侧 env_snapshot,维护环境状态与冷却账本。
// 生成注入用 envContext():每条感知在冷却窗口内只出现一次,避免变成"新闻播报"。
// 策略判断用访问器(isFullscreenApp/isUserActive):给安静陪伴/自发聊天当闸门。
// 快照只在本机内存里,除了注入的"类别级"文字外什么都不上传。

import { invoke } from '@tauri-apps/api/core'

export interface EnvSnapshot {
  batteryPercent: number | null
  charging: boolean | null
  networkOk: boolean
  /** 前台应用类别:editor/browser/terminal/media/other;null = 自己在前台 */
  foreground: string | null
  fullscreenApp: boolean
  idleMinutes: number
  audioPlaying: boolean
}

const CATEGORY_LABEL: Record<string, string> = {
  editor: '代码编辑器',
  browser: '浏览器',
  terminal: '终端命令行',
  media: '音乐/视频播放器',
}

let last: EnvSnapshot | null = null
let pollTimer: number | null = null

/** 用户活跃(键鼠 5 分钟内有动静)——"连续工作"的判定基础 */
export function isUserActive(): boolean {
  return (last?.idleMinutes ?? 99) < 5
}

/** 前台是否全屏应用(视频/游戏/演示)——安静陪伴模式的闭麦闸门 */
export function isFullscreenApp(): boolean {
  return !!last?.fullscreenApp
}

/** 前台应用类别(editor/browser/terminal/media;null=自己在前台或未感知)。
 *  话题候选的环境源用:只取类别级标签,不含任何原始窗口/屏幕内容 */
export function envForegroundCategory(): string | null {
  const fg = last?.foreground ?? null
  return fg && fg !== 'other' ? fg : null
}

async function poll(): Promise<void> {
  try {
    last = await invoke<EnvSnapshot>('env_snapshot')
  } catch {
    // 传感器失败保持上次状态,不打扰演出
  }
}

/** 启动 60 秒低频轮询(重复调用幂等) */
export function startEnvPolling(intervalMs = 60_000): void {
  if (pollTimer !== null) return
  void poll()
  pollTimer = window.setInterval(() => void poll(), intervalMs)
}

/** 停止轮询(用户关闭环境感知时) */
export function stopEnvPolling(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
  last = null
}

// ---------- 生成注入:冷却账本 ----------

const cooldowns = new Map<string, number>()

/** 生成注入用环境语境:每条在冷却窗口内只出现一次;无可用素材返回 undefined。
 *  冷却时长由配置传入(设置里可调,默认 6 小时),账本本身仍在内存(重启即清零) */
export function envContext(cooldownMs: number): string | undefined {
  const s = last
  if (!s) return undefined
  const parts: string[] = []
  const now = Date.now()
  const fire = (key: string, text: string): void => {
    if (now - (cooldowns.get(key) ?? 0) < cooldownMs) return
    cooldowns.set(key, now)
    parts.push(text)
  }
  if (s.batteryPercent !== null && s.batteryPercent <= 20 && s.charging === false) {
    fire('battery-low', `电脑电量只剩 ${s.batteryPercent}%,还没插电`)
  } else if (s.batteryPercent !== null && s.batteryPercent >= 95 && s.charging === true) {
    fire('battery-full', '电脑刚充满了电,精神抖擞')
  }
  if (s.idleMinutes >= 90 && s.idleMinutes < 600) {
    fire('work-long', `用户已经连续忙了 ${s.idleMinutes} 分钟没休息`)
  }
  if (s.audioPlaying) {
    fire('audio', '用户正听着歌或看着视频(有声音在播)')
  }
  if (s.foreground && s.foreground !== 'other') {
    const label = CATEGORY_LABEL[s.foreground] ?? '别的软件'
    fire(`fg-${s.foreground}`, `用户正开着${label}忙`)
  }
  if (!s.networkOk) {
    fire('network-off', '网络断开了(刚恢复,可以调侃一下刚才的断网)')
  }
  return parts.length ? parts.join(';') : undefined
}
