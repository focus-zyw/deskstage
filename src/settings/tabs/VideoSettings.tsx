// 视频工坊:接入即梦(火山方舟 Seedance)/海螺 MiniMax/智谱清影,把创意或最近一段演出
// 变成 AI 短视频。剧本零改动(轻适配):「从最近演出生成」由 promptComposer 把台词+场景卡
// 转译成画面 prompt,可编辑后再提交。
// 任务跨会话:提交即落盘 videoStore,轮询在本页挂载期间进行(5s 一轮),关掉再开自动续查;
// 平台结果链接有时效,完成后尽快「保存到本地」。
// 按条计费:提交前展示参考价,首次生成需确认一次(之后不再弹)。
import { useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { useSettings } from '../useSettingsSession'
import { SettingsCard, SetField, SetLine } from '../SettingsPrimitives'
import { getConfigSnapshot, type VideoGenConfig } from '../../storage/configStore'
import { nameOf } from '../../engine/persona'
import { listEpisodes } from '../../storage/historyStore'
import { modeOf } from '../../performer/modes'
import { fmtTime } from '../format'
import { SPRITE_SETS, spriteSrc } from '../../stage/spriteSets'
import {
  addVideoTask,
  removeVideoTask,
  updateVideoTask,
  useVideoTasks,
  type VideoTask,
} from '../../storage/videoStore'
import {
  VIDEO_PROVIDERS,
  credentialsFor,
  describeVideoError,
  modelFor,
  videoProviderById,
} from '../../engine/videoGen'
import { composeVideoPrompt } from '../../engine/videoGen/promptComposer'

type RefKind = 'none' | 'A' | 'B' | 'custom'

interface RefState {
  kind: RefKind
  /** sprite 模式选中的立绘动作 */
  action: string
  fileName?: string
  dataUrl?: string
}

const REF_LABEL: Record<RefKind, string> = { none: '不参考', A: '甲立绘', B: '乙立绘', custom: '自定义图' }

const STATUS_LABEL: Record<VideoTask['status'], string> = {
  queued: '排队中',
  running: '生成中',
  succeeded: '已完成',
  failed: '失败',
}

/** 提交后 1~5 分钟出片,5s 一轮查询足够跟进度 */
const POLL_INTERVAL_MS = 5000
/** 连续查询失败达到该次数按失败收场(401 之类的永久错误不能空转) */
const POLL_FAIL_LIMIT = 5

async function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result))
    fr.onerror = () => reject(new Error('读取图片数据失败'))
    fr.readAsDataURL(blob)
  })
}

/** 立绘 PNG → data URL(同源静态资源,fetch 即得) */
async function loadSpriteDataUrl(slot: 'A' | 'B', action: string): Promise<string> {
  const res = await fetch(spriteSrc(SPRITE_SETS[slot], action))
  if (!res.ok) throw new Error(`读取立绘失败 HTTP ${res.status}`)
  return toDataUrl(await res.blob())
}

