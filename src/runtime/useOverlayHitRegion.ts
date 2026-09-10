// 面板命中区统一注册:穿透窗口里"面板可见但点不到"的反面——面板打开期间把其矩形
// 注册为可命中热区,并保证"点外部收起"所需的全屏兜底热区排在最后。
// hitTest 按 Map 插入序先命中(regions 数组顺序即优先级):小而具体的热区在前,
// 全屏兜底在后;面板间本就互斥(openOverlayExclusive),固定序只影响与抉择面板
// 同时可见的罕见重叠——抉择面板排最前(观众投票是即时动作,优先可点)。
import { useEffect } from 'react'
import { registerHitRegion } from '../input/pointerManager'

export interface OverlayRegionSpec {
  id: string
  /** true 时注册,false 时注销 */
  active: boolean
  getRect: () => DOMRect
}

export function useOverlayHitRegions(specs: OverlayRegionSpec[]): void {
  // specs 由调用方 useMemo(仅面板开关变化时重建);数组内容变了才重登记
  useEffect(() => {
    const unsubs = specs
      .filter((s) => s.active)
      .map((s) => registerHitRegion(s.id, { getRect: s.getRect }))
    return () => unsubs.forEach((u) => u())
    // specs 每次面板开合都换新引用;其余渲染复用 useMemo 缓存,不需要逐项比较
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specs])
}
