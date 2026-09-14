// 诊断公共接口:配色问题的检查与自动修复(修复带说明,不静默改色)。
import { autoFixPalette, deriveEffectivePalette, diagnosePalette } from './palette'
import type { BubbleDiagnostic, BubbleThemeV2 } from './types'

export function diagnoseBubbleTheme(theme: BubbleThemeV2): BubbleDiagnostic[] {
  return diagnosePalette(theme)
}

export function autoFixBubbleTheme(theme: BubbleThemeV2): {
  theme: BubbleThemeV2
  diagnostics: BubbleDiagnostic[]
  fixes: string[]
} {
  return autoFixPalette(theme)
}

/** 12 个语义色的最终取值(override ?? 派生):高级配色面板的显示与覆盖基准 */
export function effectiveBubbleColors(theme: BubbleThemeV2): {
  surface: string
  text: string
  outline: string
  accA: string
  accB: string
  accC: string
  surfaceA: string
  surfaceB: string
  surfaceC: string
  outlineA: string
  outlineB: string
  outlineC: string
} {
  const pal = deriveEffectivePalette(theme)
  return {
    surface: pal.surface,
    text: pal.text,
    outline: pal.outline,
    accA: pal.acc.A,
    accB: pal.acc.B,
    accC: pal.acc.C,
    surfaceA: pal.surfaceX.A,
    surfaceB: pal.surfaceX.B,
    surfaceC: pal.surfaceX.C,
    outlineA: pal.outlineX.A,
    outlineB: pal.outlineX.B,
    outlineC: pal.outlineX.C,
  }
}
