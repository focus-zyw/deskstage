// 即梦/Seedance 适配器:即梦 App 没有个人直连 API,官方通道是火山方舟的
// 视频生成任务接口(与豆包 LLM 同一个 apiKey;域名已在 capabilities 放行)。
// 提交:POST {base}/contents/generations/tasks —— content 数组:文本 prompt + 可选首帧参考图;
// 时长/比例/分辨率按方舟约定以指令后缀拼进文本(--duration/--ratio/--resolution)。
// 查询:GET {base}/contents/generations/tasks/{id},succeeded 时取 content.video_url。
import { requestJson } from './request'
import type { VideoGenRequest, VideoProvider, VideoTaskPoll } from './types'

const DEFAULT_BASE = 'https://ark.cn-beijing.volces.com/api/v3'

/** 方舟原始状态 → 统一四态(cancelled/expired 等一律按 failed 收场,带原文案) */
function mapStatus(s: string): VideoTaskPoll['status'] {
  if (s === 'succeeded') return 'succeeded'
  if (s === 'running') return 'running'
  if (s === 'queued') return 'queued'
  return 'failed'
}

/** Seedance 1.0 lite 档按文生/图生拆成两个模型 id:按是否带参考图自动换向,
 *  避免"选了文生模型却带了首帧图"被方舟 400 */
function normalizeModel(model: string, hasRefImage: boolean): string {
  if (hasRefImage && model.endsWith('-t2v')) return `${model.slice(0, -4)}-i2v`
  if (!hasRefImage && model.endsWith('-i2v')) return `${model.slice(0, -4)}-t2v`
  return model
}

function buildPromptText(req: VideoGenRequest): string {
  const parts = [req.prompt.trim()]
  if (req.durationSeconds) parts.push(`--duration ${req.durationSeconds}`)
  if (req.ratio) parts.push(`--ratio ${req.ratio}`)
  if (req.resolution) parts.push(`--resolution ${req.resolution}`)
  return parts.join(' ')
}

export const arkProvider: VideoProvider = {
  id: 'ark',
  label: '即梦 · 火山方舟 Seedance',
  setupHint:
    '在火山引擎控制台开通方舟视频生成模型(与豆包 LLM 同一个 API Key);新用户有少量免费试用额度,之后约 0.3~1 元/秒。',
  models: [
    { id: 'doubao-seedance-1-0-lite-t2v', label: 'Seedance 1.0 lite(便宜档)', pricePerSecond: 0.3 },
    { id: 'doubao-seedance-1-0-pro', label: 'Seedance 1.0 pro(质量档)', pricePerSecond: 0.8 },
    { id: 'doubao-seedance-2-0-fast', label: 'Seedance 2.0 fast', pricePerSecond: 0.88 },
    { id: 'doubao-seedance-2-0', label: 'Seedance 2.0(标准)', pricePerSecond: 1 },
  ],
  missingSetup: (cfg) =>
    cfg.videoGen.apiKeys.ark?.trim() ? null : '请先填写火山方舟 API Key(与豆包 LLM 同一个 Key)',
  async submit(req, creds) {
    const model = normalizeModel(req.model, Boolean(req.refImage))
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: buildPromptText(req) }]
    if (req.refImage) content.push({ type: 'image_url', image_url: { url: req.refImage } })
    const data = await requestJson<{ id?: string; task_id?: string }>(
      `${creds.baseUrl?.trim() || DEFAULT_BASE}/contents/generations/tasks`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.apiKey}` },
        body: JSON.stringify({ model, content }),
      },
    )
    const id = data.id ?? data.task_id
    if (!id) throw new Error('响应中缺少任务 id')
    return id
  },
  async poll(taskId, creds) {
    const data = await requestJson<{
      status?: string
      content?: { video_url?: string }
      error?: { message?: string }
    }>(
      `${creds.baseUrl?.trim() || DEFAULT_BASE}/contents/generations/tasks/${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${creds.apiKey}` } },
    )
    const status = mapStatus(String(data.status ?? 'failed'))
    return {
      status,
      videoUrl: status === 'succeeded' ? (data.content?.video_url || undefined) : undefined,
      failMsg:
        status === 'failed'
          ? data.error?.message || (data.status ? `任务状态:${data.status}` : '任务失败')
          : undefined,
    }
  },
}
