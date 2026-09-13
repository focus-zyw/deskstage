// 右键点播菜单的跨层契约回归:Rust 钩子拦截区域右键(带 button 字段)
// → pointerManager 对右键不合成 pointer 事件、松手时补发 contextmenu
// → React 在 C 的 .actor 上 onContextMenu 弹菜单、A/B 仅拦截默认菜单。
// 任何一环缺失,穿透窗口下的右键要么穿透到底层应用,要么误启动拖拽。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

/** 读源码并统一为 LF:契约断言只关心结构,不随 git 换行符配置(Windows CRLF)漂移 */
async function readSrc(rel) {
  return (await readFile(new URL(rel, import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
}

/** 从 startIdx 指向的 '{' 起做花括号配平,返回整块文本;不配平返回空串。
 *  契约测试用它提取代码块——按缩进(`\n  }`)截取会被排版变化打断,
 *  曾把正确的右键分支误报成功能回归 */
function extractBracedBlock(src, startIdx) {
  if (startIdx < 0 || src[startIdx] !== '{') return ''
  let depth = 0
  for (let i = startIdx; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(startIdx, i + 1)
    }
  }
  return ''
}

test('Rust 钩子拦截区域内右键并携带 button 字段', async () => {
  const src = await readSrc('../src-tauri/src/pointer_hook.rs')
  // 事件结构带 button 字段(0=左,2=右)
  assert.match(src, /button:\s*u8/, 'NativePointerEvent 应携带 button 字段')
  // 右键按下/松开分支独立捕获,不干扰左键拖拽
  assert.match(src, /WM_RBUTTONDOWN/, '缺少右键按下分支')
  assert.match(src, /WM_RBUTTONUP/, '缺少右键松开分支')
  assert.match(src, /right_captured_id/, '右键捕获应独立于左键 captured_id')
})

test('pointerManager 右键不合成 pointer 事件,松手补发 contextmenu', async () => {
  const src = await readSrc('../src/input/pointerManager.ts')
  assert.match(src, /payload\.button === 2/, '应按 button 区分右键分支')
  // 右键分支内不得走 dispatchNativePointer(右键绝不能启动拖拽手势)
  const branchStart = src.indexOf('if (payload.button === 2)')
  assert.ok(branchStart >= 0, '应存在独立的右键处理分支')
  const rightBranch = extractBracedBlock(src, src.indexOf('{', branchStart))
  assert.ok(rightBranch, '右键分支花括号应配平')
  assert.doesNotMatch(rightBranch, /dispatchNativePointer/, '右键不得合成 pointerdown/up(会误触发拖拽)')
  assert.match(rightBranch, /contextmenu/, '右键松开应补发 contextmenu 事件')
  // 面板打开/竞态残留时右键捕获一并清除
  assert.match(src, /rightCapture = null/, 'setPanelsOpen 应清掉右键捕获残留')
})

test('只有角色C弹点播菜单,甲乙右键仅拦截默认菜单', async () => {
  const src = await readSrc('../src/App.tsx')
  // C 的 contextmenu 打开菜单(openCMenu)
  const cBlock = src.match(/onPointerDown=\{\(e\) => onCharPointerDown\(e, 'C'\)\}[\s\S]*?onContextMenu=\{[\s\S]*?\}\}/)?.[0] ?? ''
  assert.ok(cBlock, 'C 的 actor 应有 contextmenu 处理')
  assert.match(cBlock, /openCMenu/, 'C 右键应打开点播菜单')
  // A/B 仅 preventDefault
  const preventCount = (src.match(/onContextMenu=\{\(e\) => e\.preventDefault\(\)\}/g) ?? []).length
  assert.ok(preventCount >= 2, '甲乙的右键应只拦截默认菜单')
  // 菜单是轻交互浮层:六个点播项齐备
  for (const item of ['讲个笑话', '睡午觉', '干点活', '跳个舞', '来个绝活', '投喂零食']) {
    assert.match(src, new RegExp(item), `菜单缺少「${item}」`)
  }
})

test('舞台 pointerdown 收起C菜单时必须放行菜单项内部点击', async () => {
  // 真实点击 = pointerdown 先于 click;若 pointerdown 就卸载菜单,
  // 原生钩子补发的 click 落在游离节点上,onClick 不触发(菜单关了、动作没了)
  const src = await readSrc('../src/App.tsx')
  const stageHandler = src.match(/onPointerDown=\{\(e\) => \{[\s\S]*?\n      \}\}/)?.[0] ?? ''
  assert.ok(stageHandler, '应存在舞台级 pointerdown 处理')
  assert.match(stageHandler, /cMenuOpen/, 'C 菜单打开时点外部应收起')
  assert.match(
    stageHandler,
    /cMenuRef\.current\.contains/,
    '点在菜单项上必须放行,不能提前卸载菜单',
  )
})
