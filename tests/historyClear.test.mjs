// 「清空未收藏」跨全部日文件一次到底(不是分页清)的回归:
// 收藏集(含收藏库幽灵集)一律保留,非收藏集跨文件删净、删空的文件整个移除;
// historyStats 统计含幽灵集。Tauri IPC 面 mock(plugin:fs 内存文件表 / plugin:path
// 本地拼串),走真实 historyStore 代码路径,不碰真实磁盘。
import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'

let history

const BASE = 'C:/mock/data'
const HIST_DIR = `${BASE}/data/history`
const files = new Map()

before(async () => {
  // @tauri-apps/api 的 invoke 读 window.__TAURI_INTERNALS__;node 下让 window 指向 globalThis
  globalThis.window = globalThis
  globalThis.__TAURI_INTERNALS__ = {
    transformCallback: (cb) => cb,
    metadata: { currentWindow: { label: 'main' } },
    invoke: (cmd, args = {}, meta) => mockInvoke(cmd, args, meta),
  }
  history = await import('../src/storage/historyStore.ts')
})

function mockInvoke(cmd, args, meta) {
  const arg = args ?? {}
  if (cmd === 'plugin:path|resolve_directory') return BASE
  if (cmd === 'plugin:path|join') return (arg.paths ?? []).filter((x) => typeof x === 'string').join('/')
  const pathOf = () => {
    const hp = meta?.headers?.path
    if (hp !== undefined) return decodeURIComponent(hp)
    return String(arg.path ?? '')
  }
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  if (cmd === 'plugin:fs|write_text_file') {
    const opts = meta?.headers?.options ? JSON.parse(meta.headers.options) : {}
    const text = decoder.decode(Uint8Array.from(args ?? []))
    files.set(pathOf(), (opts.append === true ? (files.get(pathOf()) ?? '') : '') + text)
    return null
  }
  if (cmd === 'plugin:fs|read_text_file') return [...encoder.encode(files.get(pathOf()) ?? '')]
  if (cmd === 'plugin:fs|exists') return files.has(pathOf())
  if (cmd === 'plugin:fs|remove') {
    files.delete(pathOf())
    return null
  }
  if (cmd === 'plugin:fs|mkdir') return null
  if (cmd === 'plugin:fs|read_dir') {
    const dir = pathOf()
    return [...files.keys()]
      .filter((k) => k.startsWith(dir + '/'))
      .map((k) => ({ name: k.slice(dir.length + 1), isFile: true, isDirectory: false, isSymlink: false }))
  }
  return null
}

const jsonl = (entries) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
const entry = (ts, text, eid) => ({ ts, mode: 'daily', speaker: 'A', text, action: '', ...(eid ? { eid } : {}) })

after(async () => {
  delete globalThis.__TAURI_INTERNALS__
  delete globalThis.window
})

test('清空未收藏:跨文件删净非收藏集,收藏集保留,删空的文件整个移除', async () => {
  files.clear()
  files.set(`${HIST_DIR}/a.jsonl`, jsonl([entry(100, '收藏第一句'), entry(100, '收藏第二句'), entry(150, '未收藏甲')]))
  files.set(`${HIST_DIR}/b.jsonl`, jsonl([entry(300, '未收藏乙一', 'eA'), entry(300, '未收藏乙二', 'eA')]))
  files.set(`${HIST_DIR}/c.jsonl`, jsonl([entry(400, '整文件都是未收藏')]))
  files.set(`${BASE}/data/favorites.json`, JSON.stringify([{ ts: 100, mode: 'daily', lines: [{ speaker: 'A', text: '收藏第一句', action: '' }, { speaker: 'A', text: '收藏第二句', action: '' }] }]))

  const { removed, eids } = await history.clearUnfavoritedEpisodes()

  assert.equal(removed, 3, '删 3 集:ts150 / eA(两行一集)/ ts400')
  assert.deepEqual([...eids].sort(), ['eA'])
  // a.jsonl 只剩收藏集的两行
  const a = JSON.parse(`[${files.get(`${HIST_DIR}/a.jsonl`).trim().split('\n').join(',')}]`)
  assert.equal(a.length, 2)
  assert.ok(a.every((e) => e.ts === 100))
  // 删空的文件整个移除(b 全部非收藏 / c 全部非收藏)
  assert.equal(files.has(`${HIST_DIR}/b.jsonl`), false, '全非收藏的日文件应被移除')
  assert.equal(files.has(`${HIST_DIR}/c.jsonl`), false, '全非收藏的日文件应被移除')
  // 列表只剩收藏集
  const eps = await history.listEpisodes()
  assert.equal(eps.length, 1)
  assert.equal(eps[0].fav, true)
  assert.equal(eps[0].lines.length, 2)
})

test('historyStats:total 含收藏幽灵集,unfavorited 只数可清的', async () => {
  files.clear()
  files.set(`${HIST_DIR}/a.jsonl`, jsonl([entry(100, '收藏集'), entry(200, '未收藏一'), entry(300, '未收藏二')]))
  // ts 900 不在历史文件里 = 收藏库幽灵集(仍计入 total)
  const favLine = { speaker: 'A', text: '收藏台词', action: '' }
  files.set(`${BASE}/data/favorites.json`, JSON.stringify([{ ts: 100, mode: 'daily', lines: [favLine] }, { ts: 900, mode: 'daily', lines: [favLine] }]))

  const st = await history.historyStats()
  assert.equal(st.total, 4, '历史 3 集 + 幽灵收藏 1 集')
  assert.equal(st.unfavorited, 2)

  await history.clearUnfavoritedEpisodes()
  const st2 = await history.historyStats()
  assert.equal(st2.total, 2, '清空后只剩两个收藏集(一个实体一个幽灵)')
  assert.equal(st2.unfavorited, 0)
})

test('清空后旧数据(无 eid,按 ts 聚合)的整集全部行都被删掉,不残留断行', async () => {
  files.clear()
  // 旧格式:一集多行共享同一 ts(无 eid)
  files.set(`${HIST_DIR}/a.jsonl`, jsonl([entry(100, '收藏一'), entry(200, '未收藏一'), entry(200, '未收藏二'), entry(200, '未收藏三')]))
  files.set(`${BASE}/data/favorites.json`, JSON.stringify([{ ts: 100, mode: 'daily', lines: [{ speaker: 'A', text: '收藏台词', action: '' }] }]))

  await history.clearUnfavoritedEpisodes()
  const eps = await history.listEpisodes()
  assert.equal(eps.length, 1, '只剩收藏集')
  const a = files.get(`${HIST_DIR}/a.jsonl`).trim().split('\n')
  assert.equal(a.length, 1, '未收藏集的三行必须一行不剩(残留断行 = 聚合出幽灵集)')
})
