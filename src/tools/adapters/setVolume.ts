// set_volume 工具:音量与静音(external,需确认)。
// level(0~100)与 mute(静音开关)至少给一个;都给时先设音量再切静音。
import { invoke } from '@tauri-apps/api/core'
import { scoreByRules } from '../candidateGate'
import { type ToolInputSchema } from '../schema'
import type { CharacterTool, ToolManifest } from '../types'
import { validateVolumeInput } from './desktopCommon'

const inputSchema: ToolInputSchema = {
  properties: {
    level: { type: 'number', description: '音量 0~100' },
    mute: { type: 'boolean', description: '静音开关(切换到该状态)' },
  },
}

const manifest: ToolManifest = {
  id: 'set_volume',
  label: '调音量',
  description: '调整系统音量(0~100)或开关静音',
  risk: 'external',
  inputSchema,
  timeoutMs: 5_000,
  defaultEnabled: false,
  match: (text) =>
    scoreByRules(text, [
      { re: /(音量(调|设|开|关|大|小)|(调|设)(大|小)(一)?点?(声|音量)|调(大|小)声|轻一点|响一点|静音|取消静音)/, weight: 0.95 },
      { re: /太大声|太吵|听不见/, weight: 0.6 },
    ]),
  presentation: { actor: 'C', pendingText: '我来调音量…', action: 'thinking' },
}

export const setVolumeTool: CharacterTool = {
  manifest,
  available: () => true,
  validate: (input) => validateVolumeInput(input),
  async execute(input) {
    const { level, mute } = input as { level?: number; mute?: boolean }
    if (level !== undefined) await invoke('set_volume', { level })
    if (mute !== undefined) await invoke('toggle_mute', { muted: mute })
    const bits: string[] = []
    if (level !== undefined) bits.push(`音量已设到 ${level}`)
    if (mute !== undefined) bits.push(mute ? '已静音' : '已取消静音')
    return { ok: true, summary: bits.join(',') }
  },
}
