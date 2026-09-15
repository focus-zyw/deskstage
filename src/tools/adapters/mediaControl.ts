// media_control 工具:播放/暂停/切歌等媒体键(external,需确认)。
// 走全局多媒体键(与键盘上的媒体键等价),对当前在播的应用生效。
import { invoke } from '@tauri-apps/api/core'
import { scoreByRules } from '../candidateGate'
import { validateToolInput, type ToolInputSchema } from '../schema'
import type { CharacterTool, ToolManifest } from '../types'

const ACTIONS = ['playpause', 'next', 'prev', 'stop'] as const
type MediaAction = (typeof ACTIONS)[number]

const ACTION_LABEL: Record<MediaAction, string> = {
  playpause: '已切换播放/暂停',
  next: '已切到下一首',
  prev: '已切到上一首',
  stop: '已停止播放',
}

const inputSchema: ToolInputSchema = {
  properties: {
    action: { type: 'string', enum: [...ACTIONS], description: 'playpause=播放/暂停,next=下一首,prev=上一首,stop=停止' },
  },
  required: ['action'],
}

const manifest: ToolManifest = {
  id: 'media_control',
  label: '媒体控制',
  description: '控制正在播放的音乐/视频:播放暂停/下一首/上一首/停止',
  risk: 'external',
  inputSchema,
  timeoutMs: 5_000,
  defaultEnabled: false,
  match: (text) =>
    scoreByRules(text, [
      { re: /(下一首|上一首|切歌|换一首|暂停(音乐|歌|视频|一下)?|继续(播|放)|停止(播放|音乐|视频))/, weight: 0.95 },
      { re: /(音乐|视频|歌)(控制|键)/, weight: 0.5 },
    ]),
  presentation: { actor: 'C', pendingText: '我来操作播放…', action: 'thinking' },
}

export const mediaControlTool: CharacterTool = {
  manifest,
  available: () => true,
  validate: (input) => validateToolInput(inputSchema, input),
  async execute(input) {
    const action = String((input as { action: string }).action)
    await invoke('media_control', { action })
    return { ok: true, summary: ACTION_LABEL[action as MediaAction] ?? '已执行' }
  },
}
