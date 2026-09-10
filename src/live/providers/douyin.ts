// 抖音弹幕 Provider(桩实现):接口先行,上游调用零改动。
// 真实实现需要 protobuf 帧解析 + 签名风控(msToken/a_bogus,随版本漂移),
// 待 B 站链路跑稳后在本文件内迭代;connect 直接上报 error,由上层落任务卡。

import type { LiveDanmakuProvider } from '../types'

export const douyinProvider: LiveDanmakuProvider = {
  platform: 'douyin',
  connect(_roomId, _onMessage, onStatus) {
    onStatus({ state: 'error', detail: '抖音弹幕即将支持,当前请选择B站平台' })
  },
  disconnect() {
    // 桩:无连接可断
  },
}
