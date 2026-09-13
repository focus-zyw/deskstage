// generate_video 工具:视频工坊的模型触发入口(external 级,必须确认)。
// 复用 videoGen 的 Provider 契约(submit/poll)与 videoStore 任务落盘——
// 工坊页照常能看到这条任务并继续轮询/保存,工具只是多一个提交方。
// 费用三道闸:risk=external 的 policy 确认 + 首次费用确认(costConfirmed,
// 与工坊同款,确认一次持久生效)+ 600s 超时;轮询取消即停(任务留在工坊继续可查)。
import {
  credentialsFor,
  describeVideoError,
  modelFor,
  videoProviderById,
} from '../../engine/videoGen'
import { getConfig, saveConfig } from '../../storage/configStore'
import { addVideoTask, updateVideoTask } from '../../storage/videoStore'
import { scoreByRules } from '../candidateGate'
import { validateToolInput, type ToolInputSchema } from '../schema'
import type { CharacterTool, ToolContext, ToolManifest } from '../types'

const inputSchema: ToolInputSchema = {
  properties: {
    prompt: { type: 'string', description: '画面描述(拍什么)', maxLength: 200 },
  },
  required: ['prompt'],
}

const POLL_INTERVAL_MS = 5_000
const POLL_MAX_CONSECUTIVE_ERRORS = 5

const manifest: ToolManifest = {
  id: 'generate_video',
  label: '生成视频',
  description: '用已配置的视频服务生成一段短视频(耗时数分钟,按服务商计费)',
  risk: 'external',
  inputSchema,
  timeoutMs: 600_000,
  defaultEnabled: false,
  match: (text) =>
    scoreByRules(text, [
      { re: /(生成.{0,3}视频|做一?段?个?视频|来一?段?视频|拍一?段?视频|视频生成)/, weight: 1 },
      { re: /(视频)/, weight: 0.45 },
    ]),
  presentation: { actor: 'C', pendingText: '视频要跑几分钟,我盯着进度…', action: 'working' },
}

const sleepAbortable = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = window.setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(t)
        reject(new DOMException('已取消', 'AbortError'))
      },
      { once: true },
    )
  })

export const generateVideoTool: CharacterTool = {
  manifest,
  available: async () => {
    try {
      const cfg = await getConfig()
      const provider = videoProviderById(cfg.videoGen.provider)
      return !!provider && provider.missingSetup(cfg) === null
    } catch {
      return false
    }
  },
  validate: (input) => validateToolInput(inputSchema, input),
  async execute(input, ctx: ToolContext) {
    const v = validateToolInput(inputSchema, input)
    if (!v.ok) return { ok: false, summary: v.reason, errorCode: 'invalid' }
    const prompt = String(v.value.prompt)
    const cfg = await getConfig()
    const provider = videoProviderById(cfg.videoGen.provider)
    if (!provider) return { ok: false, summary: '视频服务配置无效', errorCode: 'no-provider' }
    // 首次费用确认(与视频工坊同款,确认一次持久生效;勾"记住允许"不覆盖这一道)
    if (cfg.videoGen.costConfirmed !== true) {
      const go = await ctx.confirm({
        toolId: manifest.id,
        title: '生成视频',
        detail: `将调用 ${provider.label} 生成视频,按服务商计费。继续吗?`,
      })
      if (!go) return { ok: false, summary: '费用确认未通过,没有生成', errorCode: 'cost-declined' }
      await saveConfig({ videoGen: { ...cfg.videoGen, costConfirmed: true } }).catch(() => {})
    }
    const creds = credentialsFor(cfg, provider.id)
    const model = modelFor(cfg, provider.id)
    ctx.report?.('提交生成任务…')
    let taskId: string
    try {
      taskId = await provider.submit(
        { prompt, model, durationSeconds: cfg.videoGen.durationSeconds, ratio: cfg.videoGen.ratio, resolution: cfg.videoGen.resolution },
        creds,
      )
    } catch (e) {
      return { ok: false, summary: `提交失败:${describeVideoError(e).slice(0, 80)}`, errorCode: 'submit-failed' }
    }
    const localId = `v${Date.now()}${Math.random().toString(36).slice(2, 6)}`
    await addVideoTask({
      id: localId,
      providerId: provider.id,
      model,
      prompt,
      status: 'queued',
      taskId,
      createdAt: Date.now(),
    })
    ctx.report?.('生成中(约 1~5 分钟),进度见视频工坊…')
    let consecutiveErrors = 0
    while (!ctx.signal.aborted) {
      try {
        await sleepAbortable(POLL_INTERVAL_MS, ctx.signal)
        const poll = await provider.poll(taskId, creds)
        consecutiveErrors = 0
        await updateVideoTask(localId, {
          status: poll.status,
          videoUrl: poll.videoUrl,
          coverUrl: poll.coverUrl,
          failMsg: poll.failMsg,
        })
        if (poll.status === 'succeeded') {
          return { ok: true, summary: '视频已生成,到 设置→视频工坊 查看与保存本地', data: poll }
        }
        if (poll.status === 'failed') {
          return {
            ok: false,
            summary: `视频生成失败:${(poll.failMsg ?? '未知原因').slice(0, 80)}`,
            errorCode: 'provider-failed',
          }
        }
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') throw e
        consecutiveErrors += 1
        if (consecutiveErrors >= POLL_MAX_CONSECUTIVE_ERRORS) {
          return {
            ok: false,
            summary: '查询进度连续失败,已停止等待;任务保留在视频工坊可继续查看',
            errorCode: 'poll-failed',
          }
        }
      }
    }
    throw new DOMException('已取消', 'AbortError')
  },
}
