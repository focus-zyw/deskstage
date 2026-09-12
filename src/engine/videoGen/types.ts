// 视频生成供应商契约(深模块):适配器只做"提交任务"与"查一次状态"两件事,
// 轮询节奏、任务落盘、费用确认全部由上层(videoStore 与视频工坊)统一实现——
// 新增一家服务(可灵/Vidu 等)= 新建一个适配器文件 + 在 index.ts 注册一行
// + capabilities/default.json 放行其 API 域名,存储与 UI 零改动。
import type { AppConfig } from '../../storage/configStore'

/** 任务状态:各服务的原始状态在适配器内归一到这四态 */
export type VideoTaskState = 'queued' | 'running' | 'succeeded' | 'failed'

/** 一次生成的输入。refImage(https/data:URL)= 首帧参考图,支持该能力的服务走图生视频 */
export interface VideoGenRequest {
  prompt: string
  model: string
  refImage?: string
  durationSeconds?: number
  ratio?: string
  resolution?: string
}

/** 适配器凭据:由服务层从配置提取,适配器不直接读配置(与 TtsProvider 同约定) */
export interface VideoGenCredentials {
  apiKey: string
  baseUrl?: string
}

/** 单次查询结果。videoUrl 是服务商的临时下载链接(有时效),成功后应尽快保存本地 */
export interface VideoTaskPoll {
  status: VideoTaskState
  videoUrl?: string
  coverUrl?: string
  failMsg?: string
}

export interface VideoModelPreset {
  id: string
  label: string
  /** 每秒参考单价(元/秒),仅供工坊的费用预估展示;以服务商实际计费为准 */
  pricePerSecond?: number
}

export interface VideoProvider {
  id: string
  label: string
  /** 开通指引(工坊页展示:在哪申请 Key、开哪个模型) */
  setupHint: string
  /** 模型预设(下拉可选,id 也可手改追新模型) */
  models: VideoModelPreset[]
  /** 缺配置时的提示文案;null = 可提交 */
  missingSetup(cfg: AppConfig): string | null
  /** 提交任务,返回服务商侧任务 id;网络/鉴权/参数错误抛 Error(带 status/serverMsg) */
  submit(req: VideoGenRequest, creds: VideoGenCredentials): Promise<string>
  /** 查询一次任务状态(不出结果前 videoUrl 缺省) */
  poll(taskId: string, creds: VideoGenCredentials): Promise<VideoTaskPoll>
}
