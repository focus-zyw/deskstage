// 海螺视频(MiniMax)适配器:提交 /v1/video_generation,轮询 /v1/query/video_generation。
// 域名 api.minimaxi.com 已在 capabilities 放行(与 MiniMax 语音同域,但 Key 各自独立);
// 画面比例由模型/首帧图决定,不单独传参;时长仅海螺 02 支持二档(6/10 秒),5 秒就近映射 6 秒。
import { requestJson } from './request'
import type { VideoProvider, VideoTaskPoll } from './types'

const DEFAULT_BASE = 'https://api.minimaxi.com'

/** base_resp.status_code 非 0 = 业务错误(鉴权/参数),把 status_msg 带给上层分类展示 */
function assertBaseResp(resp: { base_resp?: { status_code?: number; status_msg?: string } }): void {
  const code = resp.base_resp?.status_code ?? 0
  if (code !== 0) {
    const err = new Error(`MiniMax 业务错误 ${code}`) as Error & { serverMsg?: string }
    err.serverMsg = resp.base_resp?.status_msg
    throw err
  }
}

function mapStatus(s: string): VideoTaskPoll['status'] {
  if (s === 'Success') return 'succeeded'
  if (s === 'Processing') return 'running'
  if (s === 'Queueing') return 'queued'
  return 'failed'
}

export const minimaxProvider: VideoProvider = {
  id: 'minimax',
  label: '海螺视频 · MiniMax',
  setupHint: '在 MiniMax 开放平台申请 API Key(与语音的 Key 相互独立),控制台开通视频生成模型。',
  models: [
    { id: 'MiniMax-Hailuo-02', label: '海螺 02(推荐)', pricePerSecond: 0.6 },
    { id: 'video-01', label: 'video-01', pricePerSecond: 0.5 },
    { id: 'video-01-live', label: 'video-01-live(真人感)', pricePerSecond: 0.5 },
  ],
  missingSetup: (cfg) => (cfg.videoGen.apiKeys.minimax?.trim() ? null : '请先填写 MiniMax API Key'),
  async submit(req, creds) {
    const body: Record<string, unknown> = { model: req.model, prompt: req.prompt.trim() }
    if (req.refImage) body.first_frame_image = req.refImage
    if (req.durationSeconds && req.model.startsWith('MiniMax-Hailuo-02')) {
      body.duration = String(req.durationSeconds >= 8 ? 10 : 6)
    }
    const data = await requestJson<{
      task_id?: string
      base_resp?: { status_code?: number; status_msg?: string }
    }>(
      `${creds.baseUrl?.trim() || DEFAULT_BASE}/v1/video_generation`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.apiKey}` },
        body: JSON.stringify(body),
      },
    )
    assertBaseResp(data)
    if (!data.task_id) throw new Error('响应中缺少任务 id')
    return data.task_id
  },
  async poll(taskId, creds) {
    const data = await requestJson<{
      status?: string
      file?: { download_url?: string; cover_image_url?: string }
      fail_msg?: string
    }>(
      `${creds.baseUrl?.trim() || DEFAULT_BASE}/v1/query/video_generation?task_id=${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${creds.apiKey}` } },
    )
    const s = String(data.status ?? '')
    const status = mapStatus(s)
    return {
      status,
      videoUrl: status === 'succeeded' ? (data.file?.download_url || undefined) : undefined,
      coverUrl: status === 'succeeded' ? (data.file?.cover_image_url || undefined) : undefined,
      failMsg: status === 'failed' ? (data.fail_msg || (s ? `任务状态:${s}` : '任务失败')) : undefined,
    }
  },
}
