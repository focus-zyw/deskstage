// 聊天 @ 补全:候选匹配与插入点计算(纯函数,QQ/微信式——输入 @ 唤起,随已输文本过滤)。
// DOM/状态归聊天框组件,这里只做可独立测试的判定与文本替换。
import type { Speaker } from '../performer/dialogSchema'

export interface MentionTarget {
  id: Speaker
  name: string
  /** 快捷键字母(A/B/C),输入字母也能过滤 */
  key: string
}

/** 光标前是否存在 @ 语境:紧邻光标的 "@过滤词"(词内不允许空格/@)。
 *  返回 null = 语境已消失(删掉 @、敲了空格),补全面板应关闭 */
export function mentionContext(textBeforeCaret: string): { query: string } | null {
  const m = /@([^@\s]*)$/.exec(textBeforeCaret)
  return m ? { query: m[1] } : null
}

/** 三名角色的候选清单(名字用用户自定义名,缺省回落字母) */
export function mentionTargets(names: Record<Speaker, string>): MentionTarget[] {
  return (['A', 'B', 'C'] as const).map((id) => ({
    id,
    name: names[id]?.trim() || id,
    key: id,
  }))
}

/** 按已输文本过滤:名字包含(不区分大小写)或字母前缀命中;过滤词为空 = 全量 */
export function filterMentionTargets(
  targets: MentionTarget[],
  query: string,
): MentionTarget[] {
  const q = query.trim().toLowerCase()
  if (!q) return targets
  return targets.filter(
    (t) => t.name.toLowerCase().includes(q) || t.key.toLowerCase().startsWith(q),
  )
}

/** 选中候选后的输入框文本:把光标前的 "@过滤词" 替换为 "@全名␣",返回新文本与新光标位 */
export function applyMention(
  text: string,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const m = /@([^@\s]*)$/.exec(text.slice(0, caret))
  const at = m ? caret - m[0].length : caret
  const inserted = `@${name} `
  return {
    text: text.slice(0, at) + inserted + text.slice(caret),
    caret: at + inserted.length,
  }
}
