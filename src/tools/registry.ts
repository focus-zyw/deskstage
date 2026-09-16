// 工具注册表:安全事实源。新增一个工具 = 新建 adapters/ 文件 + 这里注册一行
// + configStore 的 tools.switches 自动可配(MODES 注册表同款扩展纪律)。
// 模型报上来的工具名必须逐字命中这里,validate 再清一次参数——两道都在,
// 模型输出才被允许触碰真实世界。
import type { CharacterTool } from './types'
import { captureScreenTool } from './adapters/captureScreen'
import { listDesktopFilesTool } from './adapters/listDesktopFiles'
import { mediaControlTool } from './adapters/mediaControl'
import { openTargetTool } from './adapters/openTarget'
import { readClipboardTool } from './adapters/readClipboard'
import { recognizeTextTool } from './adapters/recognizeText'
import { runAppTool } from './adapters/runApp'
import { searchMemoryTool } from './adapters/searchMemory'
import { sendLiveMessageTool } from './adapters/sendLiveMessage'
import { sendNotificationTool } from './adapters/sendNotification'
import { setVolumeTool } from './adapters/setVolume'
import { windowActionTool } from './adapters/windowAction'

export const TOOLS = {
  capture_screen: captureScreenTool,
  recognize_text: recognizeTextTool,
  search_memory: searchMemoryTool,
  send_live_message: sendLiveMessageTool,
  read_clipboard: readClipboardTool,
  list_desktop_files: listDesktopFilesTool,
  open_target: openTargetTool,
  run_app: runAppTool,
  media_control: mediaControlTool,
  set_volume: setVolumeTool,
  window_action: windowActionTool,
  send_notification: sendNotificationTool,
} satisfies Record<string, CharacterTool>

export type ToolId = keyof typeof TOOLS & string

export function toolList(): CharacterTool[] {
  return Object.values(TOOLS)
}

export function toolOf(id: string): CharacterTool | undefined {
  return (TOOLS as Record<string, CharacterTool>)[id]
}
