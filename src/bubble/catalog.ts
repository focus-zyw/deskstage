// 模板目录:骨架声明 + 兼容材质白名单 + 各组默认值。编辑器只展示白名单内组合,
// resolve 对越界组合回落 defaultMaterial,保证"没有难看的玻璃云朵爆炸框"。
import type {
  BubbleMaterialId,
  BubbleTemplateId,
  BubbleThemeV2,
} from './types'

export interface BubbleTemplateDefaults {
  material: { opacity: number; blur: number }
  frame: { radius: number; outlineWidth: number }
  nameplate: { style: BubbleThemeV2['nameplate']['style']; position: BubbleThemeV2['nameplate']['position'] }
  tail: { style: BubbleThemeV2['tail']['style']; size: number }
  typography: { align: BubbleThemeV2['typography']['align']; weight: number; lineHeight: number }
  layout: { maxWidth: number; paddingX: number; paddingY: number }
  effects: { shadow: BubbleThemeV2['effects']['shadow']; glow: number; texture: number }
}

export interface BubbleTemplateDef {
  id: BubbleTemplateId
  label: string
  desc: string
  materials: BubbleMaterialId[]
  defaultMaterial: BubbleMaterialId
  defaults: BubbleTemplateDefaults
}

function defaults(over: Partial<BubbleTemplateDefaults>): BubbleTemplateDefaults {
  return {
    material: { opacity: 0.93, blur: 0 },
    frame: { radius: 18, outlineWidth: 1 },
    nameplate: { style: 'badge', position: 'top-left' },
    tail: { style: 'droplet', size: 16 },
    typography: { align: 'left', weight: 650, lineHeight: 1.58 },
    layout: { maxWidth: 320, paddingX: 17, paddingY: 15 },
    effects: { shadow: 'soft', glow: 0, texture: 0 },
    ...over,
  }
}

export const BUBBLE_TEMPLATES: Record<BubbleTemplateId, BubbleTemplateDef> = {
  'soft-chat': {
    id: 'soft-chat',
    label: '柔和对话',
    desc: '常规圆角框 + 水滴尾,日常对话百搭',
    materials: ['solid', 'gradient', 'glass', 'paper', 'neon'],
    defaultMaterial: 'gradient',
    defaults: defaults({}),
  },
  pill: {
    id: 'pill',
    label: '胶囊气泡',
    desc: '完整胶囊轮廓 + 小圆尾,短句卖萌',
    materials: ['solid', 'gradient', 'glass', 'neon'],
    defaultMaterial: 'solid',
    defaults: defaults({
      frame: { radius: 28, outlineWidth: 1 },
      tail: { style: 'curve', size: 12 },
      nameplate: { style: 'badge', position: 'top-center' },
      layout: { maxWidth: 300, paddingX: 20, paddingY: 12 },
    }),
  },
  'comic-burst': {
    id: 'comic-burst',
    label: '漫画爆发框',
    desc: '锯齿轮廓 + 粗描边,喊话吐槽专用',
    materials: ['solid', 'neon'],
    defaultMaterial: 'solid',
    defaults: defaults({
      material: { opacity: 0.97, blur: 0 },
      frame: { radius: 6, outlineWidth: 2.5 },
      nameplate: { style: 'badge', position: 'top-left' },
      tail: { style: 'triangle', size: 18 },
      typography: { align: 'center', weight: 800, lineHeight: 1.4 },
      effects: { shadow: 'strong', glow: 0, texture: 0 },
    }),
  },
  cloud: {
    id: 'cloud',
    label: '云朵气泡',
    desc: '多圆瓣边缘 + 圆泡尾,软萌内心戏',
    materials: ['solid', 'gradient', 'glass'],
    defaultMaterial: 'gradient',
    defaults: defaults({
      material: { opacity: 0.95, blur: 0 },
      frame: { radius: 24, outlineWidth: 1 },
      nameplate: { style: 'badge', position: 'top-left' },
      tail: { style: 'bubbles', size: 12 },
      layout: { maxWidth: 340, paddingX: 22, paddingY: 18 },
    }),
  },
  sticker: {
    id: 'sticker',
    label: '手账贴纸',
    desc: '不规则纸片 + 胶带 + 硬阴影,生活感',
    materials: ['solid', 'gradient', 'paper'],
    defaultMaterial: 'paper',
    defaults: defaults({
      material: { opacity: 0.98, blur: 0 },
      frame: { radius: 14, outlineWidth: 0 },
      nameplate: { style: 'inline', position: 'inside' },
      tail: { style: 'none', size: 12 },
      typography: { align: 'left', weight: 600, lineHeight: 1.55 },
      layout: { maxWidth: 320, paddingX: 18, paddingY: 16 },
      effects: { shadow: 'strong', glow: 0, texture: 60 },
    }),
  },
  rpg: {
    id: 'rpg',
    label: 'RPG 文本框',
    desc: '方角双线 + 名字标签槽,故事扮演',
    materials: ['solid', 'glass', 'paper', 'neon'],
    defaultMaterial: 'solid',
    defaults: defaults({
      material: { opacity: 0.96, blur: 0 },
      frame: { radius: 6, outlineWidth: 2 },
      nameplate: { style: 'tab', position: 'top-left' },
      tail: { style: 'none', size: 12 },
      typography: { align: 'left', weight: 600, lineHeight: 1.55 },
    }),
  },
  caption: {
    id: 'caption',
    label: '极简字幕',
    desc: '无名签无尾的半透明横条,低干扰长文',
    materials: ['solid', 'glass', 'neon'],
    defaultMaterial: 'glass',
    defaults: defaults({
      material: { opacity: 0.62, blur: 10 },
      frame: { radius: 10, outlineWidth: 0 },
      nameplate: { style: 'inline', position: 'inside' },
      tail: { style: 'none', size: 12 },
      typography: { align: 'left', weight: 500, lineHeight: 1.6 },
      layout: { maxWidth: 520, paddingX: 18, paddingY: 12 },
      effects: { shadow: 'soft', glow: 0, texture: 0 },
    }),
  },
}

