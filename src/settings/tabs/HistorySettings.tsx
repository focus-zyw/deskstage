// 演出历史:回放(经 bridge 交回应用)、收藏、删除。列表挂载时拉取
import { useEffect, useState } from 'react'
import { listEpisodes, deleteEpisodes, toggleFavorite, type Episode } from '../../storage/historyStore'
import { bumpTopicFavored } from '../../storage/memoryStore'
import { modeOf } from '../../performer/modes'
import { useSettings } from '../useSettingsSession'
import { SettingsCard } from '../SettingsPrimitives'
import { fmtTime } from '../format'

export function HistorySettings() {
  const { bridge, flashCard } = useSettings()
  const [episodes, setEpisodes] = useState<Episode[]>([])
  const [clearHistArmed, setClearHistArmed] = useState(false)

  useEffect(() => {
    void refreshEpisodes()
  }, [])

  async function refreshEpisodes() {
    setEpisodes(await listEpisodes())
  }

  async function onToggleFav(ep: Episode) {
    const nowFav = await toggleFavorite(ep)
    if (nowFav) bumpTopicFavored(ep.topic) // 收藏 = 口味正信号
    await refreshEpisodes()
  }

  async function onDeleteEpisode(ep: Episode) {
    await deleteEpisodes(new Set([ep.ts]))
    setEpisodes(await listEpisodes())
  }

  async function onClearUnfavorited() {
    await deleteEpisodes(new Set(episodes.filter((e) => !e.fav).map((e) => e.ts)))
    await refreshEpisodes()
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
