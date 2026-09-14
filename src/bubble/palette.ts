// 配色引擎(模块内部实现,不进公共接口):hex/HSL 转换、语义色派生、
// 对比度诊断与自动修复、随机微调。最终一律落回 #RRGGBB / rgba() 串。
import type {
  BubbleDiagnostic,
  BubbleLightness,
  BubbleThemeV2,
} from './types'

// ---------- 基础颜色数学 ----------

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const n = parseInt(hex.slice(1), 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const { r, g, b } = hexToRgb(hex)
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6
  else if (max === gn) h = ((bn - rn) / d + 2) / 6
  else h = ((rn - gn) / d + 4) / 6
  return { h: h * 360, s, l }
}

export function hslToHex(h: number, s: number, l: number): string {
  const hn = ((h % 360) + 360) % 360 / 360
  const sn = Math.min(1, Math.max(0, s))
  const ln = Math.min(1, Math.max(0, l))
  if (sn === 0) {
    const v = Math.round(ln * 255)
    return rgbToHex(v, v, v)
  }
  const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn
  const p = 2 * ln - q
  const channel = (t: number): number => {
    let tn = t
    if (tn < 0) tn += 1
    if (tn > 1) tn -= 1
    if (tn < 1 / 6) return p + (q - p) * 6 * tn
    if (tn < 1 / 2) return q
    if (tn < 2 / 3) return p + (q - p) * (2 / 3 - tn) * 6
    return p
  }
  return rgbToHex(channel(hn + 1 / 3) * 255, channel(hn) * 255, channel(hn - 1 / 3) * 255)
}

/** 线性混合,t = 第二个颜色占比(0~1) */
export function mixHex(a: string, b: string, t: number): string {
  const ca = hexToRgb(a)
  const cb = hexToRgb(b)
  const k = Math.min(1, Math.max(0, t))
  return rgbToHex(ca.r + (cb.r - ca.r) * k, ca.g + (cb.g - ca.g) * k, ca.b + (cb.b - ca.b) * k)
}

