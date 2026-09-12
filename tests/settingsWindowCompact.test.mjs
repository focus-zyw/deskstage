import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let setSettingsWindowCompact

before(async () => {
  globalThis.__settingsWindowMock = {
    calls: [],
    window: {
      async setIgnoreCursorEvents(ignore) {
        globalThis.__settingsWindowMock.calls.push(['ignore', ignore])
      },
      async setSize(size) {
        globalThis.__settingsWindowMock.calls.push(['size', size.width, size.height])
      },
      async setPosition(position) {
        globalThis.__settingsWindowMock.calls.push(['position', position.x, position.y])
      },
      async outerPosition() {
        return { x: 0, y: 0 }
      },
    },
    monitor: {
      scaleFactor: 1,
      position: { x: 0, y: 0 },
      size: { width: 1920, height: 1080 },
    },
  }

  server = await createServer({
    appType: 'custom',
    logLevel: 'silent',
    server: { watch: { ignored: ['**/temp/**', '**/tmp/**'] } },
    ssr: { noExternal: ['@tauri-apps/api'] },
    plugins: [
      {
        name: 'settings-window-mocks',
        enforce: 'pre',
        resolveId(id) {
          if (id === '@tauri-apps/api/window') return '\0mock-tauri-window'
          if (id === '@tauri-apps/api/dpi') return '\0mock-tauri-dpi'
          if (id === '@tauri-apps/api/event') return '\0mock-tauri-event'
          if (id === '@tauri-apps/api/core') return '\0mock-tauri-core'
        },
        load(id) {
          if (id === '\0mock-tauri-window') {
            return `
              export const getCurrentWindow = () => globalThis.__settingsWindowMock.window
              export const currentMonitor = async () => globalThis.__settingsWindowMock.monitor
            `
          }
          if (id === '\0mock-tauri-dpi') {
            return `
              export class LogicalSize { constructor(width, height) { this.width = width; this.height = height } }
              export class LogicalPosition { constructor(x, y) { this.x = x; this.y = y } }
            `
          }
          if (id === '\0mock-tauri-event') return 'export const listen = async () => () => {}'
          if (id === '\0mock-tauri-core') return 'export const invoke = async () => {}'
        },
      },
    ],
  })
  ;({ setSettingsWindowCompact } = await server.ssrLoadModule('/src/input/pointerManager.ts'))
})

after(async () => {
  delete globalThis.__settingsWindowMock
  await server?.close()
})

test('打开设置前先保持穿透，再把透明窗口缩到设置面板大小并居中', async () => {
  assert.equal(typeof setSettingsWindowCompact, 'function')

  await setSettingsWindowCompact(true)

  assert.deepEqual(globalThis.__settingsWindowMock.calls, [
    ['ignore', true],
    ['size', 720, 740],
    ['position', 600, 170],
  ])
})

test('关闭设置后恢复全屏覆盖层', async () => {
  globalThis.__settingsWindowMock.calls.length = 0

  await setSettingsWindowCompact(false)

  assert.deepEqual(globalThis.__settingsWindowMock.calls, [
    ['position', 0, 0],
    ['size', 1920, 1080],
  ])
})
