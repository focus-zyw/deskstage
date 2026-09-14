// 气泡主题引擎公共出口(刻意收窄):外部只经这里使用引擎。
// 颜色数学、CSS 变量合成、模板目录内部结构都是实现细节——若删除本模块,
// 兼容迁移、配色派生、骨架规则将被迫散回各调用方,即说明模块深度成立。
export {
  BUBBLE_TEMPLATE_IDS,
  BUBBLE_MATERIAL_IDS,
  BUBBLE_FONT_PRESETS,
  BUBBLE_NAMEPLATE_STYLES,
  BUBBLE_NAMEPLATE_POSITIONS,
  BUBBLE_TAIL_STYLES,
  BUBBLE_SHADOW_LEVELS,
  type BubbleTemplateId,
  type BubbleMaterialId,
  type BubbleFontPreset,
  type BubbleNameplateStyle,
  type BubbleNameplatePosition,
  type BubbleTailStyle,
  type BubbleShadowLevel,
  type BubblePaletteOverrides,
  type BubbleColorMode,
  type BubbleLightness,
  type BubbleThemeV2,
  type BubbleContext,
  type ResolvedBubbleAppearance,
  type BubbleSpeakerLook,
  type BubbleDesignIntent,
  type BubbleDiagnostic,
} from './types'
export {
  BUILT_IN_BUBBLE_THEMES,
  BUILTIN_BUBBLE_THEME_IDS,
  isBuiltinBubbleThemeId,
  type BuiltinBubbleThemeId,
} from './catalog'
export { listBubbleTemplates, type BubbleTemplateSummary } from './catalogList'
export {
  normalizeBubbleTheme,
  normalizeBubbleThemeAny,
  migrateBubbleThemeV1,
  type LegacyBubbleThemeV1,
} from './normalize'
export { resolveBubbleAppearance, resolveGuestLook } from './resolve'
export { diagnoseBubbleTheme, autoFixBubbleTheme, effectiveBubbleColors } from './diagnose'
export { mutateBubbleTheme, type BubbleMutation, type BubblePreserveGroup } from './mutate'
export { generateBubbleCandidates, compileIntent, type BubbleCandidate } from './generate'
export { BubbleThemeProvider, useBubbleTheme, syncBubbleCompatVars } from './adapter'
export { Bubble, type BubbleTailSide } from './view'
