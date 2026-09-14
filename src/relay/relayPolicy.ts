// AI 剧场的默认轮次策略。运行时与回归测试共用，避免参数散落后再次退回短场。
export const AI_THEATER_TURN_POLICY = Object.freeze({
  minTurns: 8,
  maxTurns: 12,
})
