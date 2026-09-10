// 道具注册表:礼物道具与工具卡片共用一张表(仿 spriteSets 模式)。
// 素材位于 public/props/{id}.svg(128×128 扁平卡通风,统一描边 #2a2a35)。
// 展示参数按用途各配:礼物道具偏大偏久,工具卡随任务状态流转(生命周期由桥控制)。

export type PropId =
  | 'coffee'
  | 'milk-tea'
  | 'microphone'
  | 'magnifier'
  | 'translation-card'
  | 'document'
  | 'question'
  | 'success'

export type PropCategory = 'gift' | 'utility'

export interface PropDef {
  id: PropId
  label: string
  category: PropCategory
  /** 逻辑像素显示边长(SVG 等比缩放) */
  size: number
  /** 默认展示时长;sticky 常驻道具不走这个默认 */
  durationMs: number
}

export const PROPS: Record<PropId, PropDef> = {
  coffee: { id: 'coffee', label: '咖啡', category: 'gift', size: 64, durationMs: 4200 },
  'milk-tea': { id: 'milk-tea', label: '珍珠奶茶', category: 'gift', size: 64, durationMs: 4200 },
  microphone: { id: 'microphone', label: '话筒', category: 'gift', size: 68, durationMs: 4800 },
  magnifier: { id: 'magnifier', label: '放大镜', category: 'utility', size: 56, durationMs: 4000 },
  'translation-card': { id: 'translation-card', label: '翻译卡片', category: 'utility', size: 60, durationMs: 4000 },
  document: { id: 'document', label: '文档', category: 'utility', size: 56, durationMs: 4000 },
  question: { id: 'question', label: '疑问', category: 'utility', size: 52, durationMs: 3600 },
  success: { id: 'success', label: '成功', category: 'utility', size: 52, durationMs: 3400 },
}

export function propSrc(id: PropId): string {
  return `${import.meta.env.BASE_URL}props/${id}.svg`
}

/** 启动预热全部道具图,首次礼物/工具流程不闪(与 preloadSprites 同批调用) */
export function preloadProps(): void {
  for (const id of Object.keys(PROPS) as PropId[]) {
    const img = new Image()
    img.src = propSrc(id)
  }
}
