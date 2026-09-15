// 桌面工具验收(阶段2):读剪贴板/看桌面两个适配器的门槛路由、参数校验、摘要纯函数,
// 以及注册表接线。执行路径 invoke 打桩不可用,单测覆盖纯函数件——执行体是薄封装。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let m

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  m = {
    registry: await server.ssrLoadModule('/src/tools/registry.ts'),
    readClipboard: await server.ssrLoadModule('/src/tools/adapters/readClipboard.ts'),
    listDesktop: await server.ssrLoadModule('/src/tools/adapters/listDesktopFiles.ts'),
  }
})

after(async () => {
  await server?.close()
})

test('阶段2工具已注册:默认开关方向正确(read 剪贴板默认关,看桌面默认开)', () => {
  const { TOOLS } = m.registry
  assert.equal(TOOLS.read_clipboard.manifest.defaultEnabled, false) // 密码常在剪贴板:默认关
  assert.equal(TOOLS.read_clipboard.manifest.risk, 'read')
  assert.equal(TOOLS.list_desktop_files.manifest.defaultEnabled, true) // 仅元数据,read 惯例默认开
  assert.equal(TOOLS.list_desktop_files.manifest.risk, 'read')
})

test('门槛路由:用户明说剪贴板/桌面才成为候选,闲聊零候选', () => {
  const ctx = { isLive: false, phase: 'idle' }
  const tools = Object.values(m.registry.TOOLS)
  const clip = tools.filter((t) => t.manifest.match('看看我剪贴板里复制的东西', ctx) >= 0.35)
  assert.ok(clip.some((t) => t.manifest.id === 'read_clipboard'))
  const desk = tools.filter((t) => t.manifest.match('帮我看下桌面上有什么文件', ctx) >= 0.35)
  assert.ok(desk.some((t) => t.manifest.id === 'list_desktop_files'))
  // 明确命令级话术可直达(无必填参数)
  assert.ok(tools.find((t) => t.manifest.id === 'read_clipboard').manifest.match('读一下剪贴板', ctx) >= 0.7)
  // 闲聊不打扰
  const none = tools.filter((t) => t.manifest.match('今天天气不错啊', ctx) >= 0.35)
  assert.deepEqual(none, [])
})

test('参数校验:无参工具对任意输入清洗通过,未知键丢弃', () => {
  const clip = m.readClipboard.readClipboardTool
  const ok = clip.validate({ evil: 'x' })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.value, {})
  const desk = m.listDesktop.listDesktopFilesTool
  assert.equal(desk.validate(null).ok, true)
})

test('桌面摘要纯函数:空桌面/数量概览/最近三件', () => {
  const sum = m.listDesktop.summarizeDesktopFiles
  assert.equal(sum([]), '桌面上一张纸都没有,挺整洁')
  const files = [
    { name: '方案.docx', sizeBytes: 100, modifiedMs: 3 },
    { name: '截图.png', sizeBytes: 200, modifiedMs: 2 },
    { name: '合同.pdf', sizeBytes: 300, modifiedMs: 1 },
    { name: '备份', isDir: true, modifiedMs: 0 },
  ]
  const s = sum(files)
  assert.match(s, /共 4 个文件/)
  assert.match(s, /「方案\.docx」/)
  assert.match(s, /「截图\.png」/)
  assert.ok(!s.includes('备份')) // 只展示最近 3 件
})

// ---------- 阶段3:确定性操作 ----------

test('阶段3操作工具已注册:全部 external 且默认关(确认卡兜底)', () => {
  const { TOOLS } = m.registry
  const ops = ['open_target', 'run_app', 'media_control', 'set_volume', 'window_action', 'send_notification']
  for (const id of ops) {
    assert.ok(TOOLS[id], `${id} 应已注册`)
    assert.equal(TOOLS[id].manifest.risk, 'external', `${id} 应为 external`)
    assert.equal(TOOLS[id].manifest.defaultEnabled, false, `${id} 应默认关`)
  }
})

