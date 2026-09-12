// 主按钮(Dock 上播放/停止合并位)的状态纯函数:
// RuntimeMode → 按钮语义(label/kind/disabled/title),供 ControlBar 渲染与单测锁定。
// 禁止在组件里用 busy+canStop 组合推断——生成中必须能停止,旧组合做不到。

export type PerformanceState =
  | 'idle' // 空闲(普通模式选中)
  | 'idle-live' // 空闲但选中主播模式:按钮语义是开播
  | 'generating' // LLM 生成中(点播等待,可取消)
  | 'performing' // 演出中
  | 'choosing' // 中途选边等待
  | 'streaming' // 直播弹幕互动中
  | 'locked' // 截屏框选/音色录制等工具占用(禁用)

export interface PerformanceButtonView {
  label: string
  /** 'generate' = 触发开播/点播;'stop' = 触发停止 */
  kind: 'generate' | 'stop'
  disabled: boolean
  title: string
}

export function performanceButton(state: PerformanceState): PerformanceButtonView {
  switch (state) {
    case 'idle':
      return { label: '开始一段', kind: 'generate', disabled: false, title: '开始一段(按当前模式点播)' }
    case 'idle-live':
      return { label: '开播', kind: 'generate', disabled: false, title: '开播(直播弹幕互动)' }
    case 'generating':
      return { label: '取消生成', kind: 'stop', disabled: false, title: '取消本次生成' }
    case 'performing':
      return { label: '停止演出', kind: 'stop', disabled: false, title: '停止当前演出' }
    case 'choosing':
      return { label: '停止演出', kind: 'stop', disabled: false, title: '停止演出(放弃本次站队)' }
    case 'streaming':
      return { label: '下播', kind: 'stop', disabled: false, title: '下播(结束直播弹幕互动)' }
    case 'locked':
      // 截屏/录音等工具占用:沿用底层语义标签但禁用,防止打断工具流程
      return { label: '停止演出', kind: 'stop', disabled: true, title: '截屏/录音进行中,暂不可操作' }
  }
}
