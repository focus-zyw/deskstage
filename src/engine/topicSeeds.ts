// 话题种子池：每次生成注入一个随机话题，防尬聊/车轱辘话。
// 模式可带专属池（DialogMode.topics），缺省用全局池。
import type { DialogMode } from '../performer/modes'

export const TOPIC_SEEDS = [
  '减肥永远从明天开始',
  '外卖满减红包的极限操作',
  '养猫和养狗的人生分歧',
  '上班摸鱼的最高境界',
  '双十一囤的货还没拆封',
  '凌晨三点的灵感与早八的闹钟',
  '健身房年卡只用过两次',
  '为什么周末过得特别快',
  'AI 会不会抢走我们的工作',
  '租房遇到的奇葩房东',
  '点奶茶选择困难症',
  '旅行的意义是拍照发朋友圈',
  '地铁早高峰的生存法则',
  '存钱和消费的世纪拉扯',
  '游戏氪金到底值不值',
  '早睡早起身体好是不是传说',
  '方便面的神仙吃法',
  '朋友圈三天可见的人群分析',
  '办公室空调温度争夺战',
  '过年被亲戚灵魂拷问',
  '手机内存永远不够用',
  '网上吵架的胜负欲',
  '养生朋克：可乐泡枸杞',
  '拖延症晚期自救指南',
  '宠物看病比人还贵',
  '下班后的神秘疲惫感',
  '知识付费买了一堆没听',
  '旧手机里的回忆要不要删',
  '为什么大人也在集卡',
  '深夜网购的冲动与后悔',
]

// 每个话题池单独记上一次的下标，避免连续重复
const lastIdx = new Map<string, number>()

/** 随机取一个话题，避免连续重复 */
export function pickTopic(mode?: DialogMode): string {
  const pool = mode?.topics ?? TOPIC_SEEDS
  const key = mode?.id ?? '__global__'
  let i = Math.floor(Math.random() * pool.length)
  if (i === lastIdx.get(key)) i = (i + 1) % pool.length
  lastIdx.set(key, i)
  return pool[i]!
}
