// 收藏的对话:数据管理组独立分页(与历史平级)。数据是 favorites.json 的整集拷贝,
// 历史原件独立存在——★取消收藏只移除收藏拷贝(原件回到普通流水),✕彻底删除才
// 连历史原件一起清。点击行回放,经 bridge 交回应用(同历史页)。
import { useEffect, useState } from 'react'
import { listFavorites, deleteEpisodes, toggleFavorite, type Episode } from '../../storage/historyStore'
import { modeOf } from '../../performer/modes'
import { useSettings } from '../useSettingsSession'
import { SettingsCard } from '../SettingsPrimitives'
import { fmtTime } from '../format'

export function FavoritesSettings() {
  const { bridge, flashCard } = useSettings()
  const [favs, setFavs] = useState<Episode[]>([])

  useEffect(() => {
    void refreshFavorites()
  }, [])

  async function refreshFavorites() {
    setFavs(await listFavorites())
  }

  /** 仅取消收藏:收藏拷贝移除,历史原件保留,回到普通流水 */
  async function onUnfavorite(ep: Episode) {
    await toggleFavorite(ep)
    await refreshFavorites()
  }

  /** 彻底删除:历史原件 + 收藏拷贝一起清(删历史不动收藏库,需两步) */
  async function onDeleteForever(ep: Episode) {
    await deleteEpisodes(new Set([ep.ts]))
    await toggleFavorite(ep)
    await refreshFavorites()
  }

  return (
    <SettingsCard
      card="收藏的对话"
      flash={flashCard}
      title={`收藏的对话(${favs.length})`}
      desc="整集收藏,独立于历史保存;重放权重更高,且不会被「清空未收藏」清理"
    >
      <div className="hist-list">
        {favs.length === 0 && (
          <div className="hist-empty">还没有收藏——在历史里点亮 ☆,收藏的对话不会被清理且重放权重更高</div>
        )}
        {favs.map((ep) => {
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
                className="hist-fav on"
                title="取消收藏(保留在历史里)"
                onClick={(e) => {
                  e.stopPropagation()
                  void onUnfavorite(ep)
                }}
              >
                ★
              </button>
              <button
                className="hist-del"
                title="彻底删除(历史原件与收藏拷贝一起清,不可恢复)"
                onClick={(e) => {
                  e.stopPropagation()
                  void onDeleteForever(ep)
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
