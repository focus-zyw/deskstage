import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

function animationTimes(css, selector, animationName) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rule = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`))?.[1]
  assert.ok(rule, `缺少 ${selector} 样式`)
  const animation = rule.match(/animation:\s*([^;]+);/)?.[1]
  assert.ok(animation?.startsWith(animationName), `${selector} 未使用 ${animationName}`)
  const times = [...animation.matchAll(/([\d.]+)s\b/g)].map((match) => Number(match[1]) * 1_000)
  return { durationMs: times[0], delayMs: times[1] ?? 0 }
}

test('dip 切图全过程不能出现接近全透明的闪烁帧', () => {
  const css = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8')
  const outgoing = animationTimes(
    css,
    '.transition-dip .char-img.under',
    'sprite-dip-out',
  )
  const incoming = animationTimes(
    css,
    '.transition-dip .char-img.main.ready',
    'sprite-dip-in',
  )
  const endMs = Math.max(outgoing.durationMs, incoming.delayMs + incoming.durationMs)
  let minimumVisibility = 1

  for (let elapsedMs = 0; elapsedMs <= endMs; elapsedMs += 1) {
    const oldOpacity = Math.max(0, 1 - elapsedMs / outgoing.durationMs)
    const newOpacity =
      elapsedMs < incoming.delayMs
        ? 0
        : Math.min(1, (elapsedMs - incoming.delayMs) / incoming.durationMs)
    minimumVisibility = Math.min(minimumVisibility, oldOpacity + newOpacity)
  }

  assert.ok(
    minimumVisibility >= 0.65,
    `dip 过渡最低合成可见度仅 ${minimumVisibility.toFixed(2)}，会产生闪烁空窗`,
  )
})
