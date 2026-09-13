// AI 剧场模式:多个独立网页 AI 各演一个角色,逐轮即兴接话。
// 生成不走单模型剧本链路,而由 RelayDirector 轮转两个长期网页会话
// (generation.kind = 'relay' 是 play() 的分派依据)。
// 兜底剧本与日常基调一致:自然来回、无互怼骨架——网页会话没就绪时顶一场。
import type { DialogLine } from '../player'
import type { DialogMode } from './index'

const AI_THEATER_SCRIPT: DialogLine[] = [
  { speaker: 'A', text: '跟你说,我刚在楼上看见一只猫,坐姿跟我老板一模一样。', action: 'surprise' },
  { speaker: 'B', text: '那你有没有跟它汇报工作?', action: 'talk', listenerAction: 'happy' },
  { speaker: 'A', text: '它瞥了我一眼,尾巴一甩,像在说"这个月绩效不行"。', action: 'talk' },
  { speaker: 'B', text: '确实是老板,连猫都学会画饼了。', action: 'laugh' },
  { speaker: 'A', text: '回头我给它带条小鱼干,贿赂一下未来。', action: 'happy' },
  { speaker: 'B', text: '记得备注:此饼留给下任。', action: 'talk', pauseAfter: 1200 },
]

export const aiTheaterMode: DialogMode<'ai-theater'> = {
  id: 'ai-theater',
  label: 'AI剧场',
  accent: '#32c7b5',
  gap: 300,
  script: AI_THEATER_SCRIPT,
  prompt: '多个独立 AI 各自扮演角色,按舞台导演消息逐轮即兴接话。',
  triggers: ['AI剧场', '多AI', '即兴剧场'],
  tone: '多人即兴对话',
  generation: { kind: 'relay', preset: 'dual-ai' },
}