/** 稳定 id:'comic'/'glass' 被 config.bubbleStyle、回退逻辑与既有配置引用,永不变 */
export const BUILTIN_BUBBLE_THEME_IDS = ['comic', 'glass'] as const
export type BuiltinBubbleThemeId = (typeof BUILTIN_BUBBLE_THEME_IDS)[number]

/**
 * 内置主题(不可变 V2):颜色以 overrides 全量写死(不走派生),
 * 与旧 :root[data-bubble] 静态变量集逐色一致;自定义主题走同一条渲染链路。
 */
export const BUILT_IN_BUBBLE_THEMES: Record<BuiltinBubbleThemeId, BubbleThemeV2> = {
  comic: {
    version: 2,
    id: 'comic',
    label: '柔彩',
    templateId: 'soft-chat',
    material: { id: 'gradient', opacity: 0.93, blur: 0 },
    palette: {
      mode: 'per-speaker',
      primary: '#e98050',
      lightness: 'light',
      speakerStrength: 60,
      overrides: {
        surface: '#faf7f2',
        text: '#26232f',
        outline: '#92887e',
        accA: '#e98050',
        accB: '#5f86da',
        accC: '#8572d8',
        surfaceA: '#fff4eb',
        surfaceB: '#edf5ff',
        surfaceC: '#f5f0ff',
        outlineA: '#dd8b62',
        outlineB: '#688fd5',
        outlineC: '#8974d0',
      },
    },
    frame: { radius: 18, outlineWidth: 1 },
    typography: { fontPreset: 'friendly', size: 16, weight: 650, lineHeight: 1.58, align: 'left' },
    nameplate: { style: 'badge', position: 'top-left' },
    tail: { style: 'droplet', size: 16 },
    layout: { maxWidth: 320, paddingX: 17, paddingY: 15 },
    effects: { shadow: 'soft', glow: 0, texture: 0 },
  },
  glass: {
    version: 2,
    id: 'glass',
    label: '夜色玻璃',
    templateId: 'soft-chat',
    material: { id: 'glass', opacity: 0.86, blur: 14 },
    palette: {
      mode: 'per-speaker',
      primary: '#ffb066',
      lightness: 'dark',
      speakerStrength: 60,
      overrides: {
        surface: '#1b1e2f',
        text: '#f2f4ff',
        outline: '#a399d5',
        accA: '#ffb066',
        accB: '#7db3ff',
        accC: '#a89bff',
        surfaceA: '#302328',
        surfaceB: '#1b2740',
        surfaceC: '#2b2343',
        outlineA: '#ffb066',
        outlineB: '#7db3ff',
        outlineC: '#a89bff',
      },
    },
    frame: { radius: 18, outlineWidth: 1 },
    typography: { fontPreset: 'friendly', size: 16, weight: 650, lineHeight: 1.58, align: 'left' },
    nameplate: { style: 'badge', position: 'top-left' },
    tail: { style: 'triangle', size: 17 },
    layout: { maxWidth: 320, paddingX: 17, paddingY: 15 },
    effects: { shadow: 'strong', glow: 0, texture: 0 },
  },
}

export function isBuiltinBubbleThemeId(id: string): id is BuiltinBubbleThemeId {
  return (BUILTIN_BUBBLE_THEME_IDS as readonly string[]).includes(id)
}

/** 材质不在模板白名单时回落 defaultMaterial(normalize 与 resolve 双重兜底) */
export function compatibleMaterial(templateId: BubbleTemplateId, materialId: BubbleMaterialId): BubbleMaterialId {
  const def = BUBBLE_TEMPLATES[templateId]
  return def.materials.includes(materialId) ? materialId : def.defaultMaterial
}
