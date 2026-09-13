// 程序化全屏截屏链(适配器内部件,非注册工具):
// capture_screen 冻结主屏 → capture_finish 全屏裁剪进剪贴板 → 清理。
// 为什么不走 startScreenshot:那是框选 UI 流程,依赖用户拖框;工具是角色/模型触发,
// 没有这一步,直接按全屏物理像素裁剪(crop_imm 越界自动收口,取整误差无害)。
// 角色排除与 capture.ts 同款:hideSelf 关闭(WDA 排除关)时主窗隐藏 260ms 兜底。
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getConfig } from '../../storage/configStore'

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms))

/** 全屏截进剪贴板。失败时清理冻结图并恢复主窗,异常原样上抛由协调器落账 */
export async function captureFullScreenToClipboard(report?: (s: string) => void): Promise<void> {
  const main = getCurrentWindow()
  let hidden = false
  try {
    const cfg = await getConfig()
    if (!cfg.screenshot.hideSelf) {
      await main.hide()
      hidden = true
      await sleep(260) // 等 DWM 合成完,避免拍到收起瞬间的残影
    }
    report?.('截取屏幕中…')
    await invoke<string>('capture_screen')
    // 主屏物理像素 = CSS 尺寸 × 缩放(多显示器下以主窗所在屏为准,桌面挂件场景即主屏)
    const dpr = window.devicePixelRatio || 1
    const width = Math.max(1, Math.round(window.screen.width * dpr))
    const height = Math.max(1, Math.round(window.screen.height * dpr))
    await invoke('capture_finish', { x: 0, y: 0, width, height })
  } catch (e) {
    // 冻结图是全局单份:失败也要清,否则下一次框选会拿到这张旧图
    await invoke('capture_cleanup').catch(() => {})
    throw e
  } finally {
    if (hidden) await main.show().catch(() => {})
  }
}
