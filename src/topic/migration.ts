// 旧 config.topicOverride(锁定直到清除)→ 话题会话的幂等迁移(V2 §11 四步序):
// ① override 有值且无同值迁移标记的会话 → CAS 写入 strict + until-cleared 会话
// ② 会话带 migratedFromOverride 指纹标记
// ③ 会话写成功后清空 config.topicOverride
// ④ 中途崩溃:重跑识别标记,只执行剩余清理(不覆盖用户已另建的会话)
// 迁移失败一律静默(旧字段保留,下次启动重试),绝不阻塞启动。

import { mutateTopicState } from './store'
import { manualCardFromText } from './catalog'
import { fingerprintOf } from './planner'

export interface LegacyOverrideDeps {
  /** 读旧锁定主题(config.topicOverride) */
  getOverride: () => Promise<string | null>
  /** 清空旧锁定主题(saveConfig({ topicOverride: null })) */
  clearOverride: () => Promise<void>
}

/**
 * 执行迁移;返回是否消费了旧字段(清空了 topicOverride)。
 * 幂等:任意步骤后重跑都安全——有同标记会话则只补清理,有其他会话则放弃写入只清理。
 */
export async function migrateLegacyTopicOverride(deps: LegacyOverrideDeps): Promise<boolean> {
  let override = ''
  try {
    override = (await deps.getOverride())?.trim() ?? ''
  } catch {
    return false
  }
  if (!override) return false

  const fp = fingerprintOf(override)
  let sessionWritten = false
  try {
    await mutateTopicState((state) => {
      if (state.session) {
        // 已有会话(同标记=上次迁移只差清理;其他会话=用户已重新选择):不动会话
        return { state, result: false }
      }
      const card = manualCardFromText(override)
      const now = Date.now()
      state.session = {
        id: `tse-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        rootCard: card,
        currentCard: card,
        policy: 'strict',
        duration: 'until-cleared',
        remainingEpisodes: null,
        stage: 'open',
        usedFingerprints: [],
        usedAngles: [],
        revision: 1,
        createdAt: now,
        updatedAt: now,
        migratedFromOverride: fp,
      }
      state.revision += 1
      sessionWritten = true
      return { state, result: true }
    })
  } catch (e) {
    console.warn('旧锁定主题迁移失败(下次启动重试)', e)
    return false
  }
  // 会话侧已就绪(或本就无需写),清空旧字段;若这里崩溃,重跑走"同标记只补清理"分支
  try {
    await deps.clearOverride()
  } catch (e) {
    console.warn('旧锁定主题字段清理失败(下次启动重试)', e)
    return false
  }
  return sessionWritten
}
