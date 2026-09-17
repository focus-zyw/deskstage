// 气泡水平防出屏(docs/气泡防出屏设计方案.md):纯函数,无 DOM。
// 气泡主体恒对中角色(CSS translateX(-50%)),角色贴屏幕左右边缘(或 C 漫游到边)
// 时主体被透明窗裁切——这里计算把主体拉回屏内应加的水平位移(margin-left)。
// 对方式的「主体翻到角色另一侧」不需要:气泡悬在角色上方与立绘不重叠,平移即止。

/** 位移 = 让 [bubbleLeft, bubbleLeft+width] 落回 [pad, viewportW-pad];
 *  已在屏内返回 0;双侧都放不下取正中;退化输入返回 0 */
export function bubbleShiftX(
  bubbleLeft: number,
  bubbleWidth: number,
  viewportW: number,
  pad = 8,
): number {
  const w = Number(bubbleWidth)
  const vw = Number(viewportW)
  if (!Number.isFinite(w) || !Number.isFinite(vw) || w <= 0 || vw <= 0) return 0
  const left = Number(bubbleLeft)
  if (!Number.isFinite(left)) return 0
  const min = pad
  const max = vw - pad
  if (max - min <= 0) return 0
  if (left >= min && left + w <= max) return 0
  if (w >= max - min) return Math.round(min + (max - min - w) / 2 - left)
  if (left < min) return Math.round(min - left)
  return Math.round(max - (left + w))
}
