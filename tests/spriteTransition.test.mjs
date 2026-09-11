// 立绘双槽切换回归:任何模式都不能产生接近全透明的闪烁帧。
// 旧引擎用 CSS 动画,这里从 App.css 文本解析时长;新引擎(双槽常驻 + decode 门控)
// 的时长单一事实源在 spriteMotion.SWITCH_MS,测试直接加载常量做合成可见度模拟。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let SWITCH_MS

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  ;({ SWITCH_MS } = await server.ssrLoadModule('/src/stage/spriteMotion.ts'))
})

after(async () => {
  await server?.close()
})

test('crossfade/dip 同步互补淡化:任一时刻合成可见度不低于 0.65', () => {
  for (const mode of ['crossfade', 'dip']) {
    const durationMs = SWITCH_MS[mode]
    assert.ok(durationMs > 0, `${mode} 必须有可见的过渡时长`)
    let minimumVisibility = 1
    for (let elapsedMs = 0; elapsedMs <= durationMs; elapsedMs += 1) {
      // 引擎同帧翻转新旧两槽的 show 标记,透明度互补:old(1-t)+new(t) = 1
      const t = elapsedMs / durationMs
      minimumVisibility = Math.min(minimumVisibility, 1 - t + t)
    }
    assert.ok(
      minimumVisibility >= 0.65,
      `${mode} 过渡最低合成可见度仅 ${minimumVisibility.toFixed(2)}，会产生闪烁空窗`,
    )
  }
})

test('impact 是 0ms 硬切:同帧对调,不存在半透明中间帧', () => {
  assert.equal(SWITCH_MS.impact, 0)
})

test('CSS 接线完好:双槽透明度由 --switch-dur 过渡,show 标记可见槽', () => {
  const css = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8')
  assert.match(css, /\.char-img\s*\{[^}]*opacity:\s*0/)
  assert.match(css, /\.char-img\s*\{[^}]*transition:\s*opacity var\(--switch-dur/)
  assert.match(css, /\.char-img\.show\s*\{[^}]*opacity:\s*1/)
  // 双槽几何:lead 在流,hold 绝对居中
  assert.match(css, /\.char-img\.hold\s*\{[^}]*position:\s*absolute/)
  assert.match(css, /\.char-img\.hold\s*\{[^}]*transform:\s*translateX\(-50%\)/)
  // 起势动画重启位存在(常驻外壳靠它重播 motion-* 动画)
  assert.match(css, /\.char-transition-shell\.motion-off\s*\{[^}]*animation-name:\s*none/)
})
