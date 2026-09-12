// 视频工坊回归:三家适配器的请求构造与状态映射(mock 全局 fetch,不碰网络)、
// promptComposer 的剧本轻适配转译(注入 mock complete)、错误分类、
// videoStore 任务清洗与 configStore.videoGen 清洗。
// 沿用仓库测试原则:vite ssrLoadModule 加载 TS 源,不碰磁盘(localStorage 天然未启用)。
import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'
import { createServer } from 'vite'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

let server
let ark
let minimax
let zhipu
let index
let composer
let store
let configStore
let videoTab
let favoritesTab
let session

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  ark = await server.ssrLoadModule('/src/engine/videoGen/ark.ts')
  minimax = await server.ssrLoadModule('/src/engine/videoGen/minimax.ts')
  zhipu = await server.ssrLoadModule('/src/engine/videoGen/zhipu.ts')
  index = await server.ssrLoadModule('/src/engine/videoGen/index.ts')
  composer = await server.ssrLoadModule('/src/engine/videoGen/promptComposer.ts')
  store = await server.ssrLoadModule('/src/storage/videoStore.ts')
  configStore = await server.ssrLoadModule('/src/storage/configStore.ts')
  videoTab = await server.ssrLoadModule('/src/settings/tabs/VideoSettings.tsx')
  favoritesTab = await server.ssrLoadModule('/src/settings/tabs/FavoritesSettings.tsx')
  session = await server.ssrLoadModule('/src/settings/useSettingsSession.ts')
})

after(async () => {
  await server?.close()
})

// ---------- fetch 桩:引擎在非 Tauri 环境走原生 fetch,替换全局即可拦截 ----------

let realFetch