test('open_target 校验:http(s) 网址可开,可执行扩展拒,未知类型拒', () => {
  const v = m.registry.TOOLS.open_target.validate
  assert.equal(v({ kind: 'url', target: 'https://bilibili.com' }).ok, true)
  assert.equal(v({ kind: 'url', target: 'ftp://x' }).ok, false)
  assert.equal(v({ kind: 'path', target: 'C:\\日记\\report.docx' }).ok, true)
  assert.equal(v({ kind: 'path', target: 'C:\\游戏\\game.lnk' }).ok, true) // .lnk 有意放行,确认卡兜底
  assert.equal(v({ kind: 'path', target: 'C:\\x\\evil.exe' }).ok, false)
  assert.equal(v({ kind: 'path', target: 'C:\\x\\evil.bat' }).ok, false)
  assert.equal(v({ kind: 'path', target: 'C:\\x\\脚本.ps1' }).ok, false)
  assert.equal(v({ kind: 'macro', target: 'x' }).ok, false)
  assert.equal(v({ kind: 'url' }).ok, false) // 缺 target
  // 未知键丢弃:validate 通过的 value 只含 kind/target
  const ok = v({ kind: 'url', target: 'https://a.com', evil: 1 })
  assert.deepEqual(Object.keys(ok.value).sort(), ['kind', 'target'])
})

test('run_app 校验:只认 .exe(裸名或绝对路径),其他一律拒', () => {
  const v = m.registry.TOOLS.run_app.validate
  assert.equal(v({ target: 'notepad.exe' }).ok, true)
  assert.equal(v({ target: 'C:\\Windows\\System32\\calc.exe' }).ok, true)
  assert.equal(v({ target: 'notepad' }).ok, false) // 不带 .exe 不放行
  assert.equal(v({ target: 'C:\\x\\script.bat' }).ok, false)
  assert.equal(v({ target: '..\\evil.exe' }).ok, true) // 路径形态合法;是否可接受由确认卡裁决
})

test('set_volume 校验:0~100;level/mute 至少其一', () => {
  const v = m.registry.TOOLS.set_volume.validate
  assert.equal(v({ level: 30 }).ok, true)
  assert.equal(v({ mute: true }).ok, true)
  assert.equal(v({ level: 30, mute: false }).ok, true)
  assert.equal(v({ level: 101 }).ok, false)
  assert.equal(v({ level: -1 }).ok, false)
  assert.equal(v({}).ok, false)
  assert.equal(v({ evil: 'x' }).ok, false)
})

test('window_action 校验:minimize_others 不带目标,其余必须带目标', () => {
  const v = m.registry.TOOLS.window_action.validate
  assert.equal(v({ action: 'minimize_others' }).ok, true)
  assert.equal(v({ action: 'minimize_others', target: 'wechat' }).ok, false)
  assert.equal(v({ action: 'minimize_app' }).ok, false)
  assert.equal(v({ action: 'minimize_app', target: 'wechat' }).ok, true)
  assert.equal(v({ action: 'focus_app', target: 'msedge' }).ok, true)
  assert.equal(v({ action: 'explode' }).ok, false) // 枚举外拒绝(schema 层)
})

test('send_notification 校验:body 必填,title 截断', () => {
  const v = m.registry.TOOLS.send_notification.validate
  assert.equal(v({ body: '水烧开了' }).ok, true)
  assert.equal(v({ title: '提醒' }).ok, false) // 缺 body
  const ok = v({ title: 'x'.repeat(100), body: '内容' })
  assert.equal(ok.value.title.length, 60)
})

test('阶段3门槛路由:打开/音量/窗口/媒体/通知各归其位,闲聊零候选', () => {
  const ctx = { isLive: false, phase: 'idle' }
  const tools = Object.values(m.registry.TOOLS)
  const has = (text, id) => tools.filter((t) => t.manifest.match(text, ctx) >= 0.35).some((t) => t.manifest.id === id)
  assert.ok(has('帮我打开B站的首页', 'open_target'))
  assert.ok(has('声音太大调小音量', 'set_volume'))
  assert.ok(has('把其他窗口都最小化', 'window_action'))
  assert.ok(has('切到下一首歌', 'media_control'))
  assert.ok(has('弹个通知告诉我开会', 'send_notification'))
  // 闲聊零候选
  assert.deepEqual(tools.filter((t) => t.manifest.match('今天真开心', ctx) >= 0.35), [])
})
