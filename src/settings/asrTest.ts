export type AsrTestState = { state: 'idle' | 'testing' | 'ok' | 'fail'; msg: string }

/** 真实录音识别必须拿到非空文字才算成功；HTTP 200 + 空串只说明服务响应了。 */
export function recognitionTestOutcome(text: string, ms: number): AsrTestState {
  const clean = text.trim()
  if (!clean) {
    return { state: 'fail', msg: `服务已响应(${ms} ms),但未识别到文字;请靠近麦克风并清楚说一句话后重试` }
  }
  const preview = [...clean].slice(0, 80).join('')
  return { state: 'ok', msg: `识别正常(${ms} ms):“${preview}”` }
}
