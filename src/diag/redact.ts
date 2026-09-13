// 诊断脱敏 · 独立层:所有进入诊断的文本都必经这里,调用方无权自定脱敏。
//
// 四层密钥防线(最可靠的不是正则,是"接口根本不接受 secret 字段"——那是 types.ts
// 的白名单事件在把关;本文件是后三道):
//   1. 精确值替换:业务代码在持密处 registerSecretValue(已加载的真实密钥/Cookie),
//      出现即整体替换——不依赖密钥长什么样;
//   2. 已知格式:Bearer / sk- 开头 / Cookie 头 / URL 凭证查询参数(api_key|key|token|sig|access_token);
//   3. 高熵字符串兜底:≥24 位混合字母数字串(阈值保守,避免误伤正常词句);
//   4. (第零层在架构上)诊断接口没有 secret 字段可填。
//
// 实体掩码(redactText):很多隐私没有格式可猜("我最近确诊抑郁症"没有手机号),
// 因此默认档干脆不存正文;详情档存的是尽力掩码后的文本——[USER_NAME]/[PHONE]/
// [IDENTITY_NUMBER]/[EMAIL]/[ADDRESS]/[BANK_CARD]/[MEDICATION]/[HEALTH_INFO]/
// [LOCAL_PATH]/[PRIVATE_ENDPOINT],并截断记原长。掩码不是承诺,三档分级才是:
// 默认无可读正文,详情短期脱敏,导出逐次授权。

/** 已加载的真实密钥/敏感值登记池(set 去重,scrub 时精确替换) */
const secretValues = new Set<string>()

export function registerSecretValue(value: string | undefined | null): void {
  if (!value || value.length < 6) return
  secretValues.add(value)
}

/** 测试与清空登记用 */
export function clearRegisteredSecrets(): void {
  secretValues.clear()
}

// ---------- 已知格式模式 ----------
// 顺序敏感:Bearer 先行(否则通用 key=value 模式会把 "Bearer" 一词当值吃掉、
// 留下裸 token);credential 模式的值段排除 '[',避免把 Bearer 替换出的
// [AUTH] 占位符再吞成 [CREDENTIAL]

