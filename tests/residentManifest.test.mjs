import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let clipsForAction
let pickClip
let isLoopingClip
let residentSrc
let nativeFacing
let resolveResidentClip
let shouldFlip
let snackActionNow
let RARE_CLIPS

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  ;({ clipsForAction, pickClip, isLoopingClip, residentSrc, nativeFacing, snackActionNow, RARE_CLIPS } = await server.ssrLoadModule(
    '/src/stage/resident/residentManifest.ts',
  ))
  ;({ resolveResidentClip, shouldFlip } = await server.ssrLoadModule('/src/stage/resident/residentMachine.ts'))
})

after(async () => {
  await server?.close()
})

test('词表动作映射到候选片段,未知动作回退 idle', () => {
  assert.deepEqual(clipsForAction('talk'), ['talk'])
  assert.deepEqual(clipsForAction('thinking'), ['think', 'pace'])
  assert.deepEqual(clipsForAction('happy'), ['happy', 'wave'])
  assert.deepEqual(clipsForAction('surprise'), ['surprise', 'startled'])
  // 动作补缺:此前回退待机的四个词,现在各有贴语义的片段
  assert.deepEqual(clipsForAction('sad'), ['sigh', 'fallen'])
  assert.deepEqual(clipsForAction('sleepy'), ['yawn', 'nap'])
  assert.deepEqual(clipsForAction('shake'), ['squash'])
  assert.deepEqual(clipsForAction('jump'), ['jump_smash'])
  assert.deepEqual(clipsForAction('不存在动作'), ['idle'])
})

test('C 内部动作(围观/互动/待机链)映射到专属片段', () => {
  assert.deepEqual(clipsForAction('working'), ['working', 'focus', 'filing', 'note_quick'])
  assert.deepEqual(clipsForAction('stretch'), ['stretch'])
  assert.deepEqual(clipsForAction('hum'), ['hum'])
  assert.deepEqual(clipsForAction('tap'), ['tap'])
})

test('互动扩展动作词(摸头/午睡/吃撑/跳舞/绝活/点心)都解析到合法候选', () => {
  // 摸头长按:咯咯笑为主
  assert.deepEqual(clipsForAction('headpat'), ['tickle', 'happy', 'cheer'])
  // 右键点播
  assert.deepEqual(clipsForAction('nap'), ['nap'])
  assert.deepEqual(clipsForAction('stuffed'), ['squash'])
  assert.deepEqual(clipsForAction('dance'), ['dance', 'swing_dance', 'spin_show'])
  // 绝活 = 稀有彩蛋整池点播(原本只有 2% 随机可见)
  assert.deepEqual(clipsForAction('trick'), [...RARE_CLIPS])
  assert.ok(RARE_CLIPS.length >= 8, '绝活池应有足够的彩蛋候选')
  // 投喂点心:一词一片段
  for (const word of ['breakfast', 'lunch', 'dinner', 'ice_cream', 'watermelon', 'hotpot', 'what_to_eat']) {
    assert.deepEqual(clipsForAction(word), [word], word)
  }
  // 随机挑选不越界:每个新词挑出的片段都在自身候选内
  for (const word of ['headpat', 'nap', 'stuffed', 'dance', 'trick']) {
    const candidates = clipsForAction(word)
    for (let i = 0; i < 20; i++) {
      assert.ok(candidates.includes(pickClip(word)), `${word} 挑出候选外的片段`)
    }
  }
})

test('投喂点心按时段/季节选:早早餐、午午餐、夏冷饮、冬火锅', () => {
  const at = (h, m = 0) => {
    const d = new Date(2026, 0, 15, h, m) // 1 月 = 冬
    d.setMonth(0)
    return d
  }
  assert.equal(snackActionNow(at(8)), 'breakfast')
  assert.equal(snackActionNow(at(12)), 'lunch')
  assert.equal(snackActionNow(at(18)), 'dinner')
  // 冬天下午/深夜:火锅与纠结
  assert.equal(snackActionNow(at(15)), 'what_to_eat')
  assert.equal(snackActionNow(at(22)), 'hotpot')
  // 夏天(8 月)下午端冷饮,深夜不端火锅
  const summer = (h) => new Date(2026, 7, 15, h, 0)
  for (let i = 0; i < 10; i++) {
    assert.ok(['ice_cream', 'watermelon'].includes(snackActionNow(summer(15))), '夏天下午应为冷饮')
  }
  assert.equal(snackActionNow(summer(22)), 'what_to_eat')
})

test('多候选按随机源挑选,单候选不受随机影响', () => {
  assert.equal(pickClip('happy', () => 0), 'happy')
  assert.equal(pickClip('happy', () => 0.99), 'wave')
  assert.equal(pickClip('talk', () => 0.99), 'talk')
})

test('持续状态循环播放,反应类单次播完停帧', () => {
  for (const clip of ['idle', 'talk', 'think', 'walk', 'float', 'drag', 'working']) {
    assert.equal(isLoopingClip(clip), true, clip)
  }
  for (const clip of ['happy', 'wave', 'angry', 'surprise', 'startled', 'caught', 'turn', 'hum', 'stretch', 'tap']) {
    assert.equal(isLoopingClip(clip), false, clip)
  }
})

