// 常驻角色 C(桌面 WebM 小管家)的共享类型。
// C 的渲染与状态仲裁完全收敛在本目录(resident/),对话协议只传词表动作,不感知视频文件。

/** C 的片段 ID(= public/animations/c/ 下的文件名,不含扩展名)。
 *  命名分组:基础状态 / 动作词补缺 / 管家日常 / 时间情境 / 节日 / 情绪 / 工具 / 稀有彩蛋 */
export type ResidentClipId =
  // 基础状态
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
  // 动作词补缺(此前 sad/sleepy/shake/jump 回退待机)
  | 'sigh'
  | 'fallen'
  | 'yawn'
  | 'nap'
  | 'squash'
  | 'jump_smash'
  | 'cheer'
  | 'pace'
  // 管家日常与玩心(待机链)
  | 'wipe'
  | 'screen_mutter'
  | 'daze'
  | 'cat'
  | 'mirror'
  | 'cube'
  | 'toy_car'
  | 'kick_shuttle'
  | 'rocking_horse'
  | 'spin_top'
  | 'animals'
  | 'butterflies'
  // 点击回应
  | 'tickle'
  | 'scared'
  // 时间情境(饭点/季节)
  | 'brush'
  | 'breakfast'
  | 'lunch'
  | 'what_to_eat'
  | 'dinner'
  | 'fan'
  | 'watermelon'
  | 'ice_cream'
  | 'snowman'
  | 'hotpot'
  // 节日
  | 'fu'
  | 'red_packet'
  | 'dumplings'
  | 'fireworks'
  | 'lion_dance'
  | 'rice_cake'
  | 'tangyuan'
  | 'sky_lantern'
  | 'zongzi'
  | 'qixi_needle'
  | 'mooncake'
  | 'chongyang'
  | 'chongyang_cake'
  | 'laba_porridge'
  | 'christmas_tree'
  | 'trick_treat'
  | 'qingtuan'
  // 情绪池
  | 'rage_quit'
  | 'whale_slam'
  | 'dance'
  | 'swing_dance'
  | 'spin_show'
  // 工具任务候选
  | 'filing'
  | 'note_quick'
  // 稀有彩蛋池(低概率)
  | 'whale_rise'
  | 'whale_bubble'
  | 'dove'
  | 'card_magic'
  | 'juggle'
  | 'gomoku'
  | 'bloom'
  | 'eat_token'

/** 仲裁结果:播哪个片段、循环还是单次(单次播完停在末帧,等外部状态变化接管) */
export interface ResidentPlayback {
  clip: ResidentClipId
  loop: boolean
}
