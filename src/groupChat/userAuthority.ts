// 用户最高优先级(纯函数):停止/转向识别与主回应角色解析。
//
// · 停止词命中 → 运行时 pauseAll(广播暂停、作废在飞、废弃待播),消息本身照常入列
//   留痕;恢复永远由用户新消息开启(新 epoch),不需要任何角色同意。
// · 转向词命中 → epoch 递增:旧 epoch 消息只作背景,旧 epoch 迟到回复在提交区降级丢弃。
//   判词从严(只在用户明确表达"换/停"时触发),不做模糊意图猜测。
// · 主回应角色:@点名(名字/甲乙丙/A B/C)> 甲乙轮换——只决定"最需要回应"的标注与
//   因果链档位,不剥夺任何角色的 speak/listen 自主权(没有导演)。

import type { ActorId } from './types'

/** 停止:立即全员暂停(从严匹配,避免"别说了哈哈"这类玩笑误触) */
export const STOP_RE = /(不要聊了|别聊了别聊了|停止聊天|都别说了|都停下吧|都闭嘴吧)/

/** 转向:明确换方向(epoch 递增,旧迟到回复废弃) */
export const DIRECTION_RE = /(换个话题|换话题吧|别聊这个了|换个话题吧|说点别的吧|换方向)/

export function isStopCommand(text: string): boolean {
  return STOP_RE.test(text)
}

export function isDirectionChange(text: string): boolean {
  return DIRECTION_RE.test(text)
}

/**
 * 主回应角色解析:优先 @ 前缀(配置名/甲乙丙/A B/C),无 @ 时甲乙轮换(C 需显式点名)。
 * rotation 由调用方持有并在返回值里轮转。
 */
export function resolvePrimary(
  text: string,
  names: Record<ActorId, string>,
  rotation: Exclude<ActorId, 'C'>,
): { actor: ActorId; rotation: Exclude<ActorId, 'C'> } {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const targetOf: Record<string, ActorId> = {
    [names.A]: 'A',
    [names.B]: 'B',
    [names.C]: 'C',
    甲: 'A',
    乙: 'B',
    丙: 'C',
    A: 'A',
    B: 'B',
    C: 'C',
  }
  const m = text.match(new RegExp(`^\\s*@?(${esc(names.A)}|${esc(names.B)}|${esc(names.C)}|甲|乙|丙|A|B|C)\\s*`))
  if (m) return { actor: targetOf[m[1]] ?? 'A', rotation }
  const next = rotation === 'A' ? 'B' : 'A'
  return { actor: next, rotation: next }
}
