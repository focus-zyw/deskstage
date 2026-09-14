// 外观解析:主题 + 运行时上下文 → 最终外观(CSS 变量 + 结构属性 + 每角色取色)。
// 复杂度全部收在这里:模板/材质兼容兜底、阴影与辉光串合成、材质背景层、字体栈。
// 产物由组件原样铺到 .bubble-shell 上(data 属性 + style),CSS 只消费不计算。
import { compatibleMaterial } from './catalog'
import { deriveEffectivePalette, mixHex, withAlpha } from './palette'
import type { BubbleResolveOptions, BubbleThemeV2, ResolvedBubbleAppearance } from './types'

export const BUBBLE_FONT_STACKS: Record<BubbleThemeV2['typography']['fontPreset'], string> = {
  friendly: "'MiSans', 'HarmonyOS Sans SC', 'Microsoft YaHei UI', 'PingFang SC', sans-serif",
  comic: "'Yuanti SC', 'YouYuan', 'MiSans', 'Microsoft YaHei UI', 'PingFang SC', sans-serif",
  clean: "'Segoe UI', 'Source Han Sans SC', 'Noto Sans SC', 'Microsoft YaHei UI', sans-serif",
  pixel: "'Fusion Pixel 12px Proportional SC', 'Zpix', 'SimSun', monospace",
}

