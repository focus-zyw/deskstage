// 常驻角色 C(桌面 WebM 小管家)的共享类型。
// C 的渲染与状态仲裁完全收敛在本目录(resident/),对话协议只传词表动作,不感知视频文件。

/** C 的片段 ID(= public/animations/c/ 下的文件名,不含扩展名) */
export type ResidentClipId =
  | 'idle'
  | 'talk'
  | 'think'
  | 'happy'
  | 'wave'
  | 'angry'
  | 'surprise'
  | 'startled'
  | 'caught'
  | 'turn'
  | 'walk'
  | 'float'
  | 'drag'
  | 'working'
  | 'focus'
  | 'stretch'
  | 'hum'
  | 'tap'

/** 仲裁结果:播哪个片段、循环还是单次(单次播完停在末帧,等外部状态变化接管) */
export interface ResidentPlayback {
  clip: ResidentClipId
  loop: boolean
}
