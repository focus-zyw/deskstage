// 注:本文件依赖 vite 插件内联 mock @tauri-apps/* 等模块,保留 vite 自举;
// scripts/run-tests.mjs 按含 "from 'vite'" 自动分流,勿改为直接 import(会丢 mock)。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let initPointerManager
let registerHitRegion
let setWindowNoActivate

before(async () => {
  globalThis.__pointerWindowMock = {
    noActivate: true,
    calls: [],
    listeners: new Map(),
    window: {
      async setIgnoreCursorEvents(ignore) {
        globalThis.__pointerWindowMock.calls.push(`ignore:${ignore}`)
        // Windows/Tauri 的穿透切换会重写扩展窗口样式，NOACTIVATE 随之丢失。
        globalThis.__pointerWindowMock.noActivate = false
      },
      async outerPosition() {
        return { x: 0, y: 0 }
      },
      async show() {},
      async onMoved() {},
      async onScaleChanged() {},
    },
    async invoke(command, args) {
      globalThis.__pointerWindowMock.calls.push(`${command}:${args.enable}`)
      if (command === 'set_noactivate') globalThis.__pointerWindowMock.noActivate = args.enable
    },
    async listen(event, handler) {
      globalThis.__pointerWindowMock.listeners.set(event, handler)
      return () => globalThis.__pointerWindowMock.listeners.delete(event)
    },
  }

  server = await createServer({
    appType: 'custom',
    logLevel: 'silent',
    server: { watch: { ignored: ['**/temp/**', '**/tmp/**'] } },
    ssr: { noExternal: ['@tauri-apps/api'] },
    plugins: [
      {
        name: 'pointer-window-mocks',
        enforce: 'pre',
        resolveId(id) {
          if (id === '@tauri-apps/api/window') return '\0mock-tauri-window'
          if (id === '@tauri-apps/api/event') return '\0mock-tauri-event'
          if (id === '@tauri-apps/api/core') return '\0mock-tauri-core'
        },
        load(id) {
          if (id === '\0mock-tauri-window') {
            return `
              export const getCurrentWindow = () => globalThis.__pointerWindowMock.window
              export const currentMonitor = async () => null
              export class LogicalSize {}
              export class LogicalPosition {}
            `
          }
          if (id === '\0mock-tauri-event') {
            return 'export const listen = (event, handler) => globalThis.__pointerWindowMock.listen(event, handler)'
          }
          if (id === '\0mock-tauri-core') {
            return 'export const invoke = (command, args) => globalThis.__pointerWindowMock.invoke(command, args)'
          }
        },
      },
    ],
  })
  ;({ initPointerManager, registerHitRegion, setWindowNoActivate } =
    await server.ssrLoadModule('/src/input/pointerManager.ts'))
})

after(async () => {
  delete globalThis.__pointerWindowMock
  await server?.close()
})

test('从输入面板移到角色后恢复 NOACTIVATE，点击不能抢走视频焦点', async () => {
  registerHitRegion('char-test', {
    getRect: () => ({ left: 0, top: 0, right: 20, bottom: 20 }),
  })
  await initPointerManager()

  // 模拟刚从需要键盘输入的面板离开；角色热区必须把策略切回不激活。
  setWindowNoActivate(false)
  await new Promise((resolve) => setTimeout(resolve, 0))
  globalThis.__pointerWindowMock.calls.length = 0
  globalThis.__pointerWindowMock.listeners.get('cursor-pos')({ payload: [10, 10] })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.deepEqual(globalThis.__pointerWindowMock.calls, [
    'set_noactivate:true',
    'ignore:false',
    'set_noactivate:true',
  ])
  assert.equal(globalThis.__pointerWindowMock.noActivate, true)
})
