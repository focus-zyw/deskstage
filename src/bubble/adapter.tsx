// React/DOM 适配层:主题经 Context 下发,Bubble 组件在自身节点上 resolve;
// 根节点只承担一个兼容职责——同步 --bubble-acc-a/b/c 旧变量名
// (群聊说话人名 App.css、群聊头像 ChatLogSettings 仍按旧名消费)。
import { createContext, useContext, type ReactNode } from 'react'
import { BUILT_IN_BUBBLE_THEMES } from './catalog'
import { deriveEffectivePalette } from './palette'
import type { BubbleThemeV2 } from './types'

const BubbleThemeContext = createContext<BubbleThemeV2>(BUILT_IN_BUBBLE_THEMES.comic)

/** 舞台与工坊预览共用:theme 为空(null/未加载/被删)一律回落内置柔彩 */
export function BubbleThemeProvider({
  theme,
  children,
}: {
  theme: BubbleThemeV2 | null | undefined
  children: ReactNode
}) {
  const value = theme ?? BUILT_IN_BUBBLE_THEMES.comic
  return <BubbleThemeContext.Provider value={value}>{children}</BubbleThemeContext.Provider>
}

export function useBubbleTheme(): BubbleThemeV2 {
  return useContext(BubbleThemeContext)
}

const COMPAT_ACC_VARS = ['--bubble-acc-a', '--bubble-acc-b', '--bubble-acc-c'] as const

/** 根节点兼容变量同步:theme=null 时清掉(不残留上一个主题的取色) */
export function syncBubbleCompatVars(root: HTMLElement, theme: BubbleThemeV2 | null): void {
  for (const v of COMPAT_ACC_VARS) root.style.removeProperty(v)
  if (!theme) return
  const pal = deriveEffectivePalette(theme)
  root.style.setProperty('--bubble-acc-a', pal.acc.A)
  root.style.setProperty('--bubble-acc-b', pal.acc.B)
  root.style.setProperty('--bubble-acc-c', pal.acc.C)
}
