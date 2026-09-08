// 时间感知:给生成注入现实时间氛围,给自发行为提供时段判断与免打扰窗口。

export interface TimeSlot {
  id: string
  /** 时段显示名(注入 prompt 用) */
  label: string
  /** 该时段的氛围描述(注入 prompt 用) */
  scene: string
}

export function currentTimeSlot(now = new Date()): TimeSlot {
  const h = now.getHours()
  if (h >= 5 && h < 8)
    return { id: 'earlyMorning', label: '清晨', scene: '刚起床不久、世界刚醒来的慵懒氛围' }
  if (h < 11) return { id: 'morning', label: '上午', scene: '精神饱满的白天氛围' }
  if (h < 13) return { id: 'noon', label: '中午', scene: '午饭与饭后犯困的氛围' }
  if (h < 17) return { id: 'afternoon', label: '下午', scene: '有点倦怠、盼着下班的午后氛围' }
  if (h < 19) return { id: 'dusk', label: '傍晚', scene: '下班放学路上、天色渐暗的氛围' }
  if (h < 23) return { id: 'evening', label: '晚上', scene: '宅家放松的夜晚氛围' }
  return { id: 'lateNight', label: '深夜', scene: '深夜还没睡、四周都很安静的氛围' }
}

/** 免打扰窗口:凌晨 0~7 点不发起自发聊天(角色也该睡觉) */
export function isQuietHours(now = new Date()): boolean {
  const h = now.getHours()
  return h < 7
}
