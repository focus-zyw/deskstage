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

const VARIANT_COOLDOWN_MS = 45_000
const IDLE_VARIANT_DELAY_MS = 8_000
const RARE_IDLE_COOLDOWN_MS = 180_000

export const SPRITE_SETS: Record<'A' | 'B', SpriteSet> = {
  A: {
    dir: 'sprites/a',
    name: '甲',
    accent: '#3d8bd4', // 便利店店员:蓝黄制服主色
    height: 320,
    actions: [...ART_ACTIONS, ...UTILITY_ACTIONS, 'laugh', 'shy', 'sleepy', 'wave', 'thinking', 'jump'],
    variants: {
      idle: [
        { file: 'idle.png', weight: 1 },
        {
          file: 'idle-look.png',
          weight: 2,
          cooldownMs: 60_000,
          activationDelayMs: IDLE_VARIANT_DELAY_MS,
          holdMs: 3_500,
          transitionMode: 'dip',
        },
        {
          file: 'idle-bag.png',
          weight: 2,
          cooldownMs: 75_000,
          activationDelayMs: IDLE_VARIANT_DELAY_MS,
          holdMs: 4_000,
          transitionMode: 'dip',
        },
        {
          file: 'idle-hair.png',
          weight: 1.5,
          cooldownMs: 60_000,
          activationDelayMs: IDLE_VARIANT_DELAY_MS,
          holdMs: 3_200,
          transitionMode: 'dip',
        },
        {
          file: 'idle-proud.png',
          weight: 0.35,
          cooldownMs: RARE_IDLE_COOLDOWN_MS,
          activationDelayMs: IDLE_VARIANT_DELAY_MS,
          holdMs: 3_000,
          transitionMode: 'dip',
        },
        {
          file: 'idle-stretch.png',
          weight: 0.45,
          cooldownMs: RARE_IDLE_COOLDOWN_MS,
          activationDelayMs: IDLE_VARIANT_DELAY_MS,
          holdMs: 3_500,
          transitionMode: 'dip',
        },
      ],
      talk: [
        { file: 'talk.png', weight: 6 },
        { file: 'talk-point.png', weight: 1, cooldownMs: VARIANT_COOLDOWN_MS, transitionMode: 'dip' },
        { file: 'talk-boast.png', weight: 1, cooldownMs: VARIANT_COOLDOWN_MS, transitionMode: 'dip' },
        { file: 'talk-aside.png', weight: 1, cooldownMs: VARIANT_COOLDOWN_MS, transitionMode: 'dip' },
      ],
      happy: [
        { file: 'happy.png', weight: 6 },
        { file: 'happy-proud.png', weight: 1, cooldownMs: VARIANT_COOLDOWN_MS, transitionMode: 'dip' },
      ],
      angry: [
        { file: 'angry.png', weight: 6 },
        { file: 'angry-pout.png', weight: 1, cooldownMs: VARIANT_COOLDOWN_MS, transitionMode: 'dip' },
      ],
      surprise: [
        { file: 'surprise.png', weight: 6 },
        { file: 'surprise-flustered.png', weight: 1, cooldownMs: VARIANT_COOLDOWN_MS, transitionMode: 'dip' },
      ],
      laugh: [
        { file: 'laugh.png', weight: 8 },
        { file: 'laugh-belly.png', weight: 1, cooldownMs: 60_000, transitionMode: 'dip' },
        { file: 'laugh-clap.png', weight: 1, cooldownMs: 60_000, transitionMode: 'dip' },
        { file: 'laugh-cheer.png', weight: 0.5, cooldownMs: 90_000, transitionMode: 'dip' },
      ],
    },
  },
  B: {
    dir: 'sprites/b',
    name: '乙',
    accent: '#5a6472', // 程序员:深灰蓝主色
    height: 320,
    actions: [...ART_ACTIONS, ...UTILITY_ACTIONS, 'shy', 'laugh', 'sleepy', 'wave', 'thinking', 'jump'],
    variants: {
      idle: [
        { file: 'idle.png', weight: 1 },
        {
          file: 'idle-phone.png',
          weight: 2,
          cooldownMs: 90_000,
          activationDelayMs: IDLE_VARIANT_DELAY_MS,
          holdMs: 4_500,
          transitionMode: 'dip',
        },
        {
          file: 'idle-glasses.png',
          weight: 2,
          cooldownMs: 60_000,
          activationDelayMs: IDLE_VARIANT_DELAY_MS,
          holdMs: 3_000,
          transitionMode: 'dip',
        },
        {
          file: 'idle-headphones.png',
          weight: 1.5,
          cooldownMs: 75_000,
          activationDelayMs: IDLE_VARIANT_DELAY_MS,
          holdMs: 3_500,
          transitionMode: 'dip',
        },
        {
          file: 'idle-pocket.png',
          weight: 1.5,
          cooldownMs: 75_000,
          activationDelayMs: IDLE_VARIANT_DELAY_MS,
          holdMs: 4_000,
          transitionMode: 'dip',
        },
        {
          file: 'idle-yawn.png',
          weight: 0.45,
          cooldownMs: RARE_IDLE_COOLDOWN_MS,
          activationDelayMs: IDLE_VARIANT_DELAY_MS,
          holdMs: 3_200,
          transitionMode: 'dip',
        },
      ],
      talk: [
        { file: 'talk.png', weight: 6 },
        { file: 'talk-explain.png', weight: 1, cooldownMs: VARIANT_COOLDOWN_MS, transitionMode: 'dip' },
        { file: 'talk-deadpan.png', weight: 1, cooldownMs: VARIANT_COOLDOWN_MS, transitionMode: 'dip' },
        { file: 'talk-glasses.png', weight: 1, cooldownMs: VARIANT_COOLDOWN_MS, transitionMode: 'dip' },
      ],
      happy: [
        { file: 'happy.png', weight: 6 },
        { file: 'happy-smirk.png', weight: 1, cooldownMs: VARIANT_COOLDOWN_MS, transitionMode: 'dip' },
      ],
      angry: [
        { file: 'angry.png', weight: 6 },
        { file: 'angry-glare.png', weight: 1, cooldownMs: VARIANT_COOLDOWN_MS, transitionMode: 'dip' },
      ],
      surprise: [
        { file: 'surprise.png', weight: 6 },
        { file: 'surprise-freeze.png', weight: 1, cooldownMs: VARIANT_COOLDOWN_MS, transitionMode: 'dip' },
      ],
      laugh: [
        { file: 'laugh.png', weight: 8 },
        { file: 'laugh-hold.png', weight: 1, cooldownMs: 60_000, transitionMode: 'dip' },
        { file: 'laugh-break.png', weight: 0.75, cooldownMs: 90_000, transitionMode: 'dip' },
        { file: 'laugh-wave.png', weight: 0.5, cooldownMs: 90_000, transitionMode: 'dip' },
      ],
    },
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
