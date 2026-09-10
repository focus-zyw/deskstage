// 弹幕源注册表:新平台 = 实现一个 LiveDanmakuProvider + 在 PROVIDERS 加一项,
// 上游(会话/管线/设置面板)零改动。仿 performer/modes 的注册表模式。
import { bilibiliProvider } from './providers/bilibili'
import { douyinProvider } from './providers/douyin'
import type { LiveDanmakuProvider, LivePlatform } from './types'

export const PROVIDERS: Record<LivePlatform, LiveDanmakuProvider> = {
  bilibili: bilibiliProvider,
  douyin: douyinProvider,
}

export const PLATFORM_LABELS: Record<LivePlatform, string> = {
  bilibili: 'B站',
  douyin: '抖音',
}

/** 平台白名单校验,未知值回退 bilibili */
export function platformOf(v: string): LivePlatform {
  return v in PROVIDERS ? (v as LivePlatform) : 'bilibili'
}

export function providerFor(platform: LivePlatform): LiveDanmakuProvider {
  return PROVIDERS[platform]
}

export type { DanmakuMessage, LiveDanmakuProvider, LivePlatform, LiveStatus } from './types'
