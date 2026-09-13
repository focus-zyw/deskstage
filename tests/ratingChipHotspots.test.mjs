// 穿透窗口热区回归(动态话题系统新增按钮):RatingChip 的三个话题轻操作按钮
// (继续聊/换切口/不想听)与原三键一样,必须各自注册原生命中区并纳入悬停高亮——
// 未注册区域在穿透架构下收不到任何鼠标事件(源码断言,与 modeMenuPointer 同套路)。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const chipSource = await readFile(new URL('../src/ui/RatingChip.tsx', import.meta.url), 'utf8')
const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')

test('RatingChip 六个按钮全部注册原生命中区,卸载时注销', () => {
  for (const id of ['rate-up', 'rate-down', 'rate-fav', 'rate-continue', 'rate-angle', 'rate-ban']) {
    assert.match(chipSource, new RegExp(`registerHitRegion\\('${id}'`), `缺少热区注册: ${id}`)
  }
  // 注册返回的 unsubs 必须在清理函数里逐个注销(致谢态卸载按钮后热区失活)
  assert.match(chipSource, /return \(\) => unsubs\.forEach\(\(u\) => u\(\)\)/)
})

test('悬停高亮覆盖新增话题按钮(CSS :hover 在合成指针下不可靠)', () => {
  const hover = chipSource.match(/onHoverChange\(\(id\) => \{[\s\S]*?\}\)/)?.[0] ?? ''
  // 新增三键经 TOPIC_ACTION_IDS 常量纳入悬停白名单(与热区注册同源,防两表漂移)
  assert.match(hover, /TOPIC_ACTION_IDS/, '悬停高亮必须纳入 TOPIC_ACTION_IDS 白名单')
  // 常量表必须收齐三个话题按钮
  for (const id of ['rate-continue', 'rate-angle', 'rate-ban']) {
    assert.match(chipSource, new RegExp(`'${id}'`), `TOPIC_ACTION_IDS 缺少 ${id}`)
  }
})

test('话题轻操作接线:继续/换切口走 director.play,不想听走负反馈事件', () => {
  // 继续聊这个 → continue;换个切口 → change-angle(都触发新一集演出)
  assert.match(appSource, /onContinueTopic=\{\(\) => \{[\s\S]*?intent: 'continue'[\s\S]*?\}\}/)
  assert.match(appSource, /onChangeAngle=\{\(\) => \{[\s\S]*?intent: 'change-angle'[\s\S]*?\}\}/)
  // 不想再听这类 = 踩(负反馈),经唯一写入口 TopicDirector.record 落账
  assert.match(
    appSource,
    /onBanTopic=\{\(\) => \{[\s\S]*?type: 'rating-changed'[\s\S]*?value: 'down'[\s\S]*?\}\}/,
  )
})

test('话题面板读模型:useTopicSnapshot 渲染,行动按钮经 director 派发', () => {
  // 面板状态只从读模型来(不调用 plan(),不耗随机数/不建预约)
  assert.match(appSource, /const topicSnap = useTopicSnapshot\(\)/)
  assert.match(appSource, /playTopicAction\('continue'\)/)
  assert.match(appSource, /playTopicAction\('change-angle'\)/)
  assert.match(appSource, /playTopicAction\('pivot', 'medium'\)/)
  assert.match(appSource, /playTopicAction\('pivot', 'far'\)/)
})
