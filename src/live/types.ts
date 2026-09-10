// 直播弹幕源抽象:统一 Provider 接口 + 归一化消息。
// 为什么:不同平台(B站/抖音…)的握手、压缩、包格式各异,上游(过滤管线/AI 决策)
// 只认同一种 DanmakuMessage;新平台 = 实现一个 provider 注册进 PROVIDERS,上游零改动。

export type LivePlatform = 'bilibili' | 'douyin'

/** 归一化弹幕:所有平台共用。guard = 舰长/粉丝等级类标识(无则 0),事件类型 v1 只有普通弹幕 */
export interface DanmakuMessage {
  platform: LivePlatform
  /** 连接时的房间号(原样回传,便于多房间排查) */
  roomId: string
  userId: string
  username: string
  content: string
  /** 收到时间(本地毫秒),管线的过期丢弃用它 */
  timestamp: number
  /** 舰长等级(0 = 普通观众);后续礼物/SC 也在此结构上加字段 */
  guard: number
}

export type LiveStatusState = 'connecting' | 'live' | 'closed' | 'error'

export interface LiveStatus {
  state: LiveStatusState
  /** 人类可读说明(错误原因/重连提示),直接上任务卡 */
  detail?: string
}

/** 弹幕源提供方。connect 后异步上报状态与消息;disconnect 后不得再回调。
 *  同一实例同一时间只服务一个房间(由 session 层保证,重复 connect 视为重新连接)。
 *  credential = 平台登录凭证(不透明字符串,由设置面板配置):
 *  B站 = SESSDATA 或完整 Cookie 串(不填则观众名被打码,如"张***");
 *  抖音(v2) = ttwid 等。各平台自行解析,上游不感知格式 */
export interface LiveDanmakuProvider {
  readonly platform: LivePlatform
  connect(
    roomId: string,
    onMessage: (m: DanmakuMessage) => void,
    onStatus: (s: LiveStatus) => void,
    credential?: string,
  ): void
  disconnect(): void
}
