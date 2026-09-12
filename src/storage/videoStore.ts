// 视频工坊任务存储:appData/data/videos.json。任务跨会话留存——提交后关掉设置/重启应用,
// 重新打开工坊时按 taskId 继续查询(平台侧任务仍在跑);结果链接有时效,提示尽快保存本地。
// 参考图(data URL 可达数 MB)不落盘:提交瞬间用完即弃,只记来源描述供展示。
// 上限 50 条(新的顶掉旧的);坏数据拒收不静默修。浏览器预览降级 localStorage,与 configStore 同约定。
import { useSyncExternalStore } from 'react'
import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import { withFileLock } from './writeLock'
import { inTauri } from './configStore'
import type { VideoTaskState } from '../engine/videoGen/types'

const LS_KEY = 'vc-video-tasks'
const FILE_NAME = 'videos.json'

/** 任务数量上限:视频 prompt + 状态都是小文本,50 条足够回看,防文件膨胀 */
export const VIDEO_TASK_LIMIT = 50

export interface VideoTask {
  id: string
  providerId: string
  model: string
  prompt: string
  /** 参考图来源描述(展示用):'sprite:a/happy' | 'custom';本体 data URL 不落盘 */
  refImageSource?: string
  status: VideoTaskState
  /** 服务商侧任务 id(轮询凭据) */
  taskId: string
  videoUrl?: string
  coverUrl?: string
  /** 已保存到本地的路径(保存成功后回填) */
  localPath?: string
  failMsg?: string
  createdAt: number
}

const STATES = new Set(['queued', 'running', 'succeeded', 'failed'])

/** 校验并清洗一条任务:关键字段缺失返回 null(坏数据宁可拒收) */
export function sanitizeVideoTask(raw: unknown): VideoTask | null {
  const o = (raw ?? {}) as Record<string, unknown>
  const id = typeof o.id === 'string' ? o.id.trim().slice(0, 48) : ''
  const providerId = typeof o.providerId === 'string' ? o.providerId.trim().slice(0, 24) : ''
  const taskId = typeof o.taskId === 'string' ? o.taskId.trim().slice(0, 80) : ''
  const status = STATES.has(String(o.status)) ? (o.status as VideoTaskState) : 'failed'
  if (!id || !providerId) return null
  // 未完成任务必须带 taskId 才有续查价值,否则是死记录(链接也早过期),拒收
  if ((status === 'queued' || status === 'running') && !taskId) return null
  const str = (v: unknown, cap: number): string | undefined => {
    const s = typeof v === 'string' ? v.trim().slice(0, cap) : ''
    return s || undefined
  }
  return {
    id,
    providerId,
    taskId,
    status,
    model: str(o.model, 100) ?? '',
    prompt: str(o.prompt, 800) ?? '',
    refImageSource: str(o.refImageSource, 60),
    videoUrl: str(o.videoUrl, 2000),
    coverUrl: str(o.coverUrl, 2000),
    localPath: str(o.localPath, 500),
    failMsg: str(o.failMsg, 200),
    createdAt: Number(o.createdAt) || Date.now(),
  }
}

/** 清洗整份存储:逐条校验、按 id 去重、限量、按创建时间倒序(文件手改坏数据不拖垮工坊) */
export function sanitizeVideoTasks(raw: unknown): VideoTask[] {
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { tasks?: unknown } | null)?.tasks)
      ? (raw as { tasks: unknown[] }).tasks
      : []
  const out: VideoTask[] = []
  const seen = new Set<string>()
  for (const item of arr) {
    const task = sanitizeVideoTask(item)
    if (task && !seen.has(task.id)) {
      seen.add(task.id)
      out.push(task)
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, VIDEO_TASK_LIMIT)
}

// ---------- 存取:文件(localStorage)+ 内存快照 + 订阅,三件套同 configStore ----------

let snapshot: VideoTask[] = []
const listeners = new Set<() => void>()

