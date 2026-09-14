// 主题归一化:V2 校验清洗 + V1 旧主题读取时迁移。坏数据宁可拒收,坏字段宁可落
// 安全默认——列表级调用方(存储层)靠返回 null 跳过整条,单主题级调用方拿到的是补全后的对象。
// 迁移只在读取时发生,保存后写 version:2;normalize 幂等(V2 进 V2 出,值不变)。
import { BUILT_IN_BUBBLE_THEMES, BUBBLE_TEMPLATES, compatibleMaterial, isBuiltinBubbleThemeId } from './catalog'
import {
  BUBBLE_FONT_PRESETS,
  BUBBLE_MATERIAL_IDS,
  BUBBLE_NAMEPLATE_POSITIONS,
  BUBBLE_NAMEPLATE_STYLES,
  BUBBLE_SHADOW_LEVELS,
  BUBBLE_TAIL_STYLES,
  BUBBLE_TEMPLATE_IDS,
  type BubbleLightness,
  type BubbleMaterialId,
  type BubbleNameplatePosition,
  type BubbleNameplateStyle,
  type BubblePaletteOverrides,
  type BubbleShadowLevel,
  type BubbleTailStyle,
  type BubbleTemplateId,
  type BubbleThemeV2,
} from './types'
import { relativeLuminance } from './palette'

const HEX = /^#[0-9a-fA-F]{6}$/

/** V1 旧主题(扁平字段):仅作迁移输入,不再对外暴露 */
export interface LegacyBubbleThemeV1 {
  id: string
  label: string
  bg: string
  text: string
  stroke: string
  accA: string
  accB: string
  accC: string
  bgA: string
  bgB: string
  bgC: string
  strokeA: string
  strokeB: string
  strokeC: string
  bgOpacity: number
  strokeW: number
  blurPx: number
  fontSize: number
  maxWidth: number
  radius: number
  shape: 'rounded' | 'pill' | 'square' | 'cloud'
  tailStyle: 'droplet' | 'sharp' | 'round' | 'none'
  shadow: 'none' | 'soft' | 'strong'
  fontWeight: number
  lineHeight: number
  paddingX: number
  paddingY: number
}

const CUSTOM_ID = /^custom_[a-z0-9_-]{1,32}$/

function isHex(v: unknown): v is string {
  return typeof v === 'string' && HEX.test(v.trim())
}

function hexOf(v: unknown, fallback: string): string {
  return isHex(v) ? (v as string).trim().toLowerCase() : fallback
}

function optHex(v: unknown): string | undefined {
  return isHex(v) ? (v as string).trim().toLowerCase() : undefined
}

function num(v: unknown, lo: number, hi: number, fb: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fb
  return Math.min(hi, Math.max(lo, Math.round(n * 100) / 100))
}

function choice<T extends string>(v: unknown, values: readonly T[], fb: T): T {
  return typeof v === 'string' && (values as readonly string[]).includes(v) ? (v as T) : fb
}

function cleanOverrides(v: unknown): BubblePaletteOverrides | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const o = v as Record<string, unknown>
  const out: BubblePaletteOverrides = {}
  const keys = [
    'surface', 'text', 'outline',
    'accA', 'accB', 'accC',
    'surfaceA', 'surfaceB', 'surfaceC',
    'outlineA', 'outlineB', 'outlineC',
  ] as const
  let any = false
  for (const k of keys) {
    const c = optHex(o[k])
    if (c) {
      out[k] = c
      any = true
    }
  }
  return any ? out : undefined
}

function cleanId(v: unknown): string | null {
  const id = typeof v === 'string' ? v.trim() : ''
  if (CUSTOM_ID.test(id) || isBuiltinBubbleThemeId(id)) return id
  return null
}

function cleanLabel(v: unknown): string {
  return typeof v === 'string' ? v.trim().slice(0, 10) : ''
}

