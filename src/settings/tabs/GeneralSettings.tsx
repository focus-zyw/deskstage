// 基础设置:显示与布局 / 演出与主动行为 / 环境与桌面
import { saveConfig, useConfigSnapshot } from '../../storage/configStore'
import { useRuntime, setCharHidden as setRuntimeCharHidden } from '../../runtime/runtimeMode'
import { applyLaunchOnBoot } from '../../runtime/launchOnBoot'
import { useSettings } from '../useSettingsSession'
import { SettingsCard, SetField, SetLine, SetSwitch } from '../SettingsPrimitives'

/** 隐藏/显示角色(立即落盘) */
function setCharsHidden(v: boolean) {
  setRuntimeCharHidden(v)
  saveConfig({ charactersHidden: v }).catch((e) => console.warn('显示开关保存失败(静默)', e))
}

export function GeneralSettings() {
  const { form, setForm, saveField, bridge, flashCard } = useSettings()
  const charHidden = useRuntime().charHidden
  // 水印开关的已保存值(草稿回填之外的直接落盘项)
  const saved = useConfigSnapshot()

  return (
    <>
      <SettingsCard card="显示与布局" flash={flashCard} title="显示与布局">
        <SetLine title="显示角色" hint="在桌面上显示两位角色立绘">
          <SetSwitch checked={!charHidden} onChange={(v) => setCharsHidden(!v)} />
        </SetLine>
        <SetLine title="显示常驻角色C" hint="甲乙之间的 WebM 小管家;关闭后她的台词回落画外音">
          <SetSwitch
            checked={saved.characters.C.enabled}
            label="显示常驻角色C"
            onChange={(v) => {
              const characters = { ...saved.characters, C: { ...saved.characters.C, enabled: v } }
              setForm({ ...form, characters })
              saveField({ characters }, true)
            }}
          />
        </SetLine>
        <SetLine title="角色与控制栏位置" hint="拖动角色可移动,悬停滚轮可同步缩放">
          <button className="panel-btn" onClick={bridge.onResetLayout}>
            恢复默认布局
          </button>
          <button className="panel-btn" onClick={bridge.onResetC}>
            恢复C的位置
          </button>
        </SetLine>
      </SettingsCard>
      <SettingsCard card="演出与主动行为" flash={flashCard} title="演出与主动行为">
        <SetField
          label="空闲自动重放"
          htmlFor="cfg-replay"
          hint="空闲多少分钟后自动重放一集历史,留空 = 关闭"
        >
          <input
            id="cfg-replay"
            type="number"
            min={1}
            max={1440}
            step={1}
            placeholder="留空则不自动重放"
            value={form.autoReplayMin || ''}
            onChange={(e) => {
              const raw = e.target.value
              // 空串/非法输入按 0(关闭)存,不往输入框里塞 0 硬占位
              const v = raw.trim() === '' ? 0 : Math.max(0, Number(raw) || 0)
              setForm({ ...form, autoReplayMin: v })
              saveField({ autoReplayMin: v })
            }}
          />
        </SetField>
        <SetLine title="主动程度" hint="自发闲聊/提醒/重放的频率上限(每小时)">
          <div className="seg-group">
            {(
              [
                ['quiet', '安静(3)'],
                ['balanced', '平衡(6)'],
                ['lively', '热闹(12)'],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                className={`seg-btn${form.proactivity === v ? ' on' : ''}`}
                onClick={() => {
                  setForm({ ...form, proactivity: v })
                  saveField({ proactivity: v }, true)
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </SetLine>
        <SetLine title="久坐提醒" hint="连续活跃一段时间后,角色会提醒你休息">
          <SetSwitch
            checked={form.breakReminder.enabled}
            label="久坐提醒"
            onChange={(v) => {
              const next = { ...form.breakReminder, enabled: v }
              setForm({ ...form, breakReminder: next })
              saveField({ breakReminder: next }, true)
            }}
          />
          <input
            type="number"
            min={15}
            max={120}
            step={5}
            className="break-min-input"
            title="连续活跃多少分钟后提醒(15~120)"
            value={form.breakReminder.minutes}
            onChange={(e) => {
              const next = {
                ...form.breakReminder,
                minutes: Math.min(120, Math.max(15, Number(e.target.value) || 45)),
              }
              setForm({ ...form, breakReminder: next })
              saveField({ breakReminder: next })
            }}
          />
          <span className="set-note">分钟后</span>
        </SetLine>
        <div className="set-note">使用者的兴趣爱好在「记忆」页维护 — 日常闲聊会偶尔聊到</div>
      </SettingsCard>
      <SettingsCard card="环境与桌面" flash={flashCard} title="环境与桌面">
        <SetLine title="桌面环境感知" hint="识别电量与前台应用类型,仅在本机分类,不上传明细">
          <SetSwitch
            checked={form.envSense}
            label="桌面环境感知"
            onChange={(v) => {
              setForm({ ...form, envSense: v })
              saveField({ envSense: v }, true)
            }}
          />
        </SetLine>
        <SetLine title="显示左上角水印" hint="在录屏或直播画面里标识本应用">
          <SetSwitch
            checked={saved.showWatermark}
            label="显示左上角水印"
            onChange={(v) => {
              saveField({ showWatermark: v }, true)
            }}
          />
        </SetLine>
        <SetLine title="开机自启动" hint="登录系统后自动运行本应用">
          <SetSwitch
            checked={form.launchOnBoot}
            label="开机自启动"
            onChange={(v) => {
              setForm({ ...form, launchOnBoot: v })
              saveField({ launchOnBoot: v }, true)
              void applyLaunchOnBoot(v)
            }}
          />
        </SetLine>
      </SettingsCard>
    </>
  )
}
