// 气泡主题 V2 数据模型:模板(骨架)× 材质(表面)× 配色(派生+覆盖)× 版式。
// 全部取值范围与清洗规则见 normalize.ts;目录(兼容材质/模板默认值)见 catalog.ts。

export const BUBBLE_TEMPLATE_IDS = [
  'soft-chat',
  'pill',
  'comic-burst',
  'cloud',
  'sticker',
  'rpg',
  'caption',
] as const
export type BubbleTemplateId = (typeof BUBBLE_TEMPLATE_IDS)[number]

export const BUBBLE_MATERIAL_IDS = ['solid', 'gradient', 'glass', 'paper', 'neon'] as const
export type BubbleMaterialId = (typeof BUBBLE_MATERIAL_IDS)[number]

/** 第一版不含 pixel:无授权字体资产,系统字体栈压不出稳定像素感 */
export const BUBBLE_FONT_PRESETS = ['friendly', 'comic', 'clean'] as const
export type BubbleFontPreset = (typeof BUBBLE_FONT_PRESETS)[number]

export const BUBBLE_NAMEPLATE_STYLES = ['badge', 'tab', 'inline', 'hidden'] as const
export type BubbleNameplateStyle = (typeof BUBBLE_NAMEPLATE_STYLES)[number]

export const BUBBLE_NAMEPLATE_POSITIONS = ['top-left', 'top-center', 'inside'] as const
export type BubbleNameplatePosition = (typeof BUBBLE_NAMEPLATE_POSITIONS)[number]

export const BUBBLE_TAIL_STYLES = ['droplet', 'triangle', 'curve', 'bubbles', 'none'] as const
export type BubbleTailStyle = (typeof BUBBLE_TAIL_STYLES)[number]

export const BUBBLE_SHADOW_LEVELS = ['none', 'soft', 'strong'] as const
export type BubbleShadowLevel = (typeof BUBBLE_SHADOW_LEVELS)[number]

/** 高级配色覆盖:12 个语义色,全部可选——缺省项由配色引擎从 primary 派生 */
export interface BubblePaletteOverrides {
  surface?: string
  text?: string
  outline?: string
  accA?: string
  accB?: string
  accC?: string
  surfaceA?: string
  surfaceB?: string
  surfaceC?: string
  outlineA?: string
  outlineB?: string
  outlineC?: string
}

export type BubbleColorMode = 'unified' | 'per-speaker'
export type BubbleLightness = 'light' | 'dark'

/**
 * V2 主题 = 骨架选择 + 表面参数 + 配色(派生输入 + 可选覆盖)+ 版式。
 * 派生输入(primary/lightness/speakerStrength/mode)驱动简洁模式;
 * overrides 只在用户高级编辑或迁移时写入。
 */
export interface BubbleThemeV2 {
  version: 2
  id: string
  label: string
  templateId: BubbleTemplateId
  material: {
    id: BubbleMaterialId
    /** 底色不透明度 0.35~1 */
    opacity: number
    /** 背景模糊 0~24 px(glass 材质消费,其余材质强制 0) */
    blur: number
  }
  palette: {
    mode: BubbleColorMode
    primary: string
    lightness: BubbleLightness
    /** 角色区分强度 0~100:0 = 三角色同色,100 = 最大色相三角 */
    speakerStrength: number
    overrides?: BubblePaletteOverrides
  }
  frame: {
    /** 圆角 6~28(pill/caption 等模板可覆盖语义) */
    radius: number
    /** 描边宽 0~4 px */
    outlineWidth: number
  }
  typography: {
    fontPreset: BubbleFontPreset
    size: number
    weight: number
    lineHeight: number
    align: 'left' | 'center'
  }
  nameplate: {
    style: BubbleNameplateStyle
    position: BubbleNameplatePosition
  }
  tail: {
    style: BubbleTailStyle
    size: number
  }
  layout: {
    maxWidth: number
    paddingX: number
    paddingY: number
  }
  effects: {
    shadow: BubbleShadowLevel
    /** 辉光强度 0~100(neon 材质/漫画模板放大消费) */
    glow: number
    /** 纹理强度 0~100(paper 噪点等) */
    texture: number
  }
}

/** 气泡运行时上下文:舞台/预览把自身状态翻译成它,resolve 据此出最终外观 */
export interface BubbleContext {
  speaker: 'A' | 'B' | 'C'
  placement: 'above' | 'below'
  tailSide: 'left' | 'center' | 'right'
  emphasis: 'normal' | 'loud'
  length: 'normal' | 'long'
  mood?: 'angry' | 'shy' | 'excited'
  reducedMotion?: boolean
}

/** 单个角色的最终取色(surface/edge 落到气泡面,accent 落名签与装饰) */
export interface BubbleSpeakerLook {
  surface: string
  edge: string
  accent: string
  shadowColor: string
}

/** resolve 的完整产物:组件直接把 data 属性与 cssVars 铺到 .bubble-shell 上 */
export interface ResolvedBubbleAppearance {
  templateId: BubbleTemplateId
  materialId: BubbleMaterialId
  nameplateStyle: BubbleNameplateStyle
  nameplatePosition: BubbleNameplatePosition
  tailStyle: BubbleTailStyle
  speakers: Record<'A' | 'B' | 'C', BubbleSpeakerLook>
  text: string
  cssVars: Record<string, string>
}

/** AI 设计意图:LLM 只产出受约束的设计决策,完整主题由引擎编译 */
export interface BubbleDesignIntent {
  slot: 'faithful' | 'expressive' | 'restrained'
  label: string
  templateId: BubbleTemplateId
  materialId: BubbleMaterialId
  mood: 'cute' | 'cool' | 'warm' | 'dramatic' | 'minimal'
  lightness: BubbleLightness
  primaryColor: string
  typographyPreset: BubbleFontPreset
  nameplateStyle: BubbleNameplateStyle
}

/** 诊断问题:文字对比度 / 描边贴底 / 角色过近 / 组合非法 */
export interface BubbleDiagnostic {
  kind: 'contrast-text' | 'contrast-outline' | 'speaker-similar'
  speaker?: 'A' | 'B' | 'C'
  message: string
}