function publish(next: VideoTask[]): void {
  snapshot = next
  listeners.forEach((l) => l())
}

/** 同步读当前快照(非 React 侧用) */
export function getVideoTasksSnapshot(): VideoTask[] {
  return snapshot
}

/** 订阅任务列表变化;首次订阅触发一次异步加载(磁盘晚于订阅者时补发通知) */
export function subscribeVideoTasks(l: () => void): () => void {
  listeners.add(l)
  void ensureVideoTasksLoaded()
  return () => {
    listeners.delete(l)
  }
}

/** React 侧读取:任务列表(增删改触发重渲染)。
 *  第三参 getServerSnapshot:快照是模块级缓存值,SSR(renderToStaticMarkup 测试)下同值可用 */
export function useVideoTasks(): VideoTask[] {
  return useSyncExternalStore(subscribeVideoTasks, getVideoTasksSnapshot, getVideoTasksSnapshot)
}

let loaded = false

async function writeTasks(tasks: VideoTask[]): Promise<void> {
  if (!inTauri) {
    localStorage.setItem(LS_KEY, JSON.stringify({ version: 1, tasks }))
    return
  }
  const base = await appDataDir()
  const dir = await join(base, 'data')
  if (!(await exists(dir))) await mkdir(dir, { recursive: true })
  const file = await join(dir, FILE_NAME)
  await writeTextFile(file, JSON.stringify({ version: 1, tasks }, null, 2))
}

export async function ensureVideoTasksLoaded(): Promise<void> {
  if (loaded) return
  loaded = true
  const next = await withFileLock('videos', async () => {
    if (!inTauri) {
      try {
        const raw = localStorage.getItem(LS_KEY)
        return raw ? sanitizeVideoTasks(JSON.parse(raw)) : []
      } catch (e) {
        console.warn('视频任务读取失败,按空处理', e)
        return []
      }
    }
    try {
      const base = await appDataDir()
      const dir = await join(base, 'data')
      if (!(await exists(dir))) await mkdir(dir, { recursive: true })
      const file = await join(dir, FILE_NAME)
      if (await exists(file)) return sanitizeVideoTasks(JSON.parse(await readTextFile(file)))
      await writeTasks([])
    } catch (e) {
      console.warn('视频任务读取失败,按空处理', e)
    }
    return []
  })
  publish(next)
}

/** 新增一条任务(置于队首);超限挤掉最旧的已完成任务 */
export async function addVideoTask(task: VideoTask): Promise<VideoTask[]> {
  const clean = sanitizeVideoTask(task)
  if (!clean) throw new Error('任务数据不合法')
  const next = await withFileLock('videos', async () => {
    const merged = [clean, ...snapshot.filter((t) => t.id !== clean.id)]
    while (merged.length > VIDEO_TASK_LIMIT) {
      const idx = merged.map((t) => t.status).lastIndexOf('succeeded')
      if (idx === -1) {
        merged.pop()
      } else {
        merged.splice(idx, 1)
      }
    }
    await writeTasks(merged)
    return merged
  })
  publish(next)
  return next
}

/** 更新一条任务(轮询结果回写/保存本地路径回填);id 不存在时静默(任务可能已被删) */
export async function updateVideoTask(id: string, patch: Partial<Omit<VideoTask, 'id'>>): Promise<VideoTask[]> {
  const next = await withFileLock('videos', async () => {
    const merged = snapshot.map((t) => (t.id === id ? (sanitizeVideoTask({ ...t, ...patch }) ?? t) : t))
    await writeTasks(merged)
    return merged
  })
  publish(next)
  return next
}

/** 删除一条任务;id 不存在时静默(幂等) */
export async function removeVideoTask(id: string): Promise<VideoTask[]> {
  const next = await withFileLock('videos', async () => {
    const merged = snapshot.filter((t) => t.id !== id)
    await writeTasks(merged)
    return merged
  })
  publish(next)
  return next
}
