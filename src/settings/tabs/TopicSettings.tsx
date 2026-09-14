// 演出话题设置页:长期默认值与选题来源策略的统一落点。
// "本次怎么演"的临时调整在话题面板(本地草稿),这里只管"以后默认怎么选"——
// 设置页只写配置,不直接筛卡;来源/敏感级/角色包的语义收口在 TopicDirector/TopicCatalog。
import { useState } from 'react'
import { SettingsCard, SetLine, SetSwitch } from '../SettingsPrimitives'
import { useSettings } from '../useSettingsSession'
import { topicDirector } from '../../topic/director'
import type { TopicDistance, TopicDuration } from '../../topic/types'
import type { TopicPrefsConfig } from '../../storage/configStore'

const DURATIONS: [TopicDuration, string][] = [
  ['once', '只聊一集'],
  ['three-episodes', '连聊三集'],
  ['until-cleared', '持续到手动清除'],
]
const DISTANCES: [TopicDistance, string][] = [
  ['near', '相近'],
  ['medium', '有点意外'],
  ['far', '天马行空'],
]

export function TopicSettings() {
  const { form, setForm, saveField, flashCard, gotoTab } = useSettings()
  const prefs = form.topicPrefs
  // 两段确认:第一次点击进入待确认态(5 秒回退),再点才真正清除
  const [tasteArmed, setTasteArmed] = useState(false)

  function patchDefaults(patch: Partial<TopicPrefsConfig['defaults']>): void {
    const topicPrefs = { ...prefs, defaults: { ...prefs.defaults, ...patch } }
    setForm({ ...form, topicPrefs })
    saveField({ topicPrefs }, true)
  }
  function patchSources(patch: Partial<TopicPrefsConfig['sources']>): void {
    const topicPrefs = { ...prefs, sources: { ...prefs.sources, ...patch } }
    setForm({ ...form, topicPrefs })
    saveField({ topicPrefs }, true)
  }
  function patchPersonal(personalPolicy: TopicPrefsConfig['personalPolicy']): void {
    const topicPrefs = { ...prefs, personalPolicy }
    setForm({ ...form, topicPrefs })
    saveField({ topicPrefs }, true)
  }
  async function onClearTaste(): Promise<void> {
    if (!tasteArmed) {
      setTasteArmed(true)
      window.setTimeout(() => setTasteArmed(false), 5000)
      return
    }
    setTasteArmed(false)
    await topicDirector.clearTaste()
  }

  return (
    <>
      <SettingsCard card="默认点播方式" flash={flashCard} title="默认点播方式" desc="以后默认怎么选;演出前仍可在话题面板临时调整">
        <SetLine title="默认持续时间" hint="once 不建长期会话;三集演完自动收官">
          <div className="seg-row">
            {DURATIONS.map(([v, label]) => (
              <button
                key={v}
                className={`seg-btn${prefs.defaults.duration === v ? ' on' : ''}`}
                onClick={() => patchDefaults({ duration: v })}
              >
                {label}
              </button>
            ))}
          </div>
        </SetLine>
        <SetLine title="默认联想距离" hint="决定自动选题与上一个话题的远近">
          <div className="seg-row">
            {DISTANCES.map(([v, label]) => (
              <button
                key={v}
                className={`seg-btn${prefs.defaults.distance === v ? ' on' : ''}`}
                onClick={() => patchDefaults({ distance: v })}
              >
                {label}
              </button>
            ))}
          </div>
        </SetLine>
        <SetLine title="手动话题默认严格围绕" hint="开启后,手动输入的话题默认不偏题">
          <SetSwitch
            checked={prefs.defaults.strict}
            label="严格围绕"
            onChange={(v) => patchDefaults({ strict: v })}
          />
        </SetLine>
        <div className="set-note">这里只设置默认值;演出前仍可在话题面板中临时调整。</div>
      </SettingsCard>

      <SettingsCard card="自动选题来源" flash={flashCard} title="自动选题来源" desc="精选话题之外,自动选题还能从哪里取材">
        <SetLine title="精选话题" hint="内置的常青话题库,是自动选题的安全兜底">
          <span className="set-note">始终启用</span>
        </SetLine>
        <SetLine title="使用我的兴趣" hint="关闭后:兴趣不参与自动选题,AI 发现也不上传兴趣词">
          <SetSwitch
            checked={prefs.sources.interests}
            label="使用我的兴趣"
            onChange={(v) => patchSources({ interests: v })}
          />
        </SetLine>
        <SetLine title="使用角色故事与真实往事" hint="关闭后:不走连续剧情通道,也不取旧事候选;故事数据保留">
          <SetSwitch
            checked={prefs.sources.characterHistory}
            label="使用角色故事与真实往事"
            onChange={(v) => patchSources({ characterHistory: v })}
          />
        </SetLine>
        <SetLine title="结合桌面环境" hint="前台应用类别/时段等类别级信息,唯一开关在基础设置">
          <button className="panel-btn" onClick={() => gotoTab('general')}>
            前往基础设置
          </button>
          <span className="set-note">当前:{form.envSense ? '已开启' : '已关闭'}</span>
        </SetLine>
        <SetLine
          title="AI 扩充新话题"
          hint="候选不足时后台让模型批量想新题,会产生少量模型调用费用;关闭后中止在途请求,已缓存候选暂存但不参与选题"
        >
          <SetSwitch
            checked={prefs.sources.aiGenerated}
            label="AI 扩充新话题"
            onChange={(v) => patchSources({ aiGenerated: v })}
          />
        </SetLine>
        <div className="set-note">AI 发现节奏:池子快见底才补,有冷却与每日上限;输入只有兴趣关键词与最近话题标题,不含屏幕内容</div>
      </SettingsCard>

      <SettingsCard card="个人类话题" flash={flashCard} title="个人类话题" desc="健康、失落、关系压力等贴近个人的题目">
        <SetLine title="自动选题如何使用个人类话题">
          <div className="seg-row">
            <button
              className={`seg-btn${prefs.personalPolicy === 'manual-only' ? ' on' : ''}`}
              onClick={() => patchPersonal('manual-only')}
            >
              仅在我主动选择时使用(推荐)
            </button>
            <button
              className={`seg-btn${prefs.personalPolicy === 'allow-auto' ? ' on' : ''}`}
              onClick={() => patchPersonal('allow-auto')}
            >
              允许角色偶尔主动聊
            </button>
          </div>
        </SetLine>
        <div className="set-note">
          无论选哪档:只演绎角色自身,不默认声称你有相同问题,不诊断、不劝药、不推断你的隐私;敏感级话题始终只允许手动点播
        </div>
      </SettingsCard>

      <SettingsCard card="话题口味" flash={flashCard} title="话题口味" desc="自动学习,无需手动配置">
        <div className="set-note">
          角色会根据以下行为调整选题:
          <br />👍 喜欢 &nbsp;👎 不喜欢 &nbsp;★ 收藏 &nbsp;完整播放或较早跳过
        </div>
        <SetLine title="清除口味记录" hint="口味会随互动重新积累">
          <button className={`panel-btn${tasteArmed ? ' primary' : ''}`} onClick={() => void onClearTaste()}>
            {tasteArmed ? '再点一次确认清除' : '清除话题口味记录'}
          </button>
        </SetLine>
        <div className="set-note">
          只清除话题偏好和近期口味评分,不删除演出历史、收藏、角色记忆和真实故事
        </div>
      </SettingsCard>

      <SettingsCard card="角色适配" flash={flashCard} title="角色适配" desc="话题与当前人设的关系(自动,无需配置)">
        <div className="set-note">
          • 精选话题只保存戏剧立场,不固定角色职业
          <br />• 默认职业专属题只在对应角色使用默认人设时出现
          <br />• 角色 C 关闭后,C 专属题和新生成的 C 台词会自动隐藏
          <br />• 自定义角色 C 只按当前人设参与
        </div>
      </SettingsCard>
    </>
  )
}
