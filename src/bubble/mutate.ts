// 统一改稿接口:UI/AI 的所有"局部修改"都走 mutateBubbleTheme,不直接拼主题对象。
// 职责:换模板时按 preserve 决定哪些组跟随新模板默认值、材质不兼容自动降级、
// 快捷动作(名签更简/阴影更弱/字体更活泼/随机微调)的语义实现。
import { BUBBLE_MATERIAL_DEFAULTS, BUBBLE_TEMPLATES, compatibleMaterial } from './catalog'
import { jitterPalette } from './palette'
import { normalizeBubbleTheme } from './normalize'
import type { BubbleThemeV2 } from './types'

/** retarget-template 时显式保留的组;未列出的组回落新模板默认值 */
export type BubblePreserveGroup = 'palette' | 'typography' | 'layout' | 'effects' | 'nameplate' | 'tail'

export type BubbleMutation =
  | { type: 'retarget-template'; templateId: BubbleThemeV2['templateId']; preserve?: BubblePreserveGroup[] }
  | { type: 'set-material'; materialId: BubbleThemeV2['material']['id'] }
  | { type: 'reset-to-template-defaults' }
  | { type: 'simpler-nameplate' }
  | { type: 'softer-shadow' }
  | { type: 'playful-font' }
  | { type: 'jitter-colors'; amountDeg?: number; rand?: () => number }

const NAMEPLATE_LADDER: Record<BubbleThemeV2['nameplate']['style'], BubbleThemeV2['nameplate']['style']> = {
  badge: 'inline',
  tab: 'inline',
  inline: 'hidden',
  hidden: 'hidden',
}

/** 输入主题已保证 id/label 合法,改稿不碰这两字段,normalize 结果不可能为 null */
function clean(theme: unknown): BubbleThemeV2 {
  const t = normalizeBubbleTheme(theme)
  if (!t) throw new Error('改稿后主题不合法')
  return t
}

/** 对主题应用一个改稿动作;输入输出都是归一化 V2(幂等动作保持幂等) */
export function mutateBubbleTheme(theme: BubbleThemeV2, action: BubbleMutation): BubbleThemeV2 {
  const tpl = BUBBLE_TEMPLATES[theme.templateId]
  switch (action.type) {
    case 'retarget-template': {
      const nextTpl = BUBBLE_TEMPLATES[action.templateId]
      const keep = new Set(action.preserve ?? ['palette'])
      const d = nextTpl.defaults
      const nextMaterial = compatibleMaterial(nextTpl.id, theme.material.id)
      return clean({
        ...theme,
        templateId: nextTpl.id,
        material: {
          // 材质不在新模板白名单时降级为它的默认材质;blur 跟(降级后的)材质默认走
          ...theme.material,
          id: nextMaterial,
          blur: BUBBLE_MATERIAL_DEFAULTS[nextMaterial].blur,
        },
        frame: { radius: d.frame.radius, outlineWidth: keep.has('effects') ? theme.frame.outlineWidth : d.frame.outlineWidth },
        typography: keep.has('typography') ? theme.typography : { ...theme.typography, align: d.typography.align, weight: d.typography.weight, lineHeight: d.typography.lineHeight },
        nameplate: keep.has('nameplate') ? theme.nameplate : d.nameplate,
        tail: keep.has('tail') ? theme.tail : d.tail,
        layout: keep.has('layout') ? theme.layout : d.layout,
        effects: keep.has('effects') ? theme.effects : d.effects,
      })
    }
    case 'set-material': {
      const id = compatibleMaterial(theme.templateId, action.materialId)
      // blur 跟材质默认走(玻璃 14、其余 0):模板默认 blur 多为 0,沿用会让玻璃名存实亡
      return clean({ ...theme, material: { ...theme.material, id, blur: BUBBLE_MATERIAL_DEFAULTS[id].blur } })
    }
    case 'reset-to-template-defaults': {
      const d = tpl.defaults
      return clean({
        ...theme,
        material: { id: tpl.defaultMaterial, opacity: d.material.opacity, blur: d.material.blur },
        frame: d.frame,
        typography: { ...theme.typography, align: d.typography.align, weight: d.typography.weight, lineHeight: d.typography.lineHeight },
        nameplate: d.nameplate,
        tail: d.tail,
        layout: d.layout,
        effects: d.effects,
      })
    }
    case 'simpler-nameplate':
      return clean({ ...theme, nameplate: { ...theme.nameplate, style: NAMEPLATE_LADDER[theme.nameplate.style] } })
    case 'softer-shadow': {
      const shadow = theme.effects.shadow === 'strong' ? 'soft' : theme.effects.shadow === 'soft' ? 'none' : 'none'
      return clean({
        ...theme,
        effects: { ...theme.effects, shadow, glow: Math.round(theme.effects.glow / 2) },
      })
    }
    case 'playful-font': {
      const preset = theme.typography.fontPreset === 'comic' ? 'friendly' : 'comic'
      return clean({
        ...theme,
        typography: { ...theme.typography, fontPreset: preset, weight: Math.min(800, theme.typography.weight + 50) },
      })
    }
    case 'jitter-colors': {
      const rand = action.rand ?? Math.random
      const next = jitterPalette(theme.palette.primary, theme.palette.overrides, action.amountDeg ?? 12, rand)
      return clean({
        ...theme,
        palette: { ...theme.palette, primary: next.primary, overrides: next.overrides },
      })
    }
  }
}