export function VideoSettings() {
  const { form, setForm, saveField, flashCard, videoSource, setVideoSource } = useSettings()
  const vg = form.videoGen
  const tasks = useVideoTasks()

  const [brief, setBrief] = useState('')
  const [prompt, setPrompt] = useState('')
  const [ref, setRef] = useState<RefState>({ kind: 'none', action: 'idle' })
  const [busy, setBusy] = useState<'compose' | 'submit' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [needCostConfirm, setNeedCostConfirm] = useState(false)
  const [armedDelete, setArmedDelete] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)
  const disarmTimer = useRef(0)
  const pollFails = useRef(new Map<string, number>())

  const provider = videoProviderById(vg.provider)
  const model = modelFor(form, vg.provider)
  const cost = useMemo(() => {
    const preset = provider?.models.find((m) => m.id === model)
    return preset?.pricePerSecond != null ? preset.pricePerSecond * vg.durationSeconds : null
  }, [provider, model, vg.durationSeconds])

  /** 改视频工坊配置:对象字段整体落盘(与 ocr/voice 的编辑同套路) */
  function patchVideoGen(p: Partial<VideoGenConfig>, immediate = false) {
    const next = { ...form.videoGen, ...p }
    setForm({ ...form, videoGen: next })
    saveField({ videoGen: next }, immediate)
  }

  // 轮询未完成任务:每 5s 查一次;页面关闭即停,状态已落盘,重开工坊自动续查。
  // 查询抖动不改任务状态,只累计失败,连续 POLL_FAIL_LIMIT 次才判死
  useEffect(() => {
    const pending = tasks.filter((t) => t.status === 'queued' || t.status === 'running')
    if (pending.length === 0) return
    const inflight = new Set<string>()
    const timer = window.setInterval(() => {
      const cfg = getConfigSnapshot()
      for (const t of pending) {
        if (inflight.has(t.id)) continue
        const p = videoProviderById(t.providerId)
        if (!p) continue
        inflight.add(t.id)
        void p
          .poll(t.taskId, credentialsFor(cfg, t.providerId))
          .then(async (r) => {
            pollFails.current.delete(t.id)
            const patch: Partial<VideoTask> = { status: r.status }
            if (r.videoUrl) patch.videoUrl = r.videoUrl
            if (r.coverUrl) patch.coverUrl = r.coverUrl
            if (r.failMsg) patch.failMsg = r.failMsg
            await updateVideoTask(t.id, patch)
          })
          .catch(async (e) => {
            const n = (pollFails.current.get(t.id) ?? 0) + 1
            pollFails.current.set(t.id, n)
            if (n >= POLL_FAIL_LIMIT) {
              pollFails.current.delete(t.id)
              await updateVideoTask(t.id, {
                status: 'failed',
                failMsg: `查询失败:${String((e as Error)?.message ?? e).slice(0, 80)}`,
              })
            }
          })
          .finally(() => inflight.delete(t.id))
      }
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [tasks])

  /** 剧本轻适配:把素材来源(收藏页导入的一集,否则最近一集)的台词+场景卡转译成画面描述 */
  async function onCompose() {
    setBusy('compose')
    setError(null)
    setNote(null)
    try {
      const ep = videoSource ?? ((await listEpisodes(1))[0] ?? null)
      // 5 秒视频只容 1 句口播,10 秒容 2 句
      const r = await composeVideoPrompt({
        episode: ep,
        brief,
        maxSpokenLines: vg.durationSeconds >= 8 ? 2 : 1,
      })
      setPrompt(r.prompt)
      setNote(
        r.usedFallback
          ? `AI 转译失败(${r.error ?? '未知'}),已用本地模板拼装,可手动改`
          : `已按${ep ? (videoSource ? '选中收藏' : '最近一段演出') : '你的补充'}生成画面描述,可再手动修改`,
      )
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setBusy(null)
    }
  }

  /** 提交前拦截:服务/Key/画面描述齐活,首次还要过费用确认 */
  function requestSubmit() {
    setError(null)
    const missing = provider?.missingSetup(form)
    if (missing) {
      setError(missing)
      return
    }
    if (!prompt.trim()) {
      setError('画面描述不能为空:点「从最近演出生成」或直接手写')
      return
    }
    if (!model.trim()) {
      setError('请填写模型 id')
      return
    }
    if (!vg.costConfirmed) {
      setNeedCostConfirm(true)
      return
    }
    void doSubmit()
  }

  async function doSubmit() {
    setNeedCostConfirm(false)
    setBusy('submit')
    setError(null)
    try {
      let refImage: string | undefined
      let refSource: string | undefined
      if (ref.kind === 'A' || ref.kind === 'B') {
        refImage = await loadSpriteDataUrl(ref.kind, ref.action)
        refSource = `sprite:${ref.kind.toLowerCase()}/${ref.action}`
      } else if (ref.kind === 'custom' && ref.dataUrl) {
        refImage = ref.dataUrl
        refSource = 'custom'
      }
      const p = videoProviderById(vg.provider)!
      const taskId = await p.submit(
        {
          prompt: prompt.trim(),
          model: model.trim(),
          refImage,
          durationSeconds: vg.durationSeconds,
          ratio: vg.ratio,
          resolution: vg.resolution,
        },
        credentialsFor(form, p.id),
      )
      await addVideoTask({
        id: `v${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
        providerId: p.id,
        model: model.trim(),
        prompt: prompt.trim(),
        refImageSource: refSource,
        status: 'queued',
        taskId,
        createdAt: Date.now(),
      })
      setNote('已提交,生成约需 1~5 分钟,下方列表会自动刷新进度')
    } catch (e) {
      setError(describeVideoError(e))
    } finally {
      setBusy(null)
    }
  }

  /** 结果链接有时效:另存为本地文件(下载走 Rust 侧,CDN 域不在 http 放行清单) */
  async function onSaveLocal(t: VideoTask) {
    if (!t.videoUrl) return
    const path = await save({
      defaultPath: `virtual-character-video-${t.id}.mp4`,
      filters: [{ name: '视频文件', extensions: ['mp4'] }],
    })
    if (!path) return
    setSavingId(t.id)
    setError(null)
    try {
      await invoke('video_save_from_url', { url: t.videoUrl, path })
      await updateVideoTask(t.id, { localPath: path })
      setNote(`已保存:${path}`)
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setSavingId(null)
    }
  }

  function onDelete(id: string) {
    if (armedDelete !== id) {
      // 两段确认:第一次点亮,3 秒内再点才真删(与气泡工坊同一交互)
      setArmedDelete(id)
      window.clearTimeout(disarmTimer.current)
      disarmTimer.current = window.setTimeout(() => setArmedDelete(null), 3000)
      return
    }
    window.clearTimeout(disarmTimer.current)
    setArmedDelete(null)
    void removeVideoTask(id)
    setNote('已删除')
  }

  function onPickFile(file: File | null) {
    if (!file) {
      setRef((r) => ({ ...r, fileName: undefined, dataUrl: undefined }))
      return
    }
    if (file.size > 8 * 1024 * 1024) {
      setError('图片超过 8MB,请压缩后再上传')
      return
    }
    void toDataUrl(file)
      .then((dataUrl) => setRef((r) => ({ ...r, fileName: file.name, dataUrl })))
      .catch((e) => setError(String((e as Error)?.message ?? e)))
  }

  return (
    <>
      <SettingsCard card="视频服务" flash={flashCard} title="视频服务" desc="AI 短视频:费用由你填的 API Key 账户承担">
        {/* 服务商按钮组名字长,横排 SetLine 会把左侧文案挤成竖排——用竖排字段独占整行 */}
        <SetField label="服务商" htmlFor="cfg-video-provider" hint={provider?.setupHint}>
          <div className="seg-group" id="cfg-video-provider">
            {VIDEO_PROVIDERS.map((p) => (
              <button
                key={p.id}
                className={`seg-btn${vg.provider === p.id ? ' on' : ''}`}
                onClick={() => patchVideoGen({ provider: p.id as VideoGenConfig['provider'] }, true)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </SetField>
        <SetField label="API Key" htmlFor="cfg-video-key" hint="仅保存在本机;各服务 Key 相互独立">
          <input
            id="cfg-video-key"
            type="password"
            value={vg.apiKeys[vg.provider] ?? ''}
            onChange={(e) => patchVideoGen({ apiKeys: { ...vg.apiKeys, [vg.provider]: e.target.value } })}
            onBlur={() => saveField({}, true)}
          />
        </SetField>
        <SetField label="模型" htmlFor="cfg-video-model" hint="下拉选预设,或直接手填新模型 id">
          <input
            id="cfg-video-model"
            list="video-model-presets"
            value={model}
            onChange={(e) => patchVideoGen({ models: { ...vg.models, [vg.provider]: e.target.value } })}
          />
          <datalist id="video-model-presets">
            {(provider?.models ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </datalist>
        </SetField>
      </SettingsCard>

      <SettingsCard card="画面参数" flash={flashCard} title="画面参数" desc="比例/分辨率以所选服务实际支持为准">
        <SetLine title="单条时长">
          <div className="seg-group">
            {[5, 10].map((d) => (
              <button
                key={d}
                className={`seg-btn${vg.durationSeconds === d ? ' on' : ''}`}
                onClick={() => patchVideoGen({ durationSeconds: d }, true)}
              >
                {d} 秒
              </button>
            ))}
          </div>
        </SetLine>
        <SetLine title="画面比例">
          <select
            value={vg.ratio}
            onChange={(e) => patchVideoGen({ ratio: e.target.value as VideoGenConfig['ratio'] }, true)}
          >
            <option value="16:9">16:9(横屏)</option>
            <option value="9:16">9:16(竖屏)</option>
            <option value="1:1">1:1(方形)</option>
            <option value="4:3">4:3</option>
            <option value="3:4">3:4</option>
          </select>
        </SetLine>
        <SetLine title="分辨率">
          <select
            value={vg.resolution}
            onChange={(e) => patchVideoGen({ resolution: e.target.value as VideoGenConfig['resolution'] }, true)}
          >
            <option value="480p">480p(省费用)</option>
            <option value="720p">720p(推荐)</option>
            <option value="1080p">1080p(高质量)</option>
          </select>
        </SetLine>
        <SetLine title="预估费用" hint="参考单价×时长,以服务商实际计费为准">
          <span className="set-hint">{cost != null ? `约 ¥${cost.toFixed(2)} / 条` : '以服务商定价为准'}</span>
        </SetLine>
      </SettingsCard>

      <SettingsCard card="生成视频" flash={flashCard} title="生成视频" desc="剧本不动:由 AI 把台词+场景卡转译成画面描述">
        {videoSource && (
          <SetLine title="素材来源" hint="由收藏页导入;清除后转译改用最近一集">
            <div className="shot-key-row">
              <span className="video-task-meta">
                收藏 · {modeOf(videoSource.mode).label} · {fmtTime(videoSource.ts)} · {videoSource.lines.length} 句
              </span>
              <button className="panel-btn" onClick={() => setVideoSource(null)}>
                改用最近一集
              </button>
            </div>
          </SetLine>
        )}
        <SetField label="创意补充(可空)" htmlFor="cfg-video-brief" hint="想加的方向,如:夜晚便利店门口,雨中对话">
          <textarea
            id="cfg-video-brief"
            rows={2}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="不填则完全按最近的演出转译"
          />
        </SetField>
        <div className="shot-key-row">
          <button className="panel-btn" disabled={busy !== null} onClick={() => void onCompose()}>
            {busy === 'compose' ? '转译中…' : videoSource ? '从选中收藏生成画面描述' : '从最近演出生成画面描述'}
          </button>
        </div>
        <SetField
          label="画面描述(提交给视频模型)"
          htmlFor="cfg-video-prompt"
          hint="描述场景/人物/动作/镜头;结尾自动附对白原文,支持配音的模型(Seedance 2.0/CogVideoX-3)会让角色开口说"
        >
          <textarea
            id="cfg-video-prompt"
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="直接手写,或点上面的按钮按最近一段演出生成"
          />
        </SetField>
        <SetLine title="参考图" hint="带上立绘走图生视频,角色更一致;C 是视频角色不参与">
          <div className="seg-group">
            {(['none', 'A', 'B', 'custom'] as const).map((k) => (
              <button
                key={k}
                className={`seg-btn${ref.kind === k ? ' on' : ''}`}
                onClick={() => setRef((r) => ({ ...r, kind: k }))}
              >
                {k === 'A' ? `${nameOf('A')}立绘` : k === 'B' ? `${nameOf('B')}立绘` : REF_LABEL[k]}
              </button>
            ))}
          </div>
        </SetLine>
        {(ref.kind === 'A' || ref.kind === 'B') && (
          <SetLine title="立绘动作" hint="作为视频首帧的姿态">
            <select value={ref.action} onChange={(e) => setRef((r) => ({ ...r, action: e.target.value }))}>
              {/* shake/jump 是 CSS 复合动画没有独立贴图,不能当首帧 */}
              {SPRITE_SETS[ref.kind].actions
                .filter((a) => a !== 'shake' && a !== 'jump')
                .map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
            </select>
          </SetLine>
        )}
        {ref.kind === 'custom' && (
          <SetLine title="上传图片" hint="作为视频首帧;建议与所选比例接近">
            <input type="file" accept="image/*" onChange={(e) => onPickFile(e.target.files?.[0] ?? null)} />
            {ref.fileName && <span className="set-hint">已选:{ref.fileName}</span>}
          </SetLine>
        )}
        <div className="shot-key-row">
          <button className="panel-btn primary" disabled={busy !== null || !prompt.trim()} onClick={requestSubmit}>
            {busy === 'submit' ? '提交中…' : cost != null ? `生成视频(约 ¥${cost.toFixed(2)})` : '生成视频'}
          </button>
        </div>
        {needCostConfirm && (
          <div className="set-note">
            ⚠ 首次生成:将按服务商定价从你的 API Key 账户扣费{cost != null ? `(本条约 ¥${cost.toFixed(2)})` : ''}。
            <button
              className="panel-btn"
              disabled={busy !== null}
              onClick={() => {
                patchVideoGen({ costConfirmed: true }, true)
                void doSubmit()
              }}
            >
              确认并生成
            </button>
            <button className="panel-btn" onClick={() => setNeedCostConfirm(false)}>
              取消
            </button>
          </div>
        )}
      </SettingsCard>

      {(error || note) && <div className="set-note">{error ? `⚠ ${error}` : note}</div>}

      <SettingsCard
        card="任务列表"
        flash={flashCard}
        title={`任务列表(${tasks.length})`}
        desc="关闭设置后任务继续在服务商侧生成;结果链接有时效,完成后尽快保存本地"
      >
        {tasks.length === 0 ? (
          <div className="set-note">还没有生成任务。</div>
        ) : (
          tasks.map((t) => (
            <div key={t.id} className="video-task">
              <div className="video-task-head">
                <span className={`video-status st-${t.status}`}>{STATUS_LABEL[t.status]}</span>
                <span className="video-task-meta">
                  {t.model}
                  {t.refImageSource ? ' · 带参考图' : ''} · {new Date(t.createdAt).toLocaleString()}
                </span>
              </div>
              <div className="video-task-prompt">{t.prompt}</div>
              {t.status === 'succeeded' && t.videoUrl && (
                <video className="video-preview" src={t.videoUrl} controls preload="metadata" />
              )}
              {t.status === 'succeeded' && !t.videoUrl && !t.localPath && (
                <div className="set-note">结果链接已过期或缺失,请重新生成</div>
              )}
              {t.status === 'failed' && t.failMsg && <div className="set-note">⚠ {t.failMsg}</div>}
              <div className="shot-key-row">
                {t.videoUrl && (
                  <button className="panel-btn" disabled={savingId === t.id} onClick={() => void onSaveLocal(t)}>
                    {savingId === t.id ? '保存中…' : '保存到本地'}
                  </button>
                )}
                {t.localPath && (
                  <>
                    <button
                      className="panel-btn"
                      onClick={() => void invoke('reveal_in_explorer', { path: t.localPath }).catch(() => {})}
                    >
                      打开所在位置
                    </button>
                    <span className="video-task-meta">已保存:{t.localPath}</span>
                  </>
                )}
                <button className="panel-btn" onClick={() => onDelete(t.id)}>
                  {armedDelete === t.id ? '再点确认删除' : '删除'}
                </button>
              </div>
            </div>
          ))
        )}
      </SettingsCard>
    </>
  )
}
