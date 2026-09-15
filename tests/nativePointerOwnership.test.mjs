// 原生指针归属校正回归:角色矩形与浮层菜单矩形重叠时,Rust 钩子按"先注册者优先"
// 会把点击判给角色——合成目标必须按 DOM(elementFromPoint)归属校正,
// 否则点右键菜单项会误触"角色戳"、角色间重叠区互相截胡。
// 复用 compositing 测试的 Tauri mock 思路,另加 elementFromPoint/事件类桩。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let initPointerManager
let registerHitRegion
let originalNavigator
let originalDocument

/** 最小 DOM 元素桩:contains 按 children 递归;dispatchEvent 只记账 */
function makeEl(name, children = []) {
  const el = {
    name,
    children,
    events: [],
    contains(t) {
      if (t === el) return true
      return children.some((c) => {
        try {
          return c.contains(t)
        } catch {
          return false
        }
      })
    },
    dispatchEvent(ev) {
      el.events.push({ type: ev.type, x: ev.clientX, y: ev.clientY })
    },
  }
  return el
}

before(async () => {
  originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: 'Windows test webview' },
  })
  // node 无事件/文档类:pointerManager 合成 PointerEvent/MouseEvent、读 elementFromPoint
  class FakeEvent {
    constructor(type, init = {}) {
      this.type = type
      this.clientX = init.clientX ?? 0
      this.clientY = init.clientY ?? 0
      this.button = init.button ?? 0
      this.buttons = init.buttons ?? 0
    }
  }
  globalThis.PointerEvent = FakeEvent
  globalThis.MouseEvent = FakeEvent
  globalThis.HTMLButtonElement = class HTMLButtonElement {}
  globalThis.__nativePointerOwnership = {
    /** elementFromPoint 的可编程应答(x,y → 元素) */
    hitAt: () => null,
    calls: [],
    listeners: new Map(),
    window: {
      async setIgnoreCursorEvents() {},
      async outerPosition() {
        return { x: 0, y: 0 }
      },
      async show() {},
      async onMoved() {},
      async onScaleChanged() {},
    },
    async invoke() {},
    async listen(event, handler) {
      globalThis.__nativePointerOwnership.listeners.set(event, handler)
      return () => globalThis.__nativePointerOwnership.listeners.delete(event)
    },
  }
  globalThis.__nativePointerOwnership.document = {
    elementFromPoint(x, y) {
      globalThis.__nativePointerOwnership.lastHit = { x, y }
      return globalThis.__nativePointerOwnership.hitAt(x, y)
    },
  }
  originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: globalThis.__nativePointerOwnership.document,
  })

  server = await createServer({
    appType: 'custom',
    logLevel: 'silent',
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
              export const getCurrentWindow = () => globalThis.__nativePointerOwnership.window
              export const currentMonitor = async () => null
              export class LogicalSize {}
              export class LogicalPosition {}
            `
          }
          if (id === '\0mock-tauri-event') {
            return 'export const listen = (event, handler) => globalThis.__nativePointerOwnership.listen(event, handler)'
          }
          if (id === '\0mock-tauri-core') {
            return 'export const invoke = (command, args) => globalThis.__nativePointerOwnership.invoke(command, args)'
          }
        },
      },
    ],
  })
  ;({ initPointerManager, registerHitRegion } =
    await server.ssrLoadModule('/src/input/pointerManager.ts'))
  await initPointerManager()
})

after(async () => {
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
  else delete globalThis.navigator
  delete globalThis.PointerEvent
  delete globalThis.MouseEvent
  delete globalThis.HTMLButtonElement
  delete globalThis.__nativePointerOwnership
  await server?.close()
})

function emitNative(payload) {
  globalThis.__nativePointerOwnership.listeners.get('native-pointer')({ payload })
}

test('重叠矩形:点击判给角色但 DOM 归属是菜单项,合成 click 必须落在菜单项上', () => {
  const actor = makeEl('actorA')
  const menu = makeEl('cMenu', [makeEl('menuItem')])
  const menuItem = menu.children[0]
  const registered = new Map()
  const register = (id, root) => {
    registered.set(id, root)
    registerHitRegion(id, {
      getRect: () => ({ left: 0, top: 0, right: 400, bottom: 400 }),
      nativePointerTarget: () => root,
    })
  }
  // 注册顺序 = 真实场景:角色(charA)先注册,右键菜单(c-menu)后注册;矩形 400×400 完全重叠
  register('charA', actor)
  register('c-menu', menu)

  // 点击坐标处的真实元素是菜单项(Rust 矩形判定却落在先注册的 charA 上)
  globalThis.__nativePointerOwnership.hitAt = (x, y) => (x === 200 && y === 200 ? menuItem : null)

  emitNative({ kind: 'down', id: 'charA', x: 200, y: 200, deltaY: 0, button: 0 })
  emitNative({ kind: 'up', id: 'charA', x: 200, y: 200, deltaY: 0, button: 0 })

  assert.ok(menuItem.events.some((e) => e.type === 'click'), '菜单项应收到合成 click')
  assert.ok(!actor.events.some((e) => e.type === 'click'), '角色不应再收到 click(不误触角色戳)')
})

test('up 的 id 来自 Rust 矩形判定,与 down 的 DOM 归属不同也不得丢弃合成', () => {
  const actor = makeEl('actorB')
  const menu = makeEl('menuB', [makeEl('itemB')])
  const item = menu.children[0]
  registerHitRegion('charB-up', {
    getRect: () => ({ left: 0, top: 0, right: 400, bottom: 400 }),
    nativePointerTarget: () => actor,
  })
  registerHitRegion('menuB-up', {
    getRect: () => ({ left: 0, top: 0, right: 400, bottom: 400 }),
    nativePointerTarget: () => menu,
  })
  globalThis.__nativePointerOwnership.hitAt = (x, y) => (x === 100 && y === 100 ? item : null)

  // down 的 Rust 判定是角色矩形,up 的判定是菜单矩形——归属以 DOM 为准,click 必须补发
  emitNative({ kind: 'down', id: 'charB-up', x: 100, y: 100, deltaY: 0, button: 0 })
  emitNative({ kind: 'up', id: 'menuB-up', x: 100, y: 100, deltaY: 0, button: 0 })

  assert.ok(item.events.some((e) => e.type === 'click'))
})

test('无归属偏差时不改变原行为:点击角色立绘照常戳角色', () => {
  const actor = makeEl('actorC', [makeEl('sprite')])
  const sprite = actor.children[0]
  registerHitRegion('charC-owned', {
    getRect: () => ({ left: 0, top: 0, right: 400, bottom: 400 }),
    nativePointerTarget: () => actor,
  })
  globalThis.__nativePointerOwnership.hitAt = (x, y) => (x === 50 && y === 50 ? sprite : null)

  emitNative({ kind: 'down', id: 'charC-owned', x: 50, y: 50, deltaY: 0, button: 0 })
  emitNative({ kind: 'up', id: 'charC-owned', x: 50, y: 50, deltaY: 0, button: 0 })

  assert.ok(sprite.events.some((e) => e.type === 'click'))
  assert.ok(!sprite.events.some((e) => e.type === 'pointermove'))
})

test('elementFromPoint 无命中时维持原有回落语义:派发到 Rust 判定区域的 root', () => {
  const actor = makeEl('actorD')
  registerHitRegion('charD', {
    getRect: () => ({ left: 0, top: 0, right: 400, bottom: 400 }),
    nativePointerTarget: () => actor,
  })
  globalThis.__nativePointerOwnership.hitAt = () => null

  emitNative({ kind: 'down', id: 'charD', x: 999, y: 999, deltaY: 0, button: 0 })
  emitNative({ kind: 'up', id: 'charD', x: 999, y: 999, deltaY: 0, button: 0 })

  // 无命中(全屏 WebView 下几乎不会发生)保持旧行为:回落 root,不在本次修复范围
  assert.ok(actor.events.some((e) => e.type === 'click'))
})
