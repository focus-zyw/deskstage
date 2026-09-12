// 视频生成供应商注册表 + 凭据/模型解析 + 错误分类。
// UI 与工坊只认这里的导出,不直接 import 具体适配器;新增供应商在 VIDEO_PROVIDERS 加一项即可。
import type { AppConfig } from '../../storage/configStore'
import { arkProvider } from './ark'
import { minimaxProvider } from './minimax'
import { zhipuProvider } from './zhipu'
import type { VideoGenCredentials, VideoProvider } from './types'

export type {
  VideoGenCredentials,
  VideoGenRequest,
  VideoModelPreset,
  VideoProvider,
  VideoTaskPoll,
  VideoTaskState,
} from './types'

export const VIDEO_PROVIDERS: VideoProvider[] = [arkProvider, minimaxProvider, zhipuProvider]

export function videoProviderById(id: string): VideoProvider | undefined {
  return VIDEO_PROVIDERS.find((p) => p.id === id)
}

/** 从配置提取凭据:Key 缺失返回空串,由 missingSetup / 错误分类兜底 */
export function credentialsFor(cfg: AppConfig, providerId: string): VideoGenCredentials {
  return { apiKey: cfg.videoGen.apiKeys[providerId]?.trim() ?? '' }
}

/** 生效模型:优先用户手改的覆盖值,缺省用预设第一档(全部是便宜档优先的排序) */
export function modelFor(cfg: AppConfig, providerId: string): string {
  return cfg.videoGen.models[providerId]?.trim() || videoProviderById(providerId)?.models[0]?.id || ''
}

/** 请求错误 → 用户可读文案(对齐 describeLlmError 的粒度) */
export function describeVideoError(e: unknown): string {
  const err = e as (Error & { status?: number; serverMsg?: string }) | null
  const raw = String(err?.serverMsg ?? err?.message ?? e)
  // 余额判断先于鉴权:方舟等对欠费也常回 401/403,错误说明里才写明额度问题
  if (err?.status === 402 || /balance|quota|arrears|欠费/i.test(raw)) {
    return '账户余额不足或免费额度已用完'
  }
  if (err?.status === 401 || err?.status === 403 || /invalid api key|unauthorized|authenticate/i.test(raw)) {
    return 'API Key 无效或无权限,请检查工坊页的 Key 配置'
  }
  if (err?.status === 404 || /model.*(not exist|not found|not open|not supported)|ModelNotOpen/i.test(raw)) {
    return '模型不存在或未开通:请在服务商控制台开通后重试'
  }
  if (err?.status === 429 || /rate limit|too many requests|throttl/i.test(raw)) {
    return '触发限流,请稍等片刻再试'
  }
  return `生成失败:${raw.slice(0, 120)}`
}
