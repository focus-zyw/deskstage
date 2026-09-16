// 注:本文件依赖 vite 插件内联 mock @tauri-apps/* 等模块,保留 vite 自举;
// scripts/run-tests.mjs 按含 "from 'vite'" 自动分流,勿改为直接 import(会丢 mock)。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let initPointerManager
let registerHitRegion
let originalNavigator

before(async () => {
  originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: 'Windows test webview' },
  })

  globalThis.__nativePointerMock = {
    calls: [],
    listeners: new Map(),
    window: {
      async setIgnoreCursorEvents(ignore) {
        globalThis.__nativePointerMock.calls.push(`ignore:${ignore}`)
      },
      async outerPosition() {
        return { x: 0, y: 0 }
      },
      async show() {},
      async onMoved() {},
      async onScaleChanged() {},
    },
    async invoke(command, args) {
      globalThis.__nativePointerMock.calls.push({ command, args })
    },
    async listen(event, handler) {
      globalThis.__nativePointerMock.listeners.set(event, handler)
      return () => globalThis.__nativePointerMock.listeners.delete(event)
    },
  }

  server = await createServer({
    appType: 'custom',
    logLevel: 'silent',
    server: { watch: { ignored: ['**/temp/**', '**/tmp/**'] } },
    ssr: { noExternal: ['@tauri-apps/api'] },
    plugins: [
      {
        name: 'native-pointer-mocks',
        enforce: 'pre',
        resolveId(id) {
          if (id === '@tauri-apps/api/window') return '\0mock-tauri-window'
          if (id === '@tauri-apps/api/event') return '\0mock-tauri-event'
          if (id === '@tauri-apps/api/core') return '\0mock-tauri-core'
        },
        load(id) {
          if (id === '\0mock-tauri-window') {
            return `
              export const getCurrentWindow = () => globalThis.__nativePointerMock.window
              export const currentMonitor = async () => null
              export class LogicalSize {}
              export class LogicalPosition {}
            `
          }
          if (id === '\0mock-tauri-event') {
            return 'export const listen = (event, handler) => globalThis.__nativePointerMock.listen(event, handler)'
          }
          if (id === '\0mock-tauri-core') {
            return 'export const invoke = (command, args) => globalThis.__nativePointerMock.invoke(command, args)'
          }
        },
      },
    ],
  })
  ;({ initPointerManager, registerHitRegion } =
    await server.ssrLoadModule('/src/input/pointerManager.ts'))
})

after(async () => {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
  else delete globalThis.navigator
  delete globalThis.__nativePointerMock
  await server?.close()
})

test('Windows 角色热区由原生指针接管，WebView 始终保持整窗穿透', async () => {
  registerHitRegion('char-test', {
    getRect: () => ({ left: 0, top: 0, right: 20, bottom: 20 }),
    nativePointerTarget: () => null,
  })
  await initPointerManager()

  globalThis.__nativePointerMock.listeners.get('cursor-pos')({ payload: [10, 10] })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(globalThis.__nativePointerMock.calls.includes('ignore:false'), false)
  assert.ok(
    globalThis.__nativePointerMock.calls.some(
      (call) =>
        call.command === 'set_native_pointer_regions' &&
        call.args.regions.some((region) => region.id === 'char-test'),
    ),
  )
})
