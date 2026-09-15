// 世界模型 · 显著性渲染(纯函数):WorldState → 给提示词的有限几句话。
//
// Brain 不吃原始 WorldState:吃的是"渲染过的事实",长度才有恒定预算。
// 冷却账本由调用方持有(跨帧/跨通道去重:同一条感知在冷却窗口内只出现一次,
// 演出通道消费过的注记聊天通道不会复读);账本在内存,重启即清零。
// 预算上限(条数/字符):传感器加到十个,注入长度也不涨——防"新闻播报"的机制化。

import type { WorldState } from './types'

/** 渲染冷却账本:键 → 上次出现时间戳;由 WorldEngine 持有 */
export type RenderLedger = Map<string, number>

/** 最多几条 / 总长上限:超过直接丢弃余下(优先级 = 书写顺序) */
export const NOTE_MAX_ITEMS = 6
export const NOTE_MAX_CHARS = 220

/** 常用 exe → 面向观众的友好名(本地映射,命中不了去 .exe 原样) */
const APP_LABEL: Record<string, string> = {
  'idea64.exe': 'IDEA',
  'webstorm64.exe': 'WebStorm',
  'pycharm64.exe': 'PyCharm',
  'clion64.exe': 'CLion',
  'goland64.exe': 'GoLand',
  'rider64.exe': 'Rider',
  'phpstorm64.exe': 'PhpStorm',
  'datagrip64.exe': 'DataGrip',
  'androidstudio64.exe': 'Android Studio',
  'code.exe': 'VS Code',
  'code - insiders.exe': 'VS Code',
  'cursor.exe': 'Cursor',
  'zcode.exe': 'ZCode',
  'windsurf.exe': 'Windsurf',
  'trae.exe': 'Trae',
  'zed.exe': 'Zed',
  'devenv.exe': 'Visual Studio',
  'eclipse.exe': 'Eclipse',
  'sublime_text.exe': 'Sublime',
  'notepad++.exe': 'Notepad++',
  'notepad.exe': '记事本',
  'wechatdevtools.exe': '微信开发者工具',
  'hbuilderx.exe': 'HBuilderX',
  'wechat.exe': '微信',
  'weixin.exe': '微信',
  'qq.exe': 'QQ',
  'dingtalk.exe': '钉钉',
  'feishu.exe': '飞书',
  'wps.exe': 'WPS',
  'winword.exe': 'Word',
  'excel.exe': 'Excel',
  'powerpnt.exe': 'PPT',
  'cloudmusic.exe': '网易云音乐',
  'qqmusic.exe': 'QQ音乐',
  'kugou.exe': '酷狗音乐',
  'kuwo.exe': '酷我音乐',
  'bilibili.exe': '哔哩哔哩',
  'potplayermini64.exe': 'PotPlayer',
  'spotify.exe': 'Spotify',
  'steam.exe': 'Steam',
}

/** exe 名 → 友好名(渲染专用;不认识就退回去扩展名的原名,绝不外传原文) */
export function friendlyAppName(exe: string | null): string | null {
  if (!exe) return null
  const known = APP_LABEL[exe]
  if (known) return known
  return exe.replace(/\.exe$/i, '') || null
}

const CATEGORY_LABEL: Record<string, string> = {
  editor: '代码编辑器',
  browser: '浏览器',
  terminal: '终端命令行',
  media: '音乐/视频播放器',
}

/** 渲染注记:每条在冷却窗口内只出现一次;无可用素材返回 undefined。
 *  state 为 null(未感知/感知关闭)恒 undefined */
export function renderWorldNote(
  state: WorldState | null,
  cooldownMs: number,
  now: number,
  ledger: RenderLedger,
): string | undefined {
  if (!state) return undefined
  const parts: string[] = []
  const fire = (key: string, text: string): void => {
    if (parts.length >= NOTE_MAX_ITEMS) return
    const last = ledger.get(key)
    if (last !== undefined && now - last < cooldownMs) return
    ledger.set(key, now)
    parts.push(text)
  }

  if (state.batteryPercent !== null && state.batteryPercent <= 20 && state.charging === false) {
    fire('battery-low', `电脑电量只剩 ${state.batteryPercent}%,还没插电`)
  } else if (state.batteryPercent !== null && state.batteryPercent >= 95 && state.charging === true) {
    fire('battery-full', '电脑刚充满了电,精神抖擞')
  }
  if (state.idleMinutes >= 90 && state.idleMinutes < 600) {
    fire('work-long', `用户已经连续忙了 ${state.idleMinutes} 分钟没休息`)
  }
  if (state.audioPlaying) {
    const app = friendlyAppName(state.mediaName)
    fire('audio', app ? `用户正用${app}放着歌或看着视频` : '用户正听着歌或看着视频(有声音在播)')
  }
  if (state.foreground && state.foreground !== 'other') {
    const app = friendlyAppName(state.processName)
    const label = app ?? CATEGORY_LABEL[state.foreground] ?? '别的软件'
    const title = state.activeWindowTitle
    fire(
      `fg-${app ?? state.foreground}`,
      title ? `用户正开着${label},在〈${title}〉里忙` : `用户正开着${label}忙`,
    )
  }
  if (state.cpuPercent !== null && state.cpuPercent >= 90) {
    fire('cpu-high', '电脑 CPU 快跑满了,正干重活')
  }
  if (state.memPercent !== null && state.memPercent >= 90) {
    fire('mem-high', '内存快占满了')
  }
  if (state.desktopFileCount !== null && state.desktopFileCount >= 30) {
    fire('desktop-crowd', `用户桌面上堆了 ${state.desktopFileCount} 个文件,挺乱的`)
  }
  if (!state.networkOk) {
    fire('network-off', '网络断开了(刚恢复,可以调侃一下刚才的断网)')
  }
  if (parts.length === 0) return undefined
  return parts.join(';').slice(0, NOTE_MAX_CHARS)
}