test('片段地址落在 animations/c 目录下,文件名是稳定英文 ID', () => {
  assert.equal(residentSrc('idle'), '/animations/c/idle.webm')
  assert.ok(residentSrc('talk').startsWith('/animations/c/'))
  assert.ok(!/[^\w./-]/.test(residentSrc('turn')), '路径不应包含中文或特殊字符')
})

test('本地已抓取的素材文件真实存在(资源在库时不允许运行期回退)', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'animations', 'c')
  if (!existsSync(path.join(dir, 'idle.webm'))) {
    // 素材未抓取时跳过(脚本 scripts/fetch-c-animations.mjs 可补齐),应用侧静默降级
    return
  }
  const all = [
    'idle', 'talk', 'think', 'happy', 'wave', 'angry', 'surprise', 'startled', 'caught', 'turn', 'walk', 'float', 'drag',
    'working', 'focus', 'stretch', 'hum', 'tap',
    'sigh', 'fallen', 'yawn', 'nap', 'squash', 'jump_smash', 'cheer', 'pace',
    'wipe', 'screen_mutter', 'daze', 'cat', 'mirror', 'cube', 'toy_car', 'kick_shuttle', 'rocking_horse', 'spin_top', 'animals', 'butterflies',
    'tickle', 'scared',
    'brush', 'breakfast', 'lunch', 'what_to_eat', 'dinner', 'fan', 'watermelon', 'ice_cream', 'snowman', 'hotpot',
    'fu', 'red_packet', 'dumplings', 'fireworks', 'lion_dance', 'rice_cake', 'tangyuan', 'sky_lantern', 'zongzi', 'qixi_needle', 'mooncake', 'chongyang', 'chongyang_cake', 'laba_porridge', 'christmas_tree', 'trick_treat', 'qingtuan',
    'rage_quit', 'whale_slam', 'dance', 'swing_dance', 'spin_show',
    'filing', 'note_quick',
    'whale_rise', 'whale_bubble', 'dove', 'card_magic', 'juggle', 'gomoku', 'bloom', 'eat_token',
  ]
  for (const clip of all) {
    assert.equal(existsSync(path.join(dir, `${clip}.webm`)), true, `${clip}.webm 缺失`)
  }
})

test('优先级仲裁:隐藏 > 拖拽 > 说话 > 剧情 > 点击 > 漫游 > 待机', () => {
  const base = { hidden: false, dragging: false, speaking: false, scripted: null, poke: null, roaming: false, ambient: null }
  assert.equal(resolveResidentClip({ ...base, hidden: true }), null)
  assert.equal(resolveResidentClip({ ...base, dragging: true, speaking: true, scripted: 'angry' }).clip, 'drag')
  assert.equal(resolveResidentClip({ ...base, speaking: true, scripted: 'angry' }).clip, 'talk')
  // 说话中拖拽 → 拖拽;松手后 speaking 未变 → 说话(恢复不需要专门逻辑)
  assert.equal(resolveResidentClip({ ...base, speaking: true }).clip, 'talk')
  assert.equal(resolveResidentClip({ ...base, scripted: 'angry', poke: 'caught' }).clip, 'angry')
  assert.equal(resolveResidentClip({ ...base, poke: 'caught', roaming: true }).clip, 'caught')
  assert.equal(resolveResidentClip({ ...base, roaming: true, ambient: 'turn' }).clip, 'walk')
  assert.equal(resolveResidentClip({ ...base, ambient: 'turn' }).clip, 'turn')
  assert.equal(resolveResidentClip(base).clip, 'idle')
})

test('剧情指定 idle 视为未指定,不阻断点击回应', () => {
  const base = { hidden: false, dragging: false, speaking: false, scripted: 'idle', poke: 'happy', roaming: false, ambient: null }
  assert.equal(resolveResidentClip(base).clip, 'happy')
})

test('方向性片段朝向与镜像判定:走路素材原生朝左,反向移动才翻', () => {
  // 帧分析结论:walk.webm 的螃蟹步向画面左侧行进(原生朝向 -1)
  assert.equal(nativeFacing('walk'), -1)
  assert.equal(nativeFacing('idle'), 0, '原地类片段无方向性')
  assert.equal(shouldFlip('walk', 1), true, '素材朝左却向右移动 → 必须镜像')
  assert.equal(shouldFlip('walk', -1), false, '同向不翻')
  assert.equal(shouldFlip('walk', 0), false, '静止不翻')
  assert.equal(shouldFlip('idle', 1), false, '无方向性片段不翻')
})

test('说话状态固定用循环片段;剧情反应按词表决定循环与否', () => {
  const base = { hidden: false, dragging: false, speaking: true, scripted: null, poke: null, roaming: false, ambient: null }
  assert.equal(resolveResidentClip(base).loop, true)
  const scripted = { ...base, speaking: false, scripted: 'happy' }
  assert.equal(resolveResidentClip(scripted).loop, false)
})