/** paper 材质的噪点层:SVG feTurbulence data URI,透明度随纹理强度变化 */
function paperNoiseUrl(texture: number): string {
  const opacity = (0.05 + (Math.min(100, Math.max(0, texture)) / 100) * 0.09).toFixed(3)
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/><feColorMatrix type='saturate' values='0'/></filter><rect width='120' height='120' filter='url(%23n)' opacity='${opacity}'/></svg>`
  return `url("data:image/svg+xml,${svg.replace(/#/g, '%23').replace(/'/g, "\\'")}")`
}

/** 材质表面层(纯色由基础面负责,这里只出 background-image 与 backdrop) */
function materialLayers(
  theme: BubbleThemeV2,
  pal: ReturnType<typeof deriveEffectivePalette>,
): { image: string; backdrop: string } {
  const { id, blur } = theme.material
  const surface = pal.surface
  if (id === 'gradient') {
    const hi = withAlpha(mixHex(surface, '#ffffff', 0.55), 0.28)
    const sheen = withAlpha('#ffffff', 0.05)
    const shade = withAlpha('#6b5e89', 0.04)
    return {
      image: `radial-gradient(circle at 18% -20%, ${hi}, transparent 44%), linear-gradient(145deg, ${sheen}, ${shade})`,
      backdrop: 'none',
    }
  }
  if (id === 'glass') {
    return {
      image: 'linear-gradient(150deg, rgba(255,255,255,0.14), rgba(255,255,255,0.03) 55%)',
      backdrop: `blur(${blur}px) saturate(1.15)`,
    }
  }
  if (id === 'paper') {
    return { image: `${paperNoiseUrl(theme.effects.texture)}, linear-gradient(145deg, rgba(255,255,255,0.35), rgba(120,100,70,0.05))`, backdrop: 'none' }
  }
  if (id === 'neon') {
    return {
      image: 'linear-gradient(160deg, rgba(255,255,255,0.06), transparent 40%)',
      backdrop: 'none',
    }
  }
  return { image: 'none', backdrop: 'none' }
}

/** 阴影/辉光/剪裁滤镜串:box-shadow 走 --bub-shadow,clip-path 模板(漫画)走 --bub-filter。
 *  语义:shadow='none' 就真的无投影(漫画也不落 drop-shadow);辉光独立于阴影档位,
 *  任何档位(含无阴影)都生效——无阴影时辉光以纯光晕形式单独存在 */
function effectVars(theme: BubbleThemeV2): Record<string, string> {
  const { shadow, glow } = theme.effects
  const usesShapeFilter = theme.templateId === 'comic-burst' || theme.templateId === 'cloud'
  const glowAmount = theme.material.id === 'neon' && glow === 0 ? 40 : glow
  const glowPx = `${Math.round((glowAmount / 100) * 24 + 5)}px`
  const glowLayer = glowAmount > 0 ? `, 0 0 ${glowPx} var(--bub-glow-color)` : ''
  const soft = `0 10px 28px var(--bub-shadow-c)`
  const strong = `0 14px 38px var(--bub-shadow-c), 0 3px 10px color-mix(in srgb, var(--bub-edge) 24%, transparent)`
  const hard = `5px 6px 0 color-mix(in srgb, var(--bub-edge) 62%, transparent)`
  let shadowVar = 'none'
  let filterVar = 'none'
  if (usesShapeFilter) {
    const layers: string[] = []
    if (shadow !== 'none') {
      layers.push(`drop-shadow(0 9px 20px var(--bub-shadow-c))`)
      layers.push(`drop-shadow(0 2px 4px color-mix(in srgb, var(--bub-edge) 30%, transparent))`)
    }
    if (glowAmount > 0) layers.push(`drop-shadow(0 0 ${glowPx} var(--bub-glow-color))`)
    if (layers.length > 0) filterVar = layers.join(' ')
  } else if (theme.templateId === 'sticker') {
    if (shadow === 'soft') shadowVar = hard
    else if (shadow === 'strong') shadowVar = hard + glowLayer
    else if (glowAmount > 0) shadowVar = `0 0 ${glowPx} var(--bub-glow-color)`
  } else {
    if (shadow === 'soft') shadowVar = soft + glowLayer
    else if (shadow === 'strong') shadowVar = strong + glowLayer
    else if (glowAmount > 0) shadowVar = `0 0 ${glowPx} var(--bub-glow-color)`
  }
  return { '--bub-shadow': shadowVar, '--bub-filter': filterVar }
}

function frameRadius(theme: BubbleThemeV2): string {
  if (theme.templateId === 'pill') return '999px'
  if (theme.templateId === 'sticker') {
    // 不规则纸片:8 值语法 + 轻微歪斜由模板 CSS 的 rotate 补足
    const r = theme.frame.radius
    return `${r + 6}px ${r - 4}px ${r + 4}px ${r - 2}px / ${r - 2}px ${r + 5}px ${r - 4}px ${r + 3}px`
  }
  return `${theme.frame.radius}px`
}

/** 主入口:主题(+可选减弱动效)→ 可直接落到 .bubble-shell 的完整外观。
 *  说话人/位置/朝向/喊话/长句/情绪等运行时状态由视图转成 class/data 属性,不进这里 */
export function resolveBubbleAppearance(theme: BubbleThemeV2, options?: BubbleResolveOptions): ResolvedBubbleAppearance {
  const materialId = compatibleMaterial(theme.templateId, theme.material.id)
  const effectiveTheme: BubbleThemeV2 =
    materialId === theme.material.id ? theme : { ...theme, material: { ...theme.material, id: materialId } }
  const pal = deriveEffectivePalette(effectiveTheme)
  const opacity = effectiveTheme.material.opacity
  const accent = pal.acc
  const speakers = {
    A: {
      surface: withAlpha(pal.surfaceX.A, opacity),
      edge: withAlpha(pal.outlineX.A, Math.max(0.4, opacity * 0.55)),
      accent: accent.A,
      shadowColor: withAlpha(accent.A, 0.2),
    },
    B: {
      surface: withAlpha(pal.surfaceX.B, opacity),
      edge: withAlpha(pal.outlineX.B, Math.max(0.4, opacity * 0.55)),
      accent: accent.B,
      shadowColor: withAlpha(accent.B, 0.2),
    },
    C: {
      surface: withAlpha(pal.surfaceX.C, opacity),
      edge: withAlpha(pal.outlineX.C, Math.max(0.4, opacity * 0.55)),
      accent: accent.C,
      shadowColor: withAlpha(accent.C, 0.2),
    },
  }
  const layers = materialLayers(effectiveTheme, pal)
  const reduceMotion = options?.reducedMotion === true
  const cssVars: Record<string, string> = {
    '--bub-text': pal.text,
    '--bub-surface': speakers.A.surface,
    '--bub-edge': speakers.A.edge,
    '--bub-surface-a': speakers.A.surface,
    '--bub-surface-b': speakers.B.surface,
    '--bub-surface-c': speakers.C.surface,
    '--bub-edge-a': speakers.A.edge,
    '--bub-edge-b': speakers.B.edge,
    '--bub-edge-c': speakers.C.edge,
    '--bub-acc-a': accent.A,
    '--bub-acc-b': accent.B,
    '--bub-acc-c': accent.C,
    '--bub-shadow-c-a': speakers.A.shadowColor,
    '--bub-shadow-c-b': speakers.B.shadowColor,
    '--bub-shadow-c-c': speakers.C.shadowColor,
    // glow 颜色不在此定义:由 CSS 转译层取当前说话人的 --sp,随角色变化
    '--bub-font': BUBBLE_FONT_STACKS[effectiveTheme.typography.fontPreset],
    '--bub-font-size': `${effectiveTheme.typography.size}px`,
    '--bub-font-weight': String(effectiveTheme.typography.weight),
    '--bub-line-height': String(effectiveTheme.typography.lineHeight),
    '--bub-align': effectiveTheme.typography.align,
    '--bub-max-w': `${effectiveTheme.layout.maxWidth}px`,
    '--bub-pad-x': `${effectiveTheme.layout.paddingX}px`,
    '--bub-pad-y': `${effectiveTheme.layout.paddingY}px`,
    '--bub-radius': frameRadius(effectiveTheme),
    '--bub-outline-w': `${effectiveTheme.frame.outlineWidth}px`,
    '--bub-surface-image': layers.image,
    '--bub-backdrop': layers.backdrop,
    '--bub-tail-size': `${effectiveTheme.tail.size}px`,
    '--bub-in': reduceMotion ? 'none' : 'bubble-in 0.24s cubic-bezier(0.2, 1.45, 0.42, 1)',
    ...effectVars(effectiveTheme),
  }
  return {
    templateId: effectiveTheme.templateId,
    materialId,
    nameplateStyle: effectiveTheme.nameplate.style,
    nameplatePosition: effectiveTheme.nameplate.position,
    tailStyle: effectiveTheme.tail.style,
    speakers,
    text: pal.text,
    cssVars,
  }
}

/**
 * C 画外音横幅(.guest-bubble)的派生取色:固定采用 caption 语义(低干扰半透明条),
 * 但颜色仍来自当前主题——C 禁用立绘时"舞台与预览一致"不断链。
 */
export function resolveGuestLook(theme: BubbleThemeV2): { surface: string; edge: string; text: string } {
  const pal = deriveEffectivePalette(theme)
  const opacity = Math.min(theme.material.opacity, 0.7)
  return {
    surface: withAlpha(pal.surfaceX.C, opacity),
    edge: withAlpha(pal.outlineX.C, 0.45),
    text: pal.text,
  }
}
