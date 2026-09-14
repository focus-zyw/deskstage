// 模板目录的列表视图:工坊模板画廊/材质下拉的数据源。
// 只暴露展示所需字段,模板默认值等实现细节留在目录内部(改稿须经 mutate)。
import { BUBBLE_TEMPLATES } from './catalog'
import type { BubbleMaterialId, BubbleTemplateId } from './types'

export interface BubbleTemplateSummary {
  id: BubbleTemplateId
  label: string
  desc: string
  materials: BubbleMaterialId[]
  defaultMaterial: BubbleMaterialId
}

export function listBubbleTemplates(): BubbleTemplateSummary[] {
  return Object.values(BUBBLE_TEMPLATES).map(({ id, label, desc, materials, defaultMaterial }) => ({
    id,
    label,
    desc,
    materials,
    defaultMaterial,
  }))
}
