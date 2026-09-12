// 智谱清影(CogVideoX)适配器:POST /api/paas/v4/videos/generations 创建任务,
// GET /api/paas/v4/videos/generations/{id} 轮询,成功后取 video_result[0].url。
// 与智谱 LLM 同域(open.bigmodel.cn 已放行),Key 独立管理;cogvideox-3 起支持音频与 10 秒时长。
import { requestJson } from './request'
import type { VideoProvider, VideoTaskPoll } from './types'

const DEFAULT_BASE = 'https://open.bigmodel.cn/api/paas/v4'

function mapStatus(s: string): VideoTaskPoll['status'] {
  if (s === 'SUCCESS') return 'succeeded'
  if (s === 'PROCESSING') return 'running'
  if (s === 'NOT_START') return 'queued'
  return 'failed'
}

export const zhipuProvider: VideoProvider = {
  id: 'zhipu',
  label: '清影 · 智谱 CogVideoX',
  setupHint: '在智谱开放平台(bigmodel.cn)申请 API Key,控制台开通视频生成模型。',
  models: [
    { id: 'cogvideox-3', label: 'CogVideoX-3(含音频)', pricePerSecond: 0.2 },
    { id: 'cogvideox-2', label: 'CogVideoX-2', pricePerSecond: 0.15 },
  ],
  missingSetup: (cfg) => (cfg.videoGen.apiKeys.zhipu?.trim() ? null : '请先填写智谱 API Key'),
  async submit(req, creds) {
    const body: Record<string, unknown> = { model: req.model, prompt: req.prompt.trim() }
    if (req.refImage) body.image_url = req.refImage
    if (req.durationSeconds) body.duration = req.durationSeconds >= 8 ? 10 : 5
    // 音频生成是 cogvideox-3 起的新能力,老模型传了会被 400
    if (req.model.startsWith('cogvideox-3')) body.with_audio = true
    const data = await requestJson<{ id?: string }>(
      `${creds.baseUrl?.trim() || DEFAULT_BASE}/videos/generations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.apiKey}` },
        body: JSON.stringify(body),
      },
    )
    if (!data.id) throw new Error('响应中缺少任务 id')
    return data.id
  },
  async poll(taskId, creds) {
    const data = await requestJson<{
      task_status?: string
      video_result?: Array<{ url?: string; cover_image_url?: string }>
    }>(
      `${creds.baseUrl?.trim() || DEFAULT_BASE}/videos/generations/${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${creds.apiKey}` } },
    )
    const s = String(data.task_status ?? '')
    const status = mapStatus(s)
    const result = data.video_result?.[0]
    return {
      status,
      videoUrl: status === 'succeeded' ? (result?.url || undefined) : undefined,
      coverUrl: status === 'succeeded' ? (result?.cover_image_url || undefined) : undefined,
      failMsg: status === 'failed' ? (s ? `任务状态:${s}` : '任务失败') : undefined,
    }
  },
}
