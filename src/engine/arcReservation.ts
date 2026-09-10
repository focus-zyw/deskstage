// 连续剧情拍的进程内占用协调：所有模式共享同一组剧情 ID，避免并发生成同一拍。
import { pickArcBeat, type StoryArc } from '../storage/storyStore'

export interface ArcBeat {
  id: string
  title: string
  hook: string
  stage: number
}

export interface ArcReservation {
  beat: ArcBeat
  /** 幂等释放；生成结果进入持久化预生成缓存后即可释放进程内占用 */
  release: () => void
}

const inFlightArcIds = new Set<string>()

/**
 * 尝试占用一条剧情拍。inFlightArcIds 防同进程并发，occupiedArcIds 防与已落入缓存的拍重复。
 * 返回 null 表示本轮不走连续剧情（概率未命中或候选都已占用）。
 */
export function reserveArcBeat(
  arcs: StoryArc[],
  occupiedArcIds: ReadonlySet<string> = new Set(),
  rng: () => number = Math.random,
): ArcReservation | null {
  const available = arcs.filter(
    (arc) => !inFlightArcIds.has(arc.id) && !occupiedArcIds.has(arc.id),
  )
  const beat = pickArcBeat(available, rng)
  if (!beat) return null
  inFlightArcIds.add(beat.id)
  let released = false
  return {
    beat,
    release: () => {
      if (released) return
      released = true
      inFlightArcIds.delete(beat.id)
    },
  }
}
