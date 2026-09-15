// 表达导演系统的唯一公共出口:外部(worker/session/测试)只 import 这里,
// 内部实现(policy/voiceProfile/callbackPicker/promptRenderer/qualityGate/
// preferenceStore/director)不直接被外部引用,保持 seam 收口。
// 阶段一(方案 §十)只接默认群聊 Actor 管线;其余通道属二阶段。

export type {
  CallbackRef,
  ExpressionChannel,
  ExpressionInput,
  ExpressionIntent,
  ExpressionLength,
  ExpressionMove,
  ExpressionPlan,
  ExpressionStance,
  ExpressionTrace,
  GateIssue,
} from './types'
export { LENGTH_BOUNDS } from './types'
export {
  createExpressionDirector,
  expressionDirector,
  type ExpressionDirector,
  type ExpressionDirectorDeps,
} from './director'
export {
  BUILTIN_MECHANICS,
  NEUTRAL_MECHANICS,
  catchphrasesOf,
  deriveMechanics,
  voiceMechanicsOf,
  type VoiceMechanics,
} from './voiceProfile'
export { runQualityGate, type GateContext, type GateResult } from './qualityGate'
export { normalizeForMatch, pickCallback, type PickCallbackArgs } from './callbackPicker'
export { renderInstruction, type RenderInstructionArgs } from './promptRenderer'
export {
  BASE_WEIGHTS,
  CALLBACK_GAP_ROUNDS,
  CATCHPHRASE_GAP_ROUNDS,
  MOVE_REPEAT_LIMIT,
  detectTask,
  eligibleMoves,
  freshPolicyState,
  decidePlanCore,
  type DecideArgs,
  type PlanCore,
  type PolicyState,
} from './policy'
export {
  createPreferenceStore,
  keyOf,
  preferenceMultiplier,
  sanitizePreferenceTable,
  type FeaturePreference,
  type PreferenceIo,
  type PreferenceStore,
  type PreferenceTable,
} from './preferenceStore'
