// 语音识别 · 服务层:AsrProvider 契约 + 供应商路由。
// 云端先行:硅基流动 OpenAI 兼容转录端点,请求经 Rust asr_transcribe 命令发
// multipart(Rust 侧读凭据库 asr:siliconflow,密钥不流经前端,硬化清单见
// src-tauri/src/asr.rs)。local 桩留给二期 whisper.cpp(接口不变)。
// 失败向上抛,由 voiceSession 决定降级文案;空串返回 = 服务正常但没听清。
import { invoke } from '@tauri-apps/api/core'
import type { AsrConfig } from '../../storage/configStore'
import { pcmToWav } from '../tts/wav'

export interface AsrProvider {
  id: AsrConfig['provider']
  label: string
  /** 单声道 PCM16 → 文本。空串 = 没听清;抛错 = 服务/配置不可用 */
  transcribe(pcm: Int16Array, sampleRate: number, model: string): Promise<string>
}

/** 二进制 → base64(invoke 传参用;分块规避 String.fromCharCode 展开上限) */
export function bytesToBase64(u8: Uint8Array): string {
  let s = ''
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode(...u8.subarray(i, i + 0x8000))
  }
  return btoa(s)
}

export const siliconflowAsrProvider: AsrProvider = {
  id: 'siliconflow',
  label: '硅基流动',
  async transcribe(pcm, sampleRate, model) {
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
    const wav = new Uint8Array(pcmToWav(bytes, sampleRate, 1, 16))
    const r = await invoke<{ text: string }>('asr_transcribe', {
      wavBase64: bytesToBase64(wav),
      model,
    })
    return r.text.trim()
  },
}

/** 本地离线识别(二期已接入):Rust local_asr 模块进程内跑 SenseVoiceSmall int8
 *  (sherpa-onnx),模型文件一次下载常驻 appdata;零延迟零配额,语音不出门 */
export const localAsrProvider: AsrProvider = {
  id: 'local',
  label: '本地 SenseVoice(离线)',
  async transcribe(pcm, sampleRate) {
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
    const wav = new Uint8Array(pcmToWav(bytes, sampleRate, 1, 16))
    const r = await invoke<{ text: string }>('asr_transcribe_local', {
      wavBase64: bytesToBase64(wav),
    })
    return r.text.trim()
  },
}

export function asrProviderById(id: AsrConfig['provider']): AsrProvider {
  return id === 'local' ? localAsrProvider : siliconflowAsrProvider
}