const SECRET_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, label: '[AUTH]' },
  { re: /\b(?:api[-_]?key|apikey|access[-_]?token|secret|authorization)"?\s*[:=]\s*"?[^\s"',;[\]]{6,}/gi, label: '[CREDENTIAL]' },
  { re: /\bsk-[A-Za-z0-9_-]{8,}/g, label: '[API_KEY]' },
  { re: /\bCookie\s*:\s*[^\n\r;]{6,}/gi, label: '[COOKIE]' },
  { re: /\b(?:sessdata|bili_jct|dedeuserid)\s*[:=]\s*[^\s"',;[\]]{4,}/gi, label: '[COOKIE]' },
]

/** URL 查询参数里的凭证:整段 query 抹掉比逐个参数猜更稳 */
const URL_QUERY_RE = /\?(?:[^\\\s]*)(?:[&?](?:key|token|sign|sig|api_key|access_token|credential)=[^&\s]*)?/gi

/** 高熵兜底:24+ 位连续混合串(排除含分隔符的正常路径/时间戳) */
const HIGH_ENTROPY_RE = /(?<![\w/-])[A-Za-z0-9]{12}[A-Za-z0-9]{12,}(?![\w/-])/g

/** 内网地址(内网端点也属于拓扑隐私) */
const PRIVATE_ENDPOINT_RE = /\b(?:https?:\/\/)?(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?::\d+)?/g

/** scrubSecrets:密钥/凭证强制抹除,任何档位(含"含原文")都必经 */
export function scrubSecrets(input: string): string {
  let out = input
  for (const v of secretValues) {
    if (v && out.includes(v)) out = out.split(v).join('[SECRET]')
  }
  for (const { re, label } of SECRET_PATTERNS) out = out.replace(re, label)
  out = out.replace(URL_QUERY_RE, '?[QUERY_STRIPPED]')
  out = out.replace(PRIVATE_ENDPOINT_RE, '[PRIVATE_ENDPOINT]')
  out = out.replace(HIGH_ENTROPY_RE, '[ENTROPY]')
  return out
}

// ---------- 实体掩码 ----------

let knownUserName = ''
/** 登记使用者称呼(面板掩码用);bridgeServer 的配置差分里随 persona 同步 */
export function setKnownUserName(name: string | undefined): void {
  knownUserName = (name ?? '').trim()
}

const PHONE_RE = /(?<!\d)(?:\+?\d[\d-]{7,}\d|1[3-9]\d{9})(?!\d)/g
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const ID_CARD_RE = /(?<!\d)\d{17}[\dXx](?!\d)/g
const BANK_CARD_RE = /(?<!\d)\d{16,19}(?!\d)/g
const WIN_PATH_RE = /(?:[A-Za-z]:\\[^\\\s]+(?:\\[^\\\s]+)+|%USERPROFILE%[^\s]*)/g
const UNIX_HOME_RE = /(?:\/(?:home|Users)\/[^\s/]+)/g
const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/gi

/** 健康词表:疾病/药物语境的保守匹配(中文常见词,宁枉勿纵) */
const HEALTH_RE =
  /(抑郁[症]?)|(焦虑[症]?)|(确诊)|(处方)|(服药)|(吃药)|(用药)|(住院)|(复诊)|(随访)|( Insulin\b)|(metformin)/gi

/** redactText:实体掩码 + scrubSecrets + 截断记原长。maxLen 缺省按文本类型在调用方给 */
export function redactText(input: string, maxLen = 500): string {
  let out = scrubSecrets(input)
  if (knownUserName) out = out.split(knownUserName).join('[USER_NAME]')
  out = out.replace(EMAIL_RE, '[EMAIL]')
  // 顺序敏感:身份证(18)先于银行卡(16-19)先于手机号(9+),长模式在前,
  // 否则短模式会把长号码截走留下错误的占位符
  out = out.replace(ID_CARD_RE, '[IDENTITY_NUMBER]')
  out = out.replace(BANK_CARD_RE, '[BANK_CARD]')
  out = out.replace(PHONE_RE, '[PHONE]')
  out = out.replace(WIN_PATH_RE, '[LOCAL_PATH]')
  out = out.replace(UNIX_HOME_RE, '[LOCAL_PATH]')
  out = out.replace(URL_RE, '[URL]')
  out = out.replace(HEALTH_RE, '[HEALTH_INFO]')
  if (out.length > maxLen) out = `${out.slice(0, maxLen)}…[截断,原长 ${input.length}]`
  return out
}

// ---------- 指纹与语言 ----------

/** 会话随机盐:每次启动换,只用于"会话内排查重复"——不可跨会话比对,防字典还原 */
const sessionSalt = (() => {
  try {
    const buf = new Uint8Array(8)
    crypto.getRandomValues(buf)
    return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return `s${Math.random().toString(36).slice(2, 10)}`
  }
})()

/** FNV-1a 32 位:fingerprint = 会话盐 + 文本,输出 fp:xxxxxxxx */
export function fingerprintOf(text: string): string {
  let h = 0x811c9dc5
  const s = sessionSalt + text
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `fp:${(h >>> 0).toString(16).padStart(8, '0')}`
}

/** 粗粒度语言探测(面板展示用,不做语言识别) */
export function detectLanguage(text: string): string {
  if (/[\u3040-\u30ff]/.test(text)) return 'ja'
  if (/[\uac00-\ud7af]/.test(text)) return 'ko'
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  if (cjk >= Math.max(1, text.length * 0.2)) return 'zh'
  if (/[a-zA-Z]/.test(text)) return 'en'
  return 'other'
}

/** 估算 token 数(中文 ~1.6 字符/token 的粗估,面板标注"估算") */
export function estimateTokens(chars: number): number {
  return Math.round(chars / 1.6)
}
