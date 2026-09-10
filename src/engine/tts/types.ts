// TTS 供应商契约:每家实现 synthesizeStream 返回「音频字节流 + 元信息」,
// 服务层(index.ts)统一负责缓存、通道仲裁与播放;新增供应商只动这一层。
import type { AppConfig, TtsProviderId } from '../../storage/configStore'

export interface VoiceOption {
  id: string
  label: string
}

/** 一次合成请求:text 是原始台词(不含情感指令),如何表达语气由 provider 自行决定 */
export interface SynthRequest {
  text: string
  /** 该 provider 命名空间内的音色 id(内置名或克隆 uri) */
  voice: string
  /** 语速,1 = 常速 */
  speed: number
  /** 语气标注(dialogSchema 的 deadpan/excited/slow;缺省 = 不标注) */
  delivery?: string
  /** 期望采样率;provider 按自身能力取值 */
  sampleRate: number
}

/** 音频流元信息:player 据此搭解码/播放管线 */
export interface AudioStreamMeta {
  /** wav = 流自带 RIFF 头(player 自动剥离);pcm = 裸 Int16LE,按下列参数解读 */
  format: 'wav' | 'pcm'
  sampleRate: number
  channels: number
  bitsPerSample: number
}

export interface TtsStream {
  meta: AudioStreamMeta
  body: ReadableStream<Uint8Array>
}

/** provider 运行所需的凭据快照(服务层从 config 提取,provider 不直接读配置) */
export interface TtsCredentials {
  apiKey: string
  /** MiniMax 账号 GroupId */
  groupId?: string
  /** MiniMax 模型 id */
  model?: string
  /** 是否启用自然语言情感/语气表达 */
  emotionHints: boolean
}

export interface TtsProvider {
  id: TtsProviderId
  /** 设置页下拉用名 */
  label: string
  /** 设置页音色下拉的内置选项 */
  voices: VoiceOption[]
  /** 参与缓存键的模型 id(模型换了,缓存自然失效) */
  modelId(cfg: AppConfig): string
  /** 凭据齐备返回 null,否则返回面向用户的缺失提示(服务层 warn-once) */
  missingSetup(cfg: AppConfig): string | null
  /** 流式合成;失败抛错,由服务层静默降级 */
  synthesizeStream(req: SynthRequest, creds: TtsCredentials): Promise<TtsStream>
}