export function withAlpha(hex: string, opacity: number): string {
  const { r, g, b } = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, opacity))})`
}

export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex)
  const channel = (v: number): number => {
    const n = v / 255
    return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

// ---------- 语义色派生 ----------

/** 从主色 + 明暗模式派生气泡底色:浅色模式贴近白,深色模式贴近深夜蓝黑 */
function deriveSurface(primary: string, lightness: BubbleLightness): string {
  return lightness === 'light' ? mixHex('#ffffff', primary, 0.08) : mixHex('#15151e', primary, 0.16)
}

/** 文字色:先按模式取基色,再保证与底色对比 ≥ 4.5 */
function deriveText(surface: string, primary: string, lightness: BubbleLightness): string {
  let text = lightness === 'light' ? mixHex('#26232f', primary, 0.06) : mixHex('#f4f5fb', primary, 0.05)
  const hsl = hexToHsl(text)
  for (let i = 0; i < 24 && contrastRatio(text, surface) < 4.5; i++) {
    text = hslToHex(hsl.h, hsl.s, lightness === 'light' ? hsl.l - i * 0.02 : hsl.l + i * 0.02)
  }
  return text
}

/** 描边色:主色降饱和,浅底压暗 / 深底提亮,保证贴在底色上看得见 */
function deriveOutline(surface: string, primary: string, lightness: BubbleLightness): string {
  const hsl = hexToHsl(primary)
  const l = lightness === 'light' ? Math.max(0.22, hsl.l * 0.58) : Math.min(0.82, hsl.l * 0.4 + 0.45)
  let outline = hslToHex(hsl.h, hsl.s * 0.55, l)
  for (let i = 0; i < 16 && contrastRatio(outline, surface) < 1.35; i++) {
    outline = hslToHex(hsl.h, hsl.s * 0.55, lightness === 'light' ? l - i * 0.03 : l + i * 0.03)
  }
  return outline
}

/** 角色强调色:主色按色相三角偏移,speakerStrength 0 = 同色,100 = 最大区分 */
function deriveAccent(primary: string, slot: 'A' | 'B' | 'C', strength: number): string {
  if (slot === 'A') return primary
  const offset = (slot === 'B' ? 145 : 255) * Math.min(1, Math.max(0, strength))
  const hsl = hexToHsl(primary)
  return hslToHex(hsl.h + offset, Math.min(1, hsl.s * 1.05 + 0.05), Math.min(0.72, Math.max(0.4, hsl.l)))
}

/**
 * 计算主题的最终语义色:overrides 有值用覆盖,缺省项从派生输入补齐。
 * 内置主题 overrides 全量写死,派生完全不参与,视觉与旧静态变量逐色一致。
 */
export function deriveEffectivePalette(theme: BubbleThemeV2): {
  surface: string
  text: string
  outline: string
  acc: Record<'A' | 'B' | 'C', string>
  surfaceX: Record<'A' | 'B' | 'C', string>
  outlineX: Record<'A' | 'B' | 'C', string>
} {
  const p = theme.palette
  const ov = p.overrides ?? {}
  const s = Math.min(1, Math.max(0, p.speakerStrength / 100))
  const surface = ov.surface ?? deriveSurface(p.primary, p.lightness)
  const text = ov.text ?? deriveText(surface, p.primary, p.lightness)
  const outline = ov.outline ?? deriveOutline(surface, p.primary, p.lightness)
  const acc = {
    A: ov.accA ?? deriveAccent(p.primary, 'A', s),
    B: ov.accB ?? deriveAccent(p.primary, 'B', s),
    C: ov.accC ?? deriveAccent(p.primary, 'C', s),
  }
  // unified = 三角色同底同描边(名签色仍区分);per-speaker = 底/描边向各自强调色偏移
  const perSpeaker = p.mode === 'per-speaker'
  const surfaceX = {
    A: ov.surfaceA ?? (perSpeaker ? mixHex(surface, acc.A, 0.14) : surface),
    B: ov.surfaceB ?? (perSpeaker ? mixHex(surface, acc.B, 0.14) : surface),
    C: ov.surfaceC ?? (perSpeaker ? mixHex(surface, acc.C, 0.14) : surface),
  }
  const outlineX = {
    A: ov.outlineA ?? (perSpeaker ? mixHex(outline, acc.A, 0.45) : outline),
    B: ov.outlineB ?? (perSpeaker ? mixHex(outline, acc.B, 0.45) : outline),
    C: ov.outlineC ?? (perSpeaker ? mixHex(outline, acc.C, 0.45) : outline),
  }
  return { surface, text, outline, acc, surfaceX, outlineX }
}

// ---------- 诊断与自动修复 ----------

const TEXT_CONTRAST_MIN = 4.5
const OUTLINE_CONTRAST_MIN = 1.3
const ACCENT_CONTRAST_MIN = 1.15

/** 诊断用代表桌面:舞台是透明窗口叠在真实桌面上,低透明度材质的实际底色取决于桌面 */
const DESK_LIGHT = '#e9e6df'
const DESK_DARK = '#1a1c26'
const OPAQUE_ENOUGH = 0.97

/** 文字对比度按实际量纲算:近不透明用主题底色;透明材质在浅/深代表桌面上按 opacity
 *  合成后取最差——"4.5:1 合格"必须对最坏桌面成立才算可读 */
function worstTextContrast(text: string, surface: string, opacity: number): number {
  if (opacity >= OPAQUE_ENOUGH) return contrastRatio(text, surface)
  return Math.min(
    contrastRatio(text, mixHex(DESK_LIGHT, surface, opacity)),
    contrastRatio(text, mixHex(DESK_DARK, surface, opacity)),
  )
}

/** 诊断:文字可读性、描边可见性、角色区分度。只报告,不改动。 */
export function diagnosePalette(theme: BubbleThemeV2): BubbleDiagnostic[] {
  const pal = deriveEffectivePalette(theme)
  const issues: BubbleDiagnostic[] = []
  for (const sp of ['A', 'B', 'C'] as const) {
    const ratio = worstTextContrast(pal.text, pal.surfaceX[sp], theme.material.opacity)
    if (ratio < TEXT_CONTRAST_MIN) {
      issues.push({ kind: 'contrast-text', speaker: sp, message: `角色${sp}文字对比度 ${ratio.toFixed(2)}:1,低于 4.5:1,可能看不清` })
    }
  }
  for (const sp of ['A', 'B', 'C'] as const) {
    if (theme.frame.outlineWidth <= 0) break
    const ratio = contrastRatio(pal.outlineX[sp], pal.surfaceX[sp])
    if (ratio < OUTLINE_CONTRAST_MIN) {
      issues.push({ kind: 'contrast-outline', speaker: sp, message: `角色${sp}描边与底色过于接近(对比 ${ratio.toFixed(2)}:1),轮廓会消失` })
    }
  }
  const pairs: Array<['A' | 'B' | 'C', 'A' | 'B' | 'C']> = [
    ['A', 'B'],
    ['A', 'C'],
    ['B', 'C'],
  ]
  for (const [x, y] of pairs) {
    const hx = hexToHsl(pal.acc[x])
    const hy = hexToHsl(pal.acc[y])
    const hueGap = Math.min(Math.abs(hx.h - hy.h), 360 - Math.abs(hx.h - hy.h))
    const ratio = contrastRatio(pal.acc[x], pal.acc[y])
    if (ratio < ACCENT_CONTRAST_MIN && hueGap < 20) {
      issues.push({ kind: 'speaker-similar', speaker: y, message: `角色${x}与${y}的名签色过于相近,分不清谁在说话` })
    }
  }
  return issues
}

/** 沿明度轴移动 text 直到通过 check(浅色模式压暗,深色模式提亮);check 与诊断同量纲 */
function pushTextContrast(text: string, lightness: BubbleLightness, check: (candidate: string) => boolean): string {
  const hsl = hexToHsl(text)
  for (let i = 1; i <= 30; i++) {
    const candidate = hslToHex(hsl.h, hsl.s, lightness === 'light' ? hsl.l - i * 0.02 : hsl.l + i * 0.02)
    if (check(candidate)) return candidate
  }
  return lightness === 'light' ? '#111018' : '#f7f8ff'
}

function pushOutlineContrast(outline: string, surface: string, lightness: BubbleLightness): string {
  const hsl = hexToHsl(outline)
  for (let i = 1; i <= 24; i++) {
    const candidate = hslToHex(hsl.h, hsl.s, lightness === 'light' ? hsl.l - i * 0.03 : hsl.l + i * 0.03)
    if (contrastRatio(candidate, surface) >= OUTLINE_CONTRAST_MIN) return candidate
  }
  return outline
}

/**
 * 自动修复:按依赖顺序修——①角色名签色(推色会连带改变 per-speaker 底色)
 * → ②文字可读(在最终底色上判定)→ ③描边可见。每步只写 overrides,
 * 返回修复说明,幂等(修完再跑无新增修复)。
 */
export function autoFixPalette(theme: BubbleThemeV2): {
  theme: BubbleThemeV2
  diagnostics: BubbleDiagnostic[]
  fixes: string[]
} {
  const fixes: string[] = []
  let work = theme

  // ① 角色过近:把过近的一方向远处推色相
  {
    const pal = deriveEffectivePalette(work)
    const ov = { ...work.palette.overrides }
    const nextAcc = { A: ov.accA ?? pal.acc.A, B: ov.accB ?? pal.acc.B, C: ov.accC ?? pal.acc.C }
    let changed = false
    for (const [x, y] of [['A', 'B'], ['A', 'C'], ['B', 'C']] as const) {
      const hx = hexToHsl(nextAcc[x])
      const hy = hexToHsl(nextAcc[y])
      const gap = Math.min(Math.abs(hx.h - hy.h), 360 - Math.abs(hx.h - hy.h))
      if (contrastRatio(nextAcc[x], nextAcc[y]) < ACCENT_CONTRAST_MIN && gap < 20) {
        const pushed = hslToHex(hy.h + (y === 'C' ? 60 : -60), hy.s, hy.l)
        fixes.push(`角色${y}名签色调整为 ${pushed} 以拉开区分`)
        nextAcc[y] = pushed
        changed = true
      }
    }
    if (changed) {
      ov.accA = nextAcc.A
      ov.accB = nextAcc.B
      ov.accC = nextAcc.C
      work = { ...work, palette: { ...work.palette, overrides: ov } }
    }
  }

  // ② 文字可读:对三个角色底色(按材质透明度在深/浅桌面合成)全部达标才算修好
  {
    const pal = deriveEffectivePalette(work)
    const ov = { ...work.palette.overrides }
    const opacity = work.material.opacity
    const textCheck = (candidate: string): boolean =>
      (['A', 'B', 'C'] as const).every((sp) => worstTextContrast(candidate, pal.surfaceX[sp], opacity) >= TEXT_CONTRAST_MIN)
    if (!textCheck(ov.text ?? pal.text)) {
      const fixed = pushTextContrast(ov.text ?? pal.text, work.palette.lightness, textCheck)
      if (fixed !== (ov.text ?? pal.text)) {
        fixes.push(`文字色调整为 ${fixed} 以保证可读`)
        ov.text = fixed
        work = { ...work, palette: { ...work.palette, overrides: ov } }
      }
    }
  }

  // ③ 描边可见:贴底不可见的拉开
  if (work.frame.outlineWidth > 0) {
    const pal = deriveEffectivePalette(work)
    const ov = { ...work.palette.overrides }
    let changed = false
    for (const sp of ['A', 'B', 'C'] as const) {
      if (contrastRatio(pal.outlineX[sp], pal.surfaceX[sp]) >= OUTLINE_CONTRAST_MIN) continue
      const base = sp === 'A' ? (ov.outlineA ?? pal.outlineX.A) : sp === 'B' ? (ov.outlineB ?? pal.outlineX.B) : (ov.outlineC ?? pal.outlineX.C)
      const fixed = pushOutlineContrast(base, pal.surfaceX[sp], work.palette.lightness)
      if (fixed !== base) {
        fixes.push(`角色${sp}描边调整为 ${fixed} 以恢复轮廓`)
        if (sp === 'A') ov.outlineA = fixed
        else if (sp === 'B') ov.outlineB = fixed
        else ov.outlineC = fixed
        changed = true
      }
    }
    if (changed) work = { ...work, palette: { ...work.palette, overrides: ov } }
  }

  return { theme: work, diagnostics: diagnosePalette(work), fixes }
}

// ---------- 随机微调 ----------

/** 随机微调:整体旋转色相 ±amount 度、轻微摆动明度;overrides 存在时逐色旋转保持相对关系 */
export function jitterPalette(primary: string, overrides: BubbleThemeV2['palette']['overrides'] | undefined, amountDeg: number, rand: () => number): {
  primary: string
  overrides?: BubbleThemeV2['palette']['overrides']
} {
  const delta = (rand() * 2 - 1) * amountDeg
  const tilt = (rand() * 2 - 1) * 0.04
  const rotate = (hex: string): string => {
    const hsl = hexToHsl(hex)
    if (hsl.s < 0.04) return hex // 无彩色不转,避免把黑白灰转出脏色
    return hslToHex(hsl.h + delta, hsl.s, Math.min(0.96, Math.max(0.04, hsl.l + tilt)))
  }
  const nextOverrides = overrides
    ? (Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, rotate(v)])) as BubbleThemeV2['palette']['overrides'])
    : undefined
  return { primary: rotate(primary), overrides: nextOverrides }
}
