// 注:本文件依赖 vite 插件内联 mock @tauri-apps/* 等模块,保留 vite 自举;
// scripts/run-tests.mjs 按含 "from 'vite'" 自动分流,勿改为直接 import(会丢 mock)。
// 面板打开期间原生热区让位的回归测试:设置窗等 overlay 可见时,角色/按钮的
// 原生热区必须整体退出——钩子数组清空(Rust 不再吞点击/滚轮)、hitTest 跳过
// 原生热区(整窗恢复交互走真实 DOM)。否则"先注册者优先"会让角色热区压过设置窗:
// 点击穿透成戳一戳、滚轮穿透成缩放。关闭面板后一切恢复。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let initPointerManager
let registerHitRegion
let setPanelsOpen

let originalNavigator

before(async () => {
  // nativeRegions 只在 Windows UA 下输出(Node 无 navigator,需 shim)
  originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: 'Windows test webview' },
  })

  globalThis.__panelsMock = {
    calls: [],
    listeners: new Map(),
    window: {
      async setIgnoreCursorEvents(ignore) {
        globalThis.__panelsMock.calls.push(`ignore:${ignore}`)
      },
      async outerPosition() {
        return { x: 0, y: 0 }
      },
      async show() {},
      async onMoved() {},
      async onScaleChanged() {},
    },
    async invoke(command, args) {
      globalThis.__panelsMock.calls.push({ command, args })
    },
    async listen(event, handler) {
      globalThis.__panelsMock.listeners.set(event, handler)
      return () => globalThis.__panelsMock.listeners.delete(event)
    },
  }

  server = await createServer({
    appType: 'custom',
    logLevel: 'silent',
    server: { watch: { ignored: ['**/temp/**', '**/tmp/**'] } },
    ssr: { noExternal: ['@tauri-apps/api'] },
    plugins: [
      {
        name: 'panels-window-mocks',
        enforce: 'pre',
        resolveId(id) {
          if (id === '@tauri-apps/api/window') return '\0mock-tauri-window'
          if (id === '@tauri-apps/api/event') return '\0mock-tauri-event'
          if (id === '@tauri-apps/api/core') return '\0mock-tauri-core'
        },
        load(id) {
          if (id === '\0mock-tauri-window') {
            return `
              export const getCurrentWindow = () => globalThis.__panelsMock.window
              export const currentMonitor = async () => null
              export class LogicalSize {}
              export class LogicalPosition {}
            `
          }
          if (id === '\0mock-tauri-event') {
            return 'export const listen = (event, handler) => globalThis.__panelsMock.listen(event, handler)'
          }
          if (id === '\0mock-tauri-core') {
            return 'export const invoke = (command, args) => globalThis.__panelsMock.invoke(command, args)'
          }
        },
      },
    ],
  })
  ;({ initPointerManager, registerHitRegion, setPanelsOpen } =
    await server.ssrLoadModule('/src/input/pointerManager.ts'))
})

after(async () => {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
  else delete globalThis.navigator
  delete globalThis.__panelsMock
  await server?.close()
})

const nativeRegionsIn = () => {
  const call = globalThis.__panelsMock.calls.filter((c) => c.command === 'set_native_pointer_regions').at(-1)
  return call ? call.args.regions.map((r) => r.id) : null
}

test('面板打开:原生热区从钩子数组清空,hitTest 跳过角色恢复整窗交互', async () => {
  registerHitRegion('char-a', {
    getRect: () => ({ left: 0, top: 0, right: 20, bottom: 20 }),
    nativePointerTarget: () => null,
  })
  registerHitRegion('panel', {
    getRect: () => ({ left: 0, top: 0, right: 100, bottom: 100 }),
  })
  await initPointerManager()

  setPanelsOpen(true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(nativeRegionsIn(), [])

  // 鼠标落在角色与面板重叠处:命中面板(原生热区被跳过)→ 整窗恢复交互
  globalThis.__panelsMock.calls.length = 0
  globalThis.__panelsMock.listeners.get('cursor-pos')({ payload: [10, 10] })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(globalThis.__panelsMock.calls.includes('ignore:false'), '面板区应恢复交互')
})

test('面板关闭:原生热区恢复,角色区域回到钩子接管(整窗穿透)', async () => {
  setPanelsOpen(false)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(nativeRegionsIn(), ['char-a'])

  globalThis.__panelsMock.calls.length = 0
  globalThis.__panelsMock.listeners.get('cursor-pos')({ payload: [10, 10] })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(globalThis.__panelsMock.calls.includes('ignore:true'), '角色区应保持穿透')
})
