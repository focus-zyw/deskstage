// 本地 CosyVoice 预留位:契约就绪,实现待部署方案落地(CosyVoice3 官方宣称双向流式、
// 最低约 150ms 延迟,但依赖独显与本地服务)。选中即报缺配置,UI 侧禁用。
import type { AppConfig } from '../../storage/configStore'
import type { SynthRequest, TtsCredentials, TtsProvider, TtsStream, VoiceOption } from './types'

export const NOT_READY = '本地 CosyVoice 服务暂未接入'

export const localProvider: TtsProvider = {
  id: 'local',
  label: '本地 CosyVoice(未接入)',
  voices: [] as VoiceOption[],
  modelId: (_cfg: AppConfig) => 'cosyvoice3-local',
  missingSetup: (_cfg: AppConfig) => NOT_READY,
  async synthesizeStream(_req: SynthRequest, _creds: TtsCredentials): Promise<TtsStream> {
    throw new Error(NOT_READY)
  },
}
