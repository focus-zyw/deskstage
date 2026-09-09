// 中文相对/绝对时间解析(命令面板"添加提醒"用)。
// 覆盖常用表达:N分钟后/N小时后/明天下午三点半/周三9点/14:30;解析不出返回 null,
// 由调用方回落到"预填文本、用户手选时间"——绝不猜一个错时间默默设上。

const CN_NUM: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  两: 2, 十: 10, 半: 0,
}

/** 中文数字 → 数值(支持 一~九十九,含"半"单独处理) */
function cnToInt(s: string): number | null {
  if (!s) return null
  if (/^\d+$/.test(s)) return Number(s)
  if (s === '半') return 0
  const ten = s.indexOf('十')
  if (ten === -1) return CN_NUM[s] ?? null
  const left = ten === 0 ? 1 : CN_NUM[s.slice(0, ten)] ?? 1
  const right = s.slice(ten + 1)
  return left * 10 + (right ? CN_NUM[right] ?? 0 : 0)
}

/** "下午3/晚上8" 这类时段词对 24 小时制的修正 */
function ampmOffset(band: string | undefined, hour: number): number {
  if (!band) return hour < 8 ? 0 : hour // 无时段词:小数字按原值(24 点制靠用户写清)
  if (band === '下午' || band === '晚上') return hour < 12 ? hour + 12 : hour
  if (band === '中午') return hour === 12 ? 12 : hour < 2 ? hour + 12 : hour
  return hour // 上午/早上/凌晨
}

export function parseChineseTime(input: string, now = new Date()): Date | null {
  const q = input.trim()

  // 1) 相对量:N 分钟/小时/天 以后(支持数字与中文数字,"半小时")
  const rel = q.match(/([0-9]+|半|[一两二三四五六七八九十]{1,3})\s*个?\s*(分钟|分|小时|钟头|天)(?:之|以)?后/)
  if (rel) {
    const n = rel[1] === '半' ? 0.5 : cnToInt(rel[1])
    const unit = rel[2]
    if (n !== null) {
      const ms = unit === '分钟' || unit === '分' ? n * 60_000 : unit === '天' ? n * 86_400_000 : n * 3_600_000
      return new Date(now.getTime() + ms)
    }
  }

  // 2) 绝对时点:[今天/明天/后天/周X] [时段] H[点:时][半/N分]
  const weekdayM = q.match(/(下?)周([一二三四五六日天])/)
  const dayM = q.match(/(今天|今晚|明天|明晚|后天|大后天)/)
  const timeM = q.match(
    /(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(\d{1,2}|[一两二三四五六七八九十]{1,3})\s*[点时:：]\s*(半|[0-5]?\d)?\s*分?/,
  )
  if (!weekdayM && !dayM && !timeM) return null

  const d = new Date(now)
  d.setSeconds(0, 0)
  if (dayM) {
    const add = dayM[1] === '明天' || dayM[1] === '明晚' ? 1 : dayM[1] === '后天' ? 2 : dayM[1] === '大后天' ? 3 : 0
    d.setDate(d.getDate() + add)
  } else if (weekdayM) {
    const target = '一二三四五六日天'.indexOf(weekdayM[2]) % 7 // 周日=0
    const cur = d.getDay()
    let diff = (target - cur + 7) % 7
    if (weekdayM[1] === '下') diff += 7 // "下周X" = 下一个整周
    else if (diff === 0 && timeM) {
      // 只说"周X"且就是今天:时刻已过 → 算下周,没过 → 今天
      const h = ampmOffset(timeM[1], cnToInt(timeM[2]) ?? 0)
      const m = timeM[3] === '半' ? 30 : Number(timeM[3] ?? 0)
      if (h * 60 + m <= now.getHours() * 60 + now.getMinutes()) diff = 7
    }
    d.setDate(d.getDate() + diff)
  }

  if (timeM) {
    let hour = cnToInt(timeM[2])
    if (hour === null) return null
    hour = ampmOffset(timeM[1], hour)
    const minute = timeM[3] === '半' ? 30 : Number(timeM[3] ?? 0)
    d.setHours(hour, minute)
  } else {
    // 只有日期没有时刻:默认上午 9 点
    d.setHours(9, 0)
  }
  // 没有日期词、只给时刻:已过则算明天
  if (!dayM && !weekdayM && d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1)
  return d
}

/** 从"明天下午三点提醒我交报告"里剥出事项文本(尽力而为,允许残留) */
export function extractMemoText(input: string): string {
  return input
    .replace(/(帮我|麻烦|记得|记得提醒我|提醒我|提醒|叫我|添加备忘|添加提醒|设个提醒|备忘一下)[,，:：、\s]*/g, '')
    .replace(
      /([0-9]+|半|[一两二三四五六七八九十]{1,3})\s*个?\s*(分钟|分|小时|钟头|天)(?:之|以)?后/g,
      '',
    )
    .replace(
      /(大后天|后天|明天|明晚|今晚|今天|(下?)周[一二三四五六日天])?\s*(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*([0-9]{1,2}|[一两二三四五六七八九十]{1,3})\s*[点时:：]\s*(半|[0-5]?\d)?\s*分?/g,
      '',
    )
    .replace(/^[,，:：、\s]+|[,，:：、\s]+$/g, '')
    .slice(0, 200)
}
