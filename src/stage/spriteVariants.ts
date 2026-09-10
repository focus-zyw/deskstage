import type { TransitionMode } from './spriteMotion'

export interface SpriteVariant {
  /** public/sprites/{角色目录} 下的文件名（含扩展名） */
  file: string
  /** 相对抽取权重；省略时为 1，非正数候选会被忽略 */
  weight?: number
  /** 本候选被抽中后，在该时长内不再参与抽取 */
  cooldownMs?: number
  /** 姿势轮廓变化大时可覆盖动作的默认切图方式 */
  transitionMode?: TransitionMode
}

/**
 * 每个 CharacterSprite 持有一个选择器，记住各动作最近用过的图片。
 * 随机、冷却和防连播都封装在这里，渲染层只关心最终文件名。
 */
export class SpriteVariantPicker {
  private readonly lastByAction = new Map<string, string>()
  private readonly usedAt = new Map<string, number>()

  pick(
    action: string,
    baseFile: string,
    variants: readonly SpriteVariant[] | undefined,
    now = Date.now(),
    random: () => number = Math.random,
  ): string {
    if (!variants?.length) return baseFile

    const eligible = variants.filter((variant) => {
      if (!variant.file || !Number.isFinite(variant.weight ?? 1) || (variant.weight ?? 1) <= 0) {
        return false
      }
      const lastUsed = this.usedAt.get(`${action}:${variant.file}`)
      return lastUsed === undefined || now - lastUsed >= Math.max(0, variant.cooldownMs ?? 0)
    })
    if (!eligible.length) return baseFile

    const last = this.lastByAction.get(action)
    const withoutRepeatedVariant = eligible.filter(
      (variant) => variant.file === baseFile || variant.file !== last,
    )
    const pool = withoutRepeatedVariant.length ? withoutRepeatedVariant : eligible
    const totalWeight = pool.reduce((sum, variant) => sum + (variant.weight ?? 1), 0)
    let cursor = Math.min(Math.max(random(), 0), 0.999999999999) * totalWeight
    let selected = pool[pool.length - 1]
    for (const variant of pool) {
      cursor -= variant.weight ?? 1
      if (cursor < 0) {
        selected = variant
        break
      }
    }

    this.lastByAction.set(action, selected.file)
    this.usedAt.set(`${action}:${selected.file}`, now)
    return selected.file
  }
}
