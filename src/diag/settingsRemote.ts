// 诊断跨窗桥 · 设置窗侧:主窗诊断环的镜像。面板打开时拉全量快照,之后收增量;
// 捕获/清空动作经 settings-action 回传主窗。非 Tauri(浏览器原型)回落本地 store。
// 镜像只消费已脱敏的数据——隐私红线在主窗采集层就已经把住,这里无权也无需碰原文。

import { useSyncExternalStore } from 'react'
import { emitTo, listen } from '@tauri-apps/api/event'
import { inTauri } from '../storage/configStore'
import {
  subscribeDiag as subscribeLocal,
  getDiagSnapshot as getLocalSnapshot,
  useDiagSnapshot as useLocalDiag,
  armDetail as armLocal,
  clearDiag as clearLocal,
  getDetailState as getLocalDetail,
  type DetailState,
} from './store'
import type { DiagSession } from './types'

interface MirrorState {
  version: number
  sessions: DiagSession[]
  detail: DetailState
}

let mirror: MirrorState = { version: 0, sessions: [], detail: getLocalDetail() }
const listeners = new Set<() => void>()

function notify(): void {
  listeners.forEach((l) => l())
}

let installed = false
async function install(): Promise<void> {
  if (installed || !inTauri) return
  installed = true
  await listen<{ full?: boolean; sessions?: DiagSession[]; detail?: DetailState }>('diag-upsert', (e) => {
    const p = e.payload
    if (p.detail) mirror = { ...mirror, detail: p.detail }
    if (p.full) {
      mirror = { ...mirror, version: mirror.version + 1, sessions: p.sessions ?? [] }
    } else if (p.sessions) {
      const byId = new Map(mirror.sessions.map((s) => [s.id, s]))
      for (const s of p.sessions) byId.set(s.id, s)
      mirror = { ...mirror, version: mirror.version + 1, sessions: [...byId.values()].sort((a, b) => b.ts - a.ts) }
    }
    notify()
  })
}

/** 面板挂载时调用:确保监听已装好,再拉一次全量(补齐面板关闭期间漏掉的增量) */
export function requestDiagSnapshot(): void {
  if (!inTauri) return
  void install().then(() => emitTo('main', 'diag-snapshot', {}).catch(() => {}))
}

export function armDetailRemote(opts: { once?: boolean; minutes?: number; rawText?: boolean }): void {
  if (!inTauri) {
    armLocal(opts)
    return
  }
  // 本地先行(按钮即时反馈),主窗回执会再对齐一次
  mirror = { ...mirror, detail: { armed: true, mode: opts.minutes ? 'timed' : 'once', rawText: opts.rawText ?? false, untilTs: opts.minutes ? Date.now() + opts.minutes * 60_000 : 0 } }
  notify()
  void emitTo('main', 'diag-arm', opts).catch(() => {})
}

export function disarmDetailRemote(): void {
  if (!inTauri) return
  mirror = { ...mirror, detail: { armed: false, mode: 'off', rawText: false, untilTs: 0 } }
  notify()
  void emitTo('main', 'diag-arm', { disarm: true }).catch(() => {})
}

export function clearDiagRemote(): void {
  if (!inTauri) {
    clearLocal()
    return
  }
  mirror = { ...mirror, version: mirror.version + 1, sessions: [] }
  notify()
  void emitTo('main', 'diag-clear', {}).catch(() => {})
}

export function useDiagMirror(): MirrorState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      void install()
      return () => listeners.delete(l)
    },
    () => mirror,
    () => mirror,
  )
}

/** 面板数据源:Tauri = 主窗镜像;浏览器原型 = 本地环直读。hook 顺序恒定 */
export function useDiagData(): { sessions: DiagSession[]; detail: DetailState } {
  const local = useLocalDiag()
  const remote = useDiagMirror()
  if (!inTauri) return { sessions: local.sessions, detail: getLocalDetail() }
  return { sessions: remote.sessions, detail: remote.detail }
}

export { subscribeLocal, getLocalSnapshot, useLocalDiag, getLocalDetail }