/** 拦截全局 fetch,记录调用并按 handler(url, init) 应答 */
function useFetch(handler) {
  realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => handler(String(url), init)
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

afterEach(() => {
  if (realFetch) {
    globalThis.fetch = realFetch
    realFetch = undefined
  }
})

// ---------- 即梦 / 火山方舟(ark) ----------

const ARK_BASE = 'https://ark.cn-beijing.volces.com/api/v3'
const ARK_CREDS = { apiKey: 'ark-key' }

test('ark:提交文生视频——指令后缀拼进 text,无 image_url', async () => {
  const calls = []
  useFetch(async (url, init) => {
    calls.push({ url, init })
    return jsonResponse({ id: 'cgt-1' })
  })
  const id = await ark.arkProvider.submit(
    {
      prompt: '夜晚便利店门口,两人对话',
      model: 'doubao-seedance-1-0-lite-t2v',
      durationSeconds: 5,
      ratio: '16:9',
      resolution: '720p',
    },
    ARK_CREDS,
  )
  assert.equal(id, 'cgt-1')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${ARK_BASE}/contents/generations/tasks`)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer ark-key')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.model, 'doubao-seedance-1-0-lite-t2v')
  assert.equal(body.content.length, 1)
  assert.equal(body.content[0].text, '夜晚便利店门口,两人对话 --duration 5 --ratio 16:9 --resolution 720p')
})

test('ark:带参考图时 lite t2v 自动换 i2v 并附首帧', async () => {
  const calls = []
  useFetch(async (url, init) => {
    calls.push({ init })
    return jsonResponse({ id: 'cgt-2' })
  })
  await ark.arkProvider.submit(
    { prompt: 'p', model: 'doubao-seedance-1-0-lite-t2v', refImage: 'data:image/png;base64,xxx' },
    ARK_CREDS,
  )
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.model, 'doubao-seedance-1-0-lite-i2v')
  assert.equal(body.content[1].type, 'image_url')
  assert.equal(body.content[1].image_url.url, 'data:image/png;base64,xxx')
})

test('ark:轮询 succeeded 取 video_url,cancelled 归为 failed', async () => {
  useFetch(async () => jsonResponse({ status: 'succeeded', content: { video_url: 'https://cdn/v.mp4' } }))
  const ok = await ark.arkProvider.poll('cgt-1', ARK_CREDS)
  assert.equal(ok.status, 'succeeded')
  assert.equal(ok.videoUrl, 'https://cdn/v.mp4')
  useFetch(async () => jsonResponse({ status: 'cancelled' }))
  const bad = await ark.arkProvider.poll('cgt-1', ARK_CREDS)
  assert.equal(bad.status, 'failed')
  assert.match(bad.failMsg, /cancelled/)
})

// ---------- 海螺(minimax) ----------

const MM_CREDS = { apiKey: 'mm-key' }

test('minimax:提交带首帧图,业务错误抛出并带 status_msg', async () => {
  const calls = []
  useFetch(async (url, init) => {
    calls.push({ url, init })
    return jsonResponse({ task_id: 'mm-1', base_resp: { status_code: 0 } })
  })
  const id = await minimax.minimaxProvider.submit(
    { prompt: 'p', model: 'MiniMax-Hailuo-02', refImage: 'data:image/png;base64,y', durationSeconds: 5 },
    MM_CREDS,
  )
  assert.equal(id, 'mm-1')
  assert.equal(calls[0].url, 'https://api.minimaxi.com/v1/video_generation')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.first_frame_image, 'data:image/png;base64,y')
  assert.equal(body.duration, '6') // 5 秒就近映射海螺 02 的 6 秒档

  useFetch(async () => jsonResponse({ base_resp: { status_code: 1004, status_msg: 'invalid api key' } }))
  await assert.rejects(
    () => minimax.minimaxProvider.submit({ prompt: 'p', model: 'video-01' }, MM_CREDS),
    /MiniMax 业务错误/,
  )
})

test('minimax:轮询 Success→succeeded,Fail→failed', async () => {
  useFetch(async (url) => {
    assert.match(url, /\/v1\/query\/video_generation\?task_id=mm-1$/)
    return jsonResponse({ status: 'Success', file: { download_url: 'https://f/v.mp4', cover_image_url: 'https://f/c.jpg' } })
  })
  const ok = await minimax.minimaxProvider.poll('mm-1', MM_CREDS)
  assert.equal(ok.status, 'succeeded')
  assert.equal(ok.videoUrl, 'https://f/v.mp4')
  assert.equal(ok.coverUrl, 'https://f/c.jpg')
  useFetch(async () => jsonResponse({ status: 'Fail', fail_msg: 'content violation' }))
  const bad = await minimax.minimaxProvider.poll('mm-1', MM_CREDS)
  assert.equal(bad.status, 'failed')
  assert.equal(bad.failMsg, 'content violation')
})

// ---------- 智谱清影(zhipu) ----------

const ZP_CREDS = { apiKey: 'zp-key' }

test('zhipu:cogvideox-3 带 with_audio,cogvideox-2 不带', async () => {
  const calls = []
  useFetch(async (url, init) => {
    calls.push({ url, init })
    return jsonResponse({ id: 'zp-1' })
  })
  await zhipu.zhipuProvider.submit({ prompt: 'p', model: 'cogvideox-3', durationSeconds: 10 }, ZP_CREDS)
  assert.equal(calls[0].url, 'https://open.bigmodel.cn/api/paas/v4/videos/generations')
  let body = JSON.parse(calls[0].init.body)
  assert.equal(body.with_audio, true)
  assert.equal(body.duration, 10)
  await zhipu.zhipuProvider.submit({ prompt: 'p', model: 'cogvideox-2' }, ZP_CREDS)
  body = JSON.parse(calls[1].init.body)
  assert.equal(body.with_audio, undefined)
})

test('zhipu:轮询 SUCCESS→succeeded 取 video_result[0]', async () => {
  useFetch(async () =>
    jsonResponse({ task_status: 'SUCCESS', video_result: [{ url: 'https://z/v.mp4', cover_image_url: 'https://z/c.jpg' }] }),
  )
  const ok = await zhipu.zhipuProvider.poll('zp-1', ZP_CREDS)
  assert.equal(ok.status, 'succeeded')
  assert.equal(ok.videoUrl, 'https://z/v.mp4')
  useFetch(async () => jsonResponse({ task_status: 'FAIL' }))
  const bad = await zhipu.zhipuProvider.poll('zp-1', ZP_CREDS)
  assert.equal(bad.status, 'failed')
})

// ---------- 注册表 / 错误分类 / 模型解析 ----------

test('注册表:三家供应商齐备,missingSetup 拦未配 Key', () => {
  assert.deepEqual(index.VIDEO_PROVIDERS.map((p) => p.id), ['ark', 'minimax', 'zhipu'])
  const cfg = configStore.DEFAULT_CONFIG
  assert.match(index.videoProviderById('ark').missingSetup(cfg), /火山方舟 API Key/)
  const withKey = { ...cfg, videoGen: { ...cfg.videoGen, apiKeys: { ark: 'k' } } }
  assert.equal(index.videoProviderById('ark').missingSetup(withKey), null)
})

test('modelFor:覆盖值优先,缺省回落预设第一档(便宜档)', () => {
  const base = configStore.DEFAULT_CONFIG.videoGen
  assert.equal(index.modelFor({ videoGen: base }, 'ark'), 'doubao-seedance-1-0-lite-t2v')
  assert.equal(
    index.modelFor({ videoGen: { ...base, models: { ark: 'doubao-seedance-2-0' } } }, 'ark'),
    'doubao-seedance-2-0',
  )
})

test('describeVideoError:按状态/关键字归类', () => {
  const e = (status, serverMsg) => Object.assign(new Error(`API HTTP ${status}`), { status, serverMsg })
  assert.match(index.describeVideoError(e(401, 'invalid api key')), /Key 无效/)
  assert.match(index.describeVideoError(e(404, 'ModelNotOpen')), /未开通/)
  assert.match(index.describeVideoError(e(429, 'rate limited')), /限流/)
  assert.match(index.describeVideoError(e(403, 'quota exceeded')), /余额|额度/)
  assert.match(index.describeVideoError(e(500, 'boom')), /boom/)
})

// ---------- 剧本轻适配(promptComposer) ----------

test('scriptDigest:说话者/动作/反应/语气/台词摘录都进要点', () => {
  const lines = [
    { speaker: 'A', text: '今天天气真不错,窗外阳光正好。', action: 'happy', reactions: { B: 'shy' } },
    { speaker: 'B', text: '咳……怎么可能,我十点就睡了。', action: 'sad', delivery: 'slow' },
  ]
  const digest = composer.scriptDigest(lines)
  assert.equal(digest.length, 2)
  assert.match(digest[0], /甲\(女\)/)
  assert.match(digest[0], /笑容明媚/)
  assert.match(digest[0], /乙害羞低头/)
  assert.match(digest[0], /「今天天气真不错/)
  assert.match(digest[1], /从容、有意停顿/)
})

test('fallbackPrompt:场景卡/用户补充/对白原文都落在模板里', () => {
  const p = composer.fallbackPrompt({
    episode: {
      lines: [
        { speaker: 'A', text: '今天天气真不错,咱们出去走走吧。', action: 'happy' },
        { speaker: 'B', text: '行啊,正好我也想透透气。', action: 'talk' },
      ],
      card: { scene: '深夜便利店', relationship: '', goalA: '', goalB: '', secret: 'x', escalation: ['a'], callback: '' },
    },
    brief: '霓虹灯下雨中对话',
  })
  assert.match(p, /深夜便利店/)
  assert.match(p, /甲\(女\)/)
  assert.match(p, /霓虹灯下雨中对话/)
  assert.match(p, /角色对白:甲:「今天天气真不错」/)
  assert.match(p, /乙:「行啊」/)
})

test('pickSpokenLines:取首句+下一不同说话者,截到第一个句读,限句数', () => {
  const lines = [
    { speaker: 'A', text: '今天天气真不错,窗外阳光正好。', action: 'happy' },
    { speaker: 'A', text: '第二句还是甲。', action: 'talk' },
    { speaker: 'B', text: '是啊,这种天最适合摸鱼了。', action: 'talk' },
  ]
  const two = composer.pickSpokenLines(lines, 2)
  assert.deepEqual(two, ['甲:「今天天气真不错」', '乙:「是啊」'])
  assert.deepEqual(composer.pickSpokenLines(lines, 1), ['甲:「今天天气真不错」'])
  assert.deepEqual(composer.pickSpokenLines(lines, 0), [])
  // 没有句读的短句整句保留;全部同说话者时只出一句
  const solo = composer.pickSpokenLines(
    [
      { speaker: 'A', text: '一句话到底没有停顿', action: 'talk' },
      { speaker: 'A', text: '还是甲', action: 'talk' },
    ],
    2,
  )
  assert.deepEqual(solo, ['甲:「一句话到底没有停顿」'])
})

test('composeVideoPrompt:LLM 只写画面,对白原文由代码拼接', async () => {
  const r = await composer.composeVideoPrompt(
    {
      episode: {
        lines: [
          { speaker: 'A', text: '你好呀。', action: 'talk' },
          { speaker: 'B', text: '嗨。', action: 'happy' },
        ],
      },
      brief: '',
      maxSpokenLines: 2,
    },
    { complete: async () => '「中景镜头,便利店灯光下两人交谈。」' },
  )
  assert.equal(r.usedFallback, false)
  assert.match(r.prompt, /中景镜头,便利店灯光下两人交谈。/)
  assert.match(r.prompt, /角色对白:甲:「你好呀」 乙:「嗨」/)
})

test('composeVideoPrompt:LLM 失败回退模板,不空手而归', async () => {
  const r = await composer.composeVideoPrompt(
    { episode: { lines: [{ speaker: 'B', text: 'hi', action: 'wave' }] }, brief: '' },
    { complete: async () => { throw new Error('超时') } },
  )
  assert.equal(r.usedFallback, true)
  assert.match(r.error, /超时/)
  assert.ok(r.prompt.length > 0)
})

test('composeVideoPrompt:无素材且无补充直接抛错', async () => {
  await assert.rejects(
    () => composer.composeVideoPrompt({ episode: null, brief: '' }, { complete: async () => 'x' }),
    /没有可用的素材/,
  )
})

// ---------- videoStore 清洗 ----------

const validTask = {
  id: 'v1',
  providerId: 'ark',
  model: 'doubao-seedance-1-0-lite-t2v',
  prompt: '夜景',
  status: 'succeeded',
  taskId: 'cgt-1',
  videoUrl: 'https://cdn/v.mp4',
  createdAt: 100,
}

test('sanitizeVideoTask:合法通过,关键字段缺失/孤儿任务拒收', () => {
  const t = store.sanitizeVideoTask(validTask)
  assert.ok(t)
  assert.equal(t.status, 'succeeded')
  assert.equal(store.sanitizeVideoTask({ ...validTask, id: '' }), null)
  assert.equal(store.sanitizeVideoTask({ ...validTask, providerId: '' }), null)
  assert.equal(store.sanitizeVideoTask({ ...validTask, status: 'queued', taskId: '' }), null)
  // 未知状态归为 failed(而非拒收):结果链接还在,展示与保存仍可用
  assert.equal(store.sanitizeVideoTask({ ...validTask, status: 'weird' }).status, 'failed')
})

test('sanitizeVideoTasks:去重/限量/按时间倒序,字段截断', () => {
  const many = []
  for (let i = 0; i < 55; i++) {
    // createdAt 从 1 起:0 会被清洗器当作缺失归一成 Date.now()
    many.push({ ...validTask, id: `v${i}`, createdAt: i + 1, prompt: 'x'.repeat(1000) })
  }
  const out = store.sanitizeVideoTasks(many)
  assert.equal(out.length, store.VIDEO_TASK_LIMIT)
  assert.equal(out[0].id, 'v54') // 最新在前
  assert.ok(out.every((t) => t.prompt.length <= 800))
  const deduped = store.sanitizeVideoTasks([validTask, { ...validTask, videoUrl: 'https://other' }])
  assert.equal(deduped.length, 1)
})

// ---------- 视频工坊 UI 冒烟 ----------

/** 会话桩:各 tab 从 useSettings 解构的字段齐备即可渲染 */
function sessionStub(extra = {}) {
  return {
    form: configStore.DEFAULT_CONFIG,
    setForm: () => {},
    saveField: () => {},
    flashCard: null,
    gotoTab: () => {},
    videoSource: null,
    setVideoSource: () => {},
    bridge: {
      onReplay: () => {},
      onResetLayout: () => {},
      onResetC: () => {},
      onPrivacyTip: () => {},
      onSupportThanks: () => {},
      onGroupSend: async () => 'accepted',
    },
    ...extra,
  }
}

function renderTab(mod, component, extra = {}) {
  return renderToStaticMarkup(
    React.createElement(session.SettingsContext.Provider, { value: sessionStub(extra) }, React.createElement(mod[component])),
  )
}

test('视频工坊:SSR 渲染出全部卡片,未配 Key 不抛错', () => {
  const html = renderTab(videoTab, 'VideoSettings')
  assert.match(html, /视频服务/)
  assert.match(html, /画面参数/)
  assert.match(html, /生成视频/)
  assert.match(html, /任务列表/)
  assert.match(html, /从最近演出生成画面描述/)
})

test('视频工坊:带收藏来源时显示来源条与对应文案', () => {
  const ep = {
    ts: 1726000000000,
    mode: 'daily',
    fav: true,
    lines: [
      { speaker: 'A', text: '你好', action: 'talk' },
      { speaker: 'B', text: '嗨', action: 'happy' },
    ],
  }
  const html = renderTab(videoTab, 'VideoSettings', { videoSource: ep })
  assert.match(html, /素材来源/)
  assert.match(html, /收藏 · 日常 ·/)
  assert.match(html, /从选中收藏生成画面描述/)
  assert.match(html, /改用最近一集/)
})

test('收藏页:SSR 冒烟渲染不抛错(导入图标在数据行内,SSR 不跑 effect 见不到行)', () => {
  // renderToStaticMarkup 不执行 useEffect → listFavorites 不会被调,favs 恒为空态;
  // 这里只验证模块图(新 import 的 format/modes 等)与渲染图无崩,图标本身由 tsc+运行时覆盖
  const html = renderTab(favoritesTab, 'FavoritesSettings')
  assert.match(html, /收藏的对话/)
  assert.match(html, /hist-empty/)
})

// ---------- configStore.videoGen 清洗 ----------

test('sanitizeVideoGen:白名单外回默认,apiKeys/models 限量', () => {
  const d = configStore.DEFAULT_CONFIG.videoGen
  const clean = configStore.sanitizeVideoGen({
    provider: 'hacker',
    apiKeys: { ark: 'k1', bad: 'k2' },
    models: { ark: 'm1' },
    durationSeconds: 7,
    ratio: '21:9',
    resolution: '4k',
  })
  assert.equal(clean.provider, d.provider)
  assert.equal(clean.durationSeconds, d.durationSeconds)
  assert.equal(clean.ratio, d.ratio)
  assert.equal(clean.resolution, d.resolution)
  assert.equal(clean.apiKeys.ark, 'k1')
  assert.deepEqual(clean.models.ark, 'm1')
  assert.equal(clean.costConfirmed, false)

  const full = configStore.sanitizeVideoGen({
    provider: 'minimax',
    durationSeconds: 10,
    ratio: '9:16',
    resolution: '1080p',
    costConfirmed: true,
  })
  assert.deepEqual(
    [full.provider, full.durationSeconds, full.ratio, full.resolution, full.costConfirmed],
    ['minimax', 10, '9:16', '1080p', true],
  )
})