/** 校验并补全一份 V2 主题;id/label 不合法返回 null(与旧存储层同一拒收语义) */
export function normalizeBubbleTheme(raw: unknown): BubbleThemeV2 | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const id = cleanId(o.id)
  if (!id) return null
  const label = cleanLabel(o.label)
  if (!label) return null
  const templateId = choice<BubbleTemplateId>(o.templateId, BUBBLE_TEMPLATE_IDS, 'soft-chat')
  const tpl = BUBBLE_TEMPLATES[templateId]
  const materialRaw = (typeof o.material === 'object' && o.material !== null ? o.material : {}) as Record<string, unknown>
  const paletteRaw = (typeof o.palette === 'object' && o.palette !== null ? o.palette : {}) as Record<string, unknown>
  const frameRaw = (typeof o.frame === 'object' && o.frame !== null ? o.frame : {}) as Record<string, unknown>
  const typoRaw = (typeof o.typography === 'object' && o.typography !== null ? o.typography : {}) as Record<string, unknown>
  const nameplateRaw = (typeof o.nameplate === 'object' && o.nameplate !== null ? o.nameplate : {}) as Record<string, unknown>
  const tailRaw = (typeof o.tail === 'object' && o.tail !== null ? o.tail : {}) as Record<string, unknown>
  const layoutRaw = (typeof o.layout === 'object' && o.layout !== null ? o.layout : {}) as Record<string, unknown>
  const effectsRaw = (typeof o.effects === 'object' && o.effects !== null ? o.effects : {}) as Record<string, unknown>
  const materialId = compatibleMaterial(
    templateId,
    choice<BubbleMaterialId>(materialRaw.id, BUBBLE_MATERIAL_IDS, tpl.defaultMaterial),
  )
  const theme: BubbleThemeV2 = {
    version: 2,
    id,
    label,
    templateId,
    material: {
      id: materialId,
      // blur 只有 glass 消费,其它材质强制 0(防"纸纹理配背景模糊"的脏组合)
      opacity: num(materialRaw.opacity, 0.35, 1, tpl.defaults.material.opacity),
      blur: materialId === 'glass' ? num(materialRaw.blur, 0, 24, tpl.defaults.material.blur) : 0,
    },
    palette: {
      mode: choice(paletteRaw.mode, ['unified', 'per-speaker'] as const, 'per-speaker'),
      primary: hexOf(paletteRaw.primary, BUILT_IN_BUBBLE_THEMES.comic.palette.primary),
      lightness: choice<BubbleLightness>(paletteRaw.lightness, ['light', 'dark'], 'light'),
      speakerStrength: num(paletteRaw.speakerStrength, 0, 100, 60),
    },
    frame: {
      radius: num(frameRaw.radius, 6, 28, tpl.defaults.frame.radius),
      outlineWidth: num(frameRaw.outlineWidth, 0, 4, tpl.defaults.frame.outlineWidth),
    },
    typography: {
      fontPreset: choice(typoRaw.fontPreset, BUBBLE_FONT_PRESETS, 'friendly'),
      size: num(typoRaw.size, 12, 22, 16),
      weight: Math.round(num(typoRaw.weight, 400, 800, tpl.defaults.typography.weight)),
      lineHeight: num(typoRaw.lineHeight, 1.2, 1.9, tpl.defaults.typography.lineHeight),
      align: choice(typoRaw.align, ['left', 'center'] as const, tpl.defaults.typography.align),
    },
    nameplate: {
      style: choice<BubbleNameplateStyle>(nameplateRaw.style, BUBBLE_NAMEPLATE_STYLES, tpl.defaults.nameplate.style),
      position: choice<BubbleNameplatePosition>(nameplateRaw.position, BUBBLE_NAMEPLATE_POSITIONS, tpl.defaults.nameplate.position),
    },
    tail: {
      style: choice<BubbleTailStyle>(tailRaw.style, BUBBLE_TAIL_STYLES, tpl.defaults.tail.style),
      size: num(tailRaw.size, 10, 24, tpl.defaults.tail.size),
    },
    layout: {
      maxWidth: num(layoutRaw.maxWidth, 240, 520, tpl.defaults.layout.maxWidth),
      paddingX: num(layoutRaw.paddingX, 10, 28, tpl.defaults.layout.paddingX),
      paddingY: num(layoutRaw.paddingY, 8, 28, tpl.defaults.layout.paddingY),
    },
    effects: {
      shadow: choice<BubbleShadowLevel>(effectsRaw.shadow, BUBBLE_SHADOW_LEVELS, tpl.defaults.effects.shadow),
      glow: num(effectsRaw.glow, 0, 100, tpl.defaults.effects.glow),
      texture: num(effectsRaw.texture, 0, 100, tpl.defaults.effects.texture),
    },
  }
  // overrides 缺省时不落键(深相等语义:没有覆盖 ≠ 空覆盖)
  const overrides = cleanOverrides(paletteRaw.overrides)
  if (overrides) theme.palette.overrides = overrides
  return theme
}

// ---------- V1 → V2 迁移 ----------

/** V1 shape → V2 模板:rounded/pill 直译,square 升级为 RPG 框,cloud 保留 */
function templateOfV1(shape: LegacyBubbleThemeV1['shape']): BubbleTemplateId {
  if (shape === 'pill') return 'pill'
  if (shape === 'square') return 'rpg'
  if (shape === 'cloud') return 'cloud'
  return 'soft-chat'
}

/** V1 指向角 → V2 尾巴:sharp 尖角化三角,round 圆泡化为弧尾 */
function tailOfV1(style: LegacyBubbleThemeV1['tailStyle']): BubbleTailStyle {
  if (style === 'sharp') return 'triangle'
  if (style === 'round') return 'curve'
  if (style === 'none') return 'none'
  return 'droplet'
}

