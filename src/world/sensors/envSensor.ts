// 环境传感器:Rust env_snapshot 的 invoke 封装(世界层的唯一采样入口)。
// 窗口标题属上下文感知:只在 contextSense.windowTitle 开启时向 Rust 请求采集,
// Rust 侧不传就不读——隐私开关的语义是"不采集",不是"采了不渲染"。

import { invoke } from '@tauri-apps/api/core'
import { getConfig } from '../../storage/configStore'
import type { EnvSnapshotRaw } from '../types'

export async function fetchEnvSnapshot(): Promise<EnvSnapshotRaw> {
  let includeTitle = false
  try {
    includeTitle = (await getConfig()).contextSense.windowTitle === true
  } catch {
    // 配置读不到按最隐私档处理:不采标题
  }
  return invoke<EnvSnapshotRaw>('env_snapshot', { options: { includeTitle } })
}
