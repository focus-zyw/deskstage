import type { SpriteVariant } from './spriteVariants'

// 立绘注册表:每个角色的贴图目录、强调色与显示参数。
// 素材位于 public/sprites/{dir}/{action}.png,文件名与动作词表严格一致;
// 同角色各表情必须同画布、头脚对齐(规格见 scripts/gen_placeholder_sprites.py)。

export interface SpriteSet {
  /** 贴图目录(public 下,相对站点根) */
  dir: string
  name: string
  /** 名牌/兜底胶囊强调色 */
  accent: string
  /** 逻辑像素显示高(出图为 2 倍分辨率) */
  height: number
  /** 基线微调(逻辑像素),校正素材留白用 */
  offsetX?: number
  offsetY?: number
  /** 已有贴图的动作;缺图动作运行时回退 idle 图 */
  actions: string[]
  /** 同一语义动作的候选图片；未配置时仍使用 {action}.png */
  variants?: Partial<Record<string, readonly SpriteVariant[]>>
}

// 有独立贴图的六个表情;shake/jump 不出图,复用 idle 图 + CSS 位移动画
export const ART_ACTIONS = ['idle', 'talk', 'happy', 'angry', 'sad', 'surprise'] as const

// 工具任务专用姿势:由 OCR/翻译/提醒等本地流程触发,不加入 LLM 对话动作词表
export const UTILITY_ACTIONS = ['reading', 'present'] as const

export const SPRITE_SETS: Record<'A' | 'B', SpriteSet> = {
  A: {
    dir: 'sprites/a',
    name: '甲',
    accent: '#3d8bd4', // 便利店店员:蓝黄制服主色
    height: 320,
    actions: [...ART_ACTIONS, ...UTILITY_ACTIONS, 'laugh', 'shy', 'sleepy', 'wave', 'thinking', 'jump'],
  },
  B: {
    dir: 'sprites/b',
    name: '乙',
    accent: '#5a6472', // 程序员:深灰蓝主色
    height: 320,
    actions: [...ART_ACTIONS, ...UTILITY_ACTIONS, 'shy', 'laugh', 'sleepy', 'wave', 'thinking', 'jump'],
  },
}

export function spriteFileSrc(set: SpriteSet, file: string): string {
  return `${import.meta.env.BASE_URL}${set.dir}/${file}`
}

export function spriteSrc(set: SpriteSet, action: string): string {
  return spriteFileSrc(set, `${action}.png`)
}

/** 启动预热全部贴图,避免演出中首次切换动作时闪一下 */
export function preloadSprites(sets: SpriteSet[]): void {
  for (const set of sets) {
    for (const action of set.actions) {
      const files = [
        `${action}.png`,
        ...(set.variants?.[action]?.map((variant) => variant.file) ?? []),
      ]
      for (const file of new Set(files)) {
        const img = new Image()
        img.src = spriteFileSrc(set, file)
      }
    }
  }
}