/**
 * 读取时迁移:V1 颜色 12 项全量进 overrides(零丢失),blurPx>0 优先映射 glass
 * (模板不兼容则回落 solid),primary 取角色 A 强调色,明暗按文字亮度判定。
 */
export function migrateBubbleThemeV1(v1: LegacyBubbleThemeV1): BubbleThemeV2 | null {
  if (typeof v1 !== 'object' || v1 === null) return null
  const o = v1 as unknown as Record<string, unknown>
  const id = cleanId(o.id)
  const label = cleanLabel(o.label)
  if (!id || !label) return null
  const templateId = templateOfV1(choice(o.shape, ['rounded', 'pill', 'square', 'cloud'] as const, 'rounded'))
  const blurPx = num(o.blurPx, 0, 24, 0)
  const fallbackMaterial: BubbleMaterialId = templateId === 'rpg' ? 'solid' : 'gradient'
  const materialId = blurPx > 0 ? compatibleMaterial(templateId, 'glass') : fallbackMaterial
  const accA = hexOf(o.accA, '#e98050')
  const textHex = hexOf(o.text, '#26232f')
  // 深色字 = 浅色底;亮度阈值 0.45 与可读性诊断同一量纲
  const lightness: BubbleLightness = relativeLuminance(textHex) < 0.45 ? 'light' : 'dark'
  const surfaces = [hexOf(o.bgA, '#fff4eb'), hexOf(o.bgB, '#edf5ff'), hexOf(o.bgC, '#f5f0ff')]
  const unified = surfaces[0] === surfaces[1] && surfaces[1] === surfaces[2]
  return normalizeBubbleTheme({
    version: 2,
    id,
    label,
    templateId,
    material: { id: materialId, opacity: num(o.bgOpacity, 0.35, 1, 0.93), blur: blurPx },
    palette: {
      mode: unified ? 'unified' : 'per-speaker',
      primary: accA,
      lightness,
      speakerStrength: 60,
      overrides: {
        surface: hexOf(o.bg, '#faf7f2'),
        text: textHex,
        outline: hexOf(o.stroke, '#92887e'),
        accA,
        accB: hexOf(o.accB, '#5f86da'),
        accC: hexOf(o.accC, '#8572d8'),
        surfaceA: surfaces[0],
        surfaceB: surfaces[1],
        surfaceC: surfaces[2],
        outlineA: hexOf(o.strokeA, '#dd8b62'),
        outlineB: hexOf(o.strokeB, '#688fd5'),
        outlineC: hexOf(o.strokeC, '#8974d0'),
      },
    },
    frame: { radius: num(o.radius, 6, 28, 18), outlineWidth: num(o.strokeW, 1, 3, 1) },
    typography: {
      fontPreset: 'friendly',
      size: num(o.fontSize, 12, 22, 16),
      weight: Math.round(num(o.fontWeight, 400, 800, 650)),
      lineHeight: num(o.lineHeight, 1.2, 1.9, 1.58),
      align: 'left',
    },
    nameplate: { style: 'badge', position: 'top-left' },
    tail: { style: tailOfV1(choice(o.tailStyle, ['droplet', 'sharp', 'round', 'none'] as const, 'droplet')), size: 16 },
    layout: {
      maxWidth: num(o.maxWidth, 240, 480, 320),
      paddingX: num(o.paddingX, 10, 28, 17),
      paddingY: num(o.paddingY, 10, 28, 15),
    },
    effects: { shadow: choice(o.shadow, BUBBLE_SHADOW_LEVELS, 'soft'), glow: 0, texture: 0 },
  })
}

/** 归一化入口:V2 走清洗,V1(旧扁平结构)走迁移,其余拒收。
 *  V1 识别不依赖 shape——最早期主题就没有该字段;bg/accA/bgOpacity 等键只出现在
 *  V1 顶层(V2 顶层是 templateId/material/palette 嵌套),按字段组合判定最稳。 */
const V1_ONLY_KEYS = [
  'bg', 'text', 'stroke', 'accA', 'accB', 'accC',
  'bgA', 'bgB', 'bgC', 'strokeA', 'strokeB', 'strokeC',
  'bgOpacity', 'strokeW', 'blurPx', 'fontSize', 'maxWidth', 'radius',
  'shape', 'tailStyle', 'shadow', 'fontWeight', 'lineHeight', 'paddingX', 'paddingY',
] as const

export function normalizeBubbleThemeAny(raw: unknown): BubbleThemeV2 | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (o.version === 2) return normalizeBubbleTheme(raw)
  const looksV1 = (V1_ONLY_KEYS as readonly string[]).some((k) => k in o)
  if (looksV1) return migrateBubbleThemeV1(raw as LegacyBubbleThemeV1)
  return normalizeBubbleTheme(raw)
}
