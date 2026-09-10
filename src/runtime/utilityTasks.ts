// 工具循环的任务状态:用户发起的任务(截图翻译/提取文字…)→ 右上浮层卡反馈。
// 为什么:此前工具反馈散在角色气泡里,与演出互抢、也没有"后台处理中"的载体;
// 卡片负责结果,角色气泡只负责外围吐槽(ui/UtilityCard 渲染)。
import { useSyncExternalStore } from 'react'

export type UtilityKind = 'translate' | 'ocr' | 'capture-translate' | 'live'

export interface UtilityTask {
  id: string
  kind: UtilityKind
  label: string
  status: 'running' | 'done' | 'error'
  detail: string
  error?: string
  ts: number
}

let tasks: UtilityTask[] = []
const listeners = new Set<() => void>()
let seq = 0

function emit(): void {
  listeners.forEach((l) => l())
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function getUtilityTasks(): UtilityTask[] {
  return tasks
}

export function useUtilityTasks(): UtilityTask[] {
  return useSyncExternalStore(subscribe, getUtilityTasks)
}

export function removeTask(id: string): void {
  tasks = tasks.filter((t) => t.id !== id)
  emit()
}

function patch(id: string, p: Partial<UtilityTask>): void {
  tasks = tasks.map((t) => (t.id === id ? { ...t, ...p, ts: Date.now() } : t))
  emit()
}

/** 跑一个工具任务:卡片 running(可随时 report 进度)→ done(6s 后自动消失)/error(手动关)。
 *  exec 抛错 = 任务失败,错误信息原样上卡(已截断) */
export async function runUtilityTask(
  kind: UtilityKind,
  label: string,
  exec: (report: (detail: string) => void) => Promise<string>,
): Promise<void> {
  seq += 1
  const id = `ut-${seq}`
  tasks = [...tasks.slice(-3), { id, kind, label, status: 'running', detail: '处理中…', ts: Date.now() }]
  emit()
  try {
    const detail = await exec((d) => patch(id, { detail: d }))
    patch(id, { status: 'done', detail })
    window.setTimeout(() => removeTask(id), 6000)
  } catch (e) {
    patch(id, { status: 'error', error: String((e as Error)?.message ?? e).slice(0, 100) })
  }
}
