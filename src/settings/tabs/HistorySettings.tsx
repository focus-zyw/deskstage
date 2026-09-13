// 演出历史:回放(经 bridge 交回应用)、收藏、删除、赞/踩补评。列表挂载时拉取
import { useEffect, useState } from 'react'
import { listEpisodes, deleteEpisodes, toggleFavorite, type Episode } from '../../storage/historyStore'
import { topicDirector } from '../../topic/director'
import { rateEpisode, removeRatings, getRatings, type Rating, type FeedbackTable } from '../../storage/feedbackStore'
import { modeOf } from '../../performer/modes'
import { useSettings } from '../useSettingsSession'
import { SettingsCard } from '../SettingsPrimitives'
import { fmtTime } from '../format'

export function HistorySettings() {
  const { bridge, flashCard } = useSettings()
  const [episodes, setEpisodes] = useState<Episode[]>([])
  const [ratings, setRatings] = useState<FeedbackTable>({})
  const [clearHistArmed, setClearHistArmed] = useState(false)

  // 挂载拉取:内联 .then + 卸载守卫,避免组件函数在 effect 里自引用触发级联渲染
  useEffect(() => {
    let alive = true
    void listEpisodes().then((eps) => {
      if (alive) setEpisodes(eps)
    })
    void getRatings().then((r) => {
      if (alive) setRatings(r)
    })
    return () => {
      alive = false
    }
  }, [])

  async function refreshEpisodes() {
    setEpisodes(await listEpisodes())
  }

  async function onToggleFav(ep: Episode) {
    const nowFav = await toggleFavorite(ep)
    // 收藏切换 = 话题事件(可逆;唯一写入口 TopicDirector.record)
    if (nowFav && ep.eid) await topicDirector.record({ type: 'favorite-changed', eid: ep.eid, favored: true })
    await refreshEpisodes()
  }

  /** 赞/踩补评(再点同键撤销);话题口味由 TopicDirector.record 事件记账,改评自动覆盖 */
  async function onRate(ep: Episode, rating: Rating) {
    if (!ep.eid) return
    const next = ratings[ep.eid]?.rating === rating ? null : rating
    await rateEpisode(ep.eid, { ts: ep.ts, mode: ep.mode, topic: ep.topic }, next)
    await topicDirector.record({ type: 'rating-changed', eid: ep.eid, value: next })
    setRatings(await getRatings())
  }

  async function onDeleteEpisode(ep: Episode) {
    await deleteEpisodes(new Set([ep.ts]))
    await removeRatings([ep.eid]) // 台词没了,评价挂着也无意义
    setEpisodes(await listEpisodes())
    setRatings(await getRatings())
  }

  async function onClearUnfavorited() {
    const doomed = episodes.filter((e) => !e.fav)
    await deleteEpisodes(new Set(doomed.map((e) => e.ts)))
    await removeRatings(doomed.map((e) => e.eid))
    setEpisodes(await listEpisodes())
    setRatings(await getRatings())
  }

  return (
    <SettingsCard
      card="演出历史"
      flash={flashCard}
      title={`演出历史(${episodes.length})`}
      desc="点击一行即可回放;收藏不会被清理且重放权重更高,收藏的对话可在「收藏」页管理"
      action={
        <button
          className={`hist-clear${clearHistArmed ? ' danger' : ''}`}
          disabled={episodes.every((e) => e.fav) || episodes.length === 0}
          onClick={() => {
            if (!clearHistArmed) {
              setClearHistArmed(true)
              window.setTimeout(() => setClearHistArmed(false), 3000)
              return
            }
            setClearHistArmed(false)
            void onClearUnfavorited()
          }}
        >
          {clearHistArmed ? '确认清空?' : '清空未收藏'}
        </button>
      }
    >
      <div className="hist-list">
        {episodes.length === 0 && (
          <div className="hist-empty">还没有历史对话，点 ▶ 生成一集试试</div>
        )}
        {episodes.map((ep) => {
          const bm = modeOf(ep.mode)
          return (
            <div
              className="hist-row"
              key={ep.ts}
              title="点击回放此段"
              onClick={() => bridge.onReplay(ep)}
            >
              <span className="hist-mode" style={{ background: bm.accent }}>
                {bm.label}
              </span>
              <div className="hist-main">
                <div className="hist-preview">{ep.lines[0]?.text ?? ''}</div>
                <div className="hist-meta">
                  {fmtTime(ep.ts)} · {ep.lines.length} 句
                  {ep.topic ? ` · ${ep.topic}` : ''}
                </div>
              </div>
              {ep.eid && (
                <>
                  <button
                    className={`hist-rate${ratings[ep.eid]?.rating === 'up' ? ' on' : ''}`}
                    title={ratings[ep.eid]?.rating === 'up' ? '撤销赞' : '赞这一集（以后多演这类）'}
                    onClick={(e) => {
                      e.stopPropagation()
                      void onRate(ep, 'up')
                    }}
                  >
                    👍
                  </button>
                  <button
                    className={`hist-rate down${ratings[ep.eid]?.rating === 'down' ? ' on' : ''}`}
                    title={ratings[ep.eid]?.rating === 'down' ? '撤销踩' : '踩这一集（以后少来这套）'}
                    onClick={(e) => {
                      e.stopPropagation()
                      void onRate(ep, 'down')
                    }}
                  >
                    👎
                  </button>
                </>
              )}
              <button
                className={`hist-fav${ep.fav ? ' on' : ''}`}
                title={ep.fav ? '取消收藏' : '收藏（不会被删除，重放权重更高）'}
                onClick={(e) => {
                  e.stopPropagation()
                  void onToggleFav(ep)
                }}
              >
                {ep.fav ? '★' : '☆'}
              </button>
              <button
                className="hist-del"
                title={ep.fav ? '收藏对话不可删除' : '删除此段'}
                disabled={ep.fav}
                onClick={(e) => {
                  e.stopPropagation()
                  void onDeleteEpisode(ep)
                }}
              >
                ✕
              </button>
            </div>
          )
        })}
      </div>
    </SettingsCard>
  )
}
