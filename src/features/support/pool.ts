// 支持作者:感谢语池与稀有度注册表(纯数据,仿 PROPS/MODES 注册表模式)。
// 抽奖(gacha.ts)按稀有度权重落档、档内均匀取条;设置页图鉴与舞台联动都只消费
// 这张表的类型与文案。新增感谢语 = 追加一条,抽取/图鉴/进度全部自动感知。
// 文案占位符:{name} = 使用者称呼(resolveSupportText 统一替换,未填称呼回退「老板」)。

export type Rarity = 'common' | 'rare' | 'epic' | 'legendary'

/** 稀有度从低到高(图鉴排序、舞台演出分级都按这个序) */
export const RARITY_ORDER = ['common', 'rare', 'epic', 'legendary'] as const

/** 稀有度元数据:中文名 + 抽取权重(合计 100,调概率只改这里) */
export const RARITY_META: Record<Rarity, { label: string; weight: number }> = {
  common: { label: '普通', weight: 70 },
  rare: { label: '稀有', weight: 20 },
  epic: { label: '史诗', weight: 8 },
  legendary: { label: '传说', weight: 2 },
}

export interface SupportPrize {
  id: string
  rarity: Rarity
  /** 感谢语文案,{name} 会替换成使用者称呼 */
  text: string
}

/** 感谢语池:文案按角色口吻写(甲乙主持、C小管家的家庭氛围) */
export const THANKS_POOL: SupportPrize[] = [
  // 普通(N):日常口头谢
  { id: 'n1', rarity: 'common', text: '谢谢{name}!心意收到,干劲 +1!' },
  { id: 'n2', rarity: 'common', text: '{name}的支持到账,今晚排面有了!' },
  { id: 'n3', rarity: 'common', text: '呜哇,被{name}投喂了!谢谢老板!' },
  { id: 'n4', rarity: 'common', text: '感谢{name}!这杯奶茶我记小本本上了。' },
  { id: 'n5', rarity: 'common', text: '收到了!替作者谢谢{name},也替我自己的胃谢谢{name}。' },
  { id: 'n6', rarity: 'common', text: '{name}一出手,就知有没有。谢啦!' },
  { id: 'n7', rarity: 'common', text: '叮——{name}的心意已签收,好评回敬!' },
  { id: 'n8', rarity: 'common', text: '谢谢{name}!这个月的服务器续费有着落了(大概)。' },
  { id: 'n9', rarity: 'common', text: '{name}的支持像小太阳,暖暖的!' },
  { id: 'n10', rarity: 'common', text: '老板大气!祝{name}老板天天开心!' },
  // 稀有(R):带点编排的谢
  { id: 'r1', rarity: 'rare', text: '{name}的支持我裱起来挂墙上了,谁来看都说好看!' },
  { id: 'r2', rarity: 'rare', text: '报告!{name}刚刚赞助了我们的梦想,梦想表示很受宠若惊!' },
  { id: 'r3', rarity: 'rare', text: '感谢{name}!作者说了,下个版本的新功能,灵感这就来了!' },
  { id: 'r4', rarity: 'rare', text: '金光一闪——是{name}的支持到账了!' },
  { id: 'r5', rarity: 'rare', text: '{name}请全组喝了奶茶,加珍珠的加珍珠,加椰果的加椰果,都安排!' },
  { id: 'r6', rarity: 'rare', text: '史官记下:今日{name}仗义疏财,角色组士气 +100!' },
  { id: 'r7', rarity: 'rare', text: '谢谢{name}!这份心意够我们聊一整晚的!' },
  { id: 'r8', rarity: 'rare', text: '{name}的支持已入库,备注栏写的是「自己人」!' },
  // 史诗(SR):小剧场阵仗
  { id: 's1', rarity: 'epic', text: '全体起立!{name}大驾光临!掌声在哪里!' },
  { id: 's2', rarity: 'epic', text: '听说{name}支持了作者……今晚加餐,全场加演一集!' },
  { id: 's3', rarity: 'epic', text: '{name}这份史诗级心意,我们商量了一下,决定用一辈子记住!' },
  { id: 's4', rarity: 'epic', text: '礼花备好!音乐响起!谢谢{name}老板!' },
  { id: 's5', rarity: 'epic', text: '史诗级投喂!{name}的名字已刻进感谢名单 C 位!' },
  { id: 's6', rarity: 'epic', text: '作者看到{name}的支持,笑得像个两百斤的孩子。' },
  // 传说(UR):全员谢幕级
  { id: 'u1', rarity: 'legendary', text: '警车开道!{name}大驾光临!全团列队——敬礼!' },
  { id: 'u2', rarity: 'legendary', text: '传——说——抽——卡!{name}直接把我们一年的服务器包了!' },
  { id: 'u3', rarity: 'legendary', text: '历史性一刻!{name}的名字将永远镌刻在本作品的星空之上!' },
  { id: 'u4', rarity: 'legendary', text: '灯牌!横幅!礼炮!{name}老板,您就是我们的荣耀之王!' },
]

/** 按 id 查奖品(图鉴渲染/账本清洗都用) */
export function prizeById(id: string): SupportPrize | undefined {
  return THANKS_POOL.find((p) => p.id === id)
}

/** 称呼清洗:去空白截断,空称呼回退通用叫法(与 giftReactions.cleanName 同策略) */
export function cleanSupportName(raw: string): string {
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, 12)
  return name || '老板'
}

/** 文案渲染:{name} 占位符统一替换(同一句多处出现全替换) */
export function resolveSupportText(template: string, userName: string): string {
  return template.replaceAll('{name}', cleanSupportName(userName))
}
