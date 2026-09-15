// 世界模型 · 类型唯一事实源。
// WorldState 是归一后的本机世界快照:内存态,不落盘、不上传,除渲染进提示词的
// "类别级"文字外什么都不出本机(沿用 envAware 的隐私边界)。
// WorldEvent 是两次采样间的差分,给事件消费者当触发源(主动行为/闸门)。

/** Rust env_snapshot 的原始返回(Option 字段缺省/为 null = 传感器不可用或未开启) */
export interface EnvSnapshotRaw {
  batteryPercent: number | null
  charging: boolean | null
  networkOk: boolean
  /** 前台应用类别:editor/browser/terminal/media/other;null = 自己在前台或未感知 */
  foreground: string | null
  /** 前台进程 exe 名(小写,如 idea64.exe) */
  processName?: string | null
  /** 前台窗口标题(仅 contextSense.windowTitle 开启时采集;已截断) */
  activeWindowTitle?: string | null
  fullscreenApp: boolean
  idleMinutes: number
  audioPlaying: boolean
  /** 正在发声的应用进程名(如 cloudmusic.exe;是"什么在播",不是歌曲名) */
  mediaName?: string | null
  cpuPercent?: number | null
  memPercent?: number | null
}

export interface WorldState {
  batteryPercent: number | null
  charging: boolean | null
  networkOk: boolean
  foreground: string | null
  processName: string | null
  /** 已过 sanitizeWindowTitle(去控制符/截断)——防注入清洗的产物,渲染层可直接用 */
  activeWindowTitle: string | null
  fullscreenApp: boolean
  idleMinutes: number
  audioPlaying: boolean
  mediaName: string | null
  cpuPercent: number | null
  memPercent: number | null
  /** 桌面文件数摘要(contextSense.desktopDigest 开启时低频采集) */
  desktopFileCount: number | null
  /** 本帧采集时间戳(ms) */
  ts: number
}

/** 差分事件:只在状态跨越阈值/发生变化的那一帧发一次 */
export type WorldEvent =
  | { kind: 'user-idle'; idleMinutes: number }
  | { kind: 'user-returned'; awayMinutes: number }
  | { kind: 'media-started'; mediaName: string | null }
  | { kind: 'media-stopped' }
  | { kind: 'foreground-changed'; foreground: string | null; processName: string | null }
  | { kind: 'battery-low'; percent: number }
  | { kind: 'network-off' }
  | { kind: 'network-on' }
