// 记忆:使用者画像(手填)+ 机器记忆(事实/老梗/事件线/剧情线)管理。数据在挂载时拉取
import { useEffect, useState } from 'react'
import {
  getMemory,
  clearMemory,
  deleteFact,
  togglePinFact,
  type MemoryFact,
} from '../../storage/memoryStore'
import { getBond, getStory, removeArc, removeStoryItem, type StoryData } from '../../storage/storyStore'
import { bondTierOf } from '../../engine/interactionRules'
import { useSettings } from '../useSettingsSession'
import { SettingsCard, SetField } from '../SettingsPrimitives'

/** 记忆事实分类的中文标签 */
const MEM_CAT_LABEL: Record<string, string> = {
  identity: '身份',
  preference: '喜好',
  habit: '习惯',
  people: '身边人',
  event: '事件',
  other: '其他',
}

export function MemorySettings() {
  const { form, setForm, saveField, flashCard } = useSettings()
  // 记忆系统的机器事实列表
  const [memoryFacts, setMemoryFacts] = useState<MemoryFact[]>([])
  const [clearMemArmed, setClearMemArmed] = useState(false)
  // 角色世界(两人之间的老梗/未了结事件)
  const [storyData, setStoryData] = useState<StoryData | null>(null)
  // 长期关系一句话摘要
  const [bondLine, setBondLine] = useState<string | null>(null)

  useEffect(() => {
    void refreshMemoryFacts()
    void refreshStory()
  }, [])

  async function refreshMemoryFacts() {
    setMemoryFacts((await getMemory()).facts)
  }

  /** 刷新角色世界列表 + 长期关系摘要 */
  async function refreshStory() {
    setStoryData(await getStory())
    const bond = await getBond()
    const tier = bondTierOf(bond.trust, bond.rivalry)
    setBondLine(
      tier === 'warm'
        ? '怎么闹都闹不散的老搭档——嘴上互相嫌弃,底线下护着对方'
        : tier === 'strained'
          ? '见面就掐,旧账摞了一摞——但谁也没真走过'
          : bond.rivalry >= 3
            ? '最近摩擦升级,见面就较劲,谁也不服谁'
            : '平平淡淡的老搭档,偶尔斗嘴,基本和睦',
    )
  }

  return (
    <>
      <SettingsCard card="使用者画像" flash={flashCard} title="使用者画像" desc="角色据此认识你">
        <SetField label="你的称呼" htmlFor="cfg-mem-name">
          <input
            id="cfg-mem-name"
            placeholder="角色会这样叫你"
            value={form.userProfile.userName}
            onChange={(e) => {
              const next = { ...form.userProfile, userName: e.target.value }
              setForm({ ...form, userProfile: next })
              saveField({ userProfile: next })
            }}
          />
        </SetField>
        <SetField label="职业 / 身份" htmlFor="cfg-mem-occ">
          <input
            id="cfg-mem-occ"
            placeholder="如:在读研究生"
            value={form.userProfile.occupation}
            onChange={(e) => {
              const next = { ...form.userProfile, occupation: e.target.value }
              setForm({ ...form, userProfile: next })
              saveField({ userProfile: next })
            }}
          />
        </SetField>
        <div className="set-grid">
          <SetField label="喜欢(逗号分隔)" htmlFor="cfg-mem-likes">
            <input
              id="cfg-mem-likes"
              value={form.userProfile.likes}
              onChange={(e) => {
                const next = { ...form.userProfile, likes: e.target.value }
                setForm({ ...form, userProfile: next })
                saveField({ userProfile: next })
              }}
            />
          </SetField>
          <SetField label="不喜欢(逗号分隔)" htmlFor="cfg-mem-dis">
            <input
              id="cfg-mem-dis"
              value={form.userProfile.dislikes}
              onChange={(e) => {
                const next = { ...form.userProfile, dislikes: e.target.value }
                setForm({ ...form, userProfile: next })
                saveField({ userProfile: next })
              }}
            />
          </SetField>
        </div>
        <SetField label="雷区(完全不聊)" htmlFor="cfg-mem-ban">
          <input
            id="cfg-mem-ban"
            placeholder="如:考试,前任"
            value={form.userProfile.banTopics}
            onChange={(e) => {
              const next = { ...form.userProfile, banTopics: e.target.value }
              setForm({ ...form, userProfile: next })
              saveField({ userProfile: next })
            }}
          />
        </SetField>
      </SettingsCard>
      <SettingsCard
        card="记住的事"
        flash={flashCard}
        title={`记住的事(${memoryFacts.length})`}
        desc="和角色聊天时透露的信息会被自动记住"
        action={
          <button
            className={`hist-clear${clearMemArmed ? ' danger' : ''}`}
            disabled={memoryFacts.length === 0}
            onClick={() => {
              if (!clearMemArmed) {
                setClearMemArmed(true)
                window.setTimeout(() => setClearMemArmed(false), 3000)
                return
              }
              void (async () => {
                await clearMemory()
                setMemoryFacts([])
                setClearMemArmed(false)
              })()
            }}
          >
            {clearMemArmed ? '确认清空?' : '清空全部'}
          </button>
        }
      >
        {memoryFacts.length === 0 && (
          <div className="set-note">还没有记忆 — 聊天中透露的信息会出现在这里</div>
        )}
        {memoryFacts.map((f) => (
          <div className="mem-fact" key={f.id}>
            <span className="mem-cat">{MEM_CAT_LABEL[f.category]}</span>
            <span className="mem-content">{f.content}</span>
            <button
              className={`mem-btn${f.pinned ? ' on' : ''}`}
              title={f.pinned ? '取消置顶' : '置顶(永不遗忘)'}
              onClick={() => void (async () => { await togglePinFact(f.id); await refreshMemoryFacts() })()}
            >
              📌
            </button>
            <button
              className="mem-btn"
              title="忘记这条"
              onClick={() => void (async () => { await deleteFact(f.id); await refreshMemoryFacts() })()}
            >
              ✕
            </button>
          </div>
        ))}
      </SettingsCard>
      <SettingsCard
        card="角色世界"
        flash={flashCard}
        title="角色世界"
        desc="两人之间的老梗/未了结事件,演出中会偶尔回收"
      >
        {(storyData?.gags.length ?? 0) === 0 && (storyData?.threads.length ?? 0) === 0 && (
          <div className="set-note">还没有角色共同记忆 — 演出几集后会自动积累</div>
        )}
        {storyData?.gags.map((g) => (
          <div className="mem-fact" key={g.id}>
            <span className="mem-cat">老梗</span>
            <span className="mem-content">{g.text}</span>
            <button
              className="mem-btn"
              title="删掉这条老梗"
              onClick={() => void (async () => { await removeStoryItem('gags', g.id); await refreshStory() })()}
            >
              ✕
            </button>
          </div>
        ))}
        {storyData?.threads.map((t) => (
          <div className="mem-fact" key={t.id}>
            <span className="mem-cat">未了结</span>
            <span className="mem-content">{t.text}</span>
            <button
              className="mem-btn"
              title="删掉这条事件线"
              onClick={() => void (async () => { await removeStoryItem('threads', t.id); await refreshStory() })()}
            >
              ✕
            </button>
          </div>
        ))}
        {bondLine && (
          <div className="mem-fact">
            <span className="mem-cat">关系</span>
            <span className="mem-content">{bondLine}</span>
          </div>
        )}
      </SettingsCard>
      <SettingsCard
        card="连续剧情"
        flash={flashCard}
        title="连续剧情"
        desc="多集推进的剧情线,约 30% 的集数会演下一拍"
      >
        {(storyData?.arcs.length ?? 0) === 0 && (
          <div className="set-note">还没有剧情线 — 演出中冒出的连续剧情会出现在这里</div>
        )}
        {storyData?.arcs.map((a) => (
          <div className="mem-fact" key={a.id}>
            <span className="mem-cat">{a.status === 'done' ? '完结' : `第${a.stage}拍`}</span>
            <span className="mem-content">
              《{a.title}》{a.status === 'done' ? `结局:${a.ending ?? '已收尾'}` : `下一拍:${a.nextHook}`}
            </span>
            <button
              className="mem-btn"
              title="删掉这条剧情线"
              onClick={() => void (async () => { await removeArc(a.id); await refreshStory() })()}
            >
              ✕
            </button>
          </div>
        ))}
      </SettingsCard>
    </>
  )
}
