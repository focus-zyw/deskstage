// 快捷键:演出控制动作与截屏的全局组合键,统一在此页管理。
// 这些是 OS 级全局快捷键(主窗口平时不持有键盘焦点,窗口内监听收不到按键),
// 任何应用在前台时按下都会触发;留空 = 未设置,不占用任何系统按键。
import { useMemo } from 'react'
import { useSettings } from '../useSettingsSession'
import { HotkeyRecorder, SettingsCard, SetLine, SetSwitch } from '../SettingsPrimitives'
import type { HotkeysConfig } from '../../storage/configStore'

/** 演出控制动作清单:顺序即 hotkeys.ts 解析时同组合键冲突的让位顺序(先到先得) */
const ACTIONS: { id: keyof HotkeysConfig; title: string; hint: string }[] = [
  { id: 'generate', title: '生成', hint: '按当前选中的模式点播一段演出(直播模式不响应,防误开播)' },
  { id: 'stop', title: '停止', hint: '结束当前演出或下播' },
  { id: 'replayRandom', title: '随机播放历史', hint: '从历史里加权随机回放一段(收藏更常被抽到)' },
  { id: 'toggleChars', title: '隐藏/显示角色', hint: '一键隐藏或恢复桌面上的角色' },
  { id: 'rateUp', title: '赞上一集', hint: '给最近自然演完的一集点个赞(以后多挑这类话题)' },
  { id: 'rateDown', title: '踩上一集', hint: '给最近自然演完的一集点个踩(以后少挑这类话题)' },
  { id: 'rateFav', title: '收藏上一集', hint: '收藏最近自然演完的一集(不会被清理,重放权重更高)' },
]

export function HotkeysSettings() {
  const { form, setForm, saveField, flashCard } = useSettings()

  /** 改某个动作的组合键:即存(hotkeys.ts 换绑由 commit 副作用统一执行) */
  function setKey(id: keyof HotkeysConfig, v: string) {
    const hotkeys = { ...form.hotkeys, [id]: v }
    setForm({ ...form, hotkeys })
    saveField({ hotkeys }, true)
  }

  // 冲突检测,口径与 hotkeys.ts 的解析规则一致:同组合键先到先得,与截屏快捷键撞车的让位截屏
  const conflicts = useMemo(() => {
    const shot = form.screenshot.hotkey.trim().toUpperCase()
    const seen = new Map<string, string>()
    const bad = new Set<keyof HotkeysConfig>()
    for (const a of ACTIONS) {
      const k = form.hotkeys[a.id].trim().toUpperCase()
      if (!k) continue
      if (k === shot || seen.has(k)) bad.add(a.id)
      else seen.set(k, a.id)
    }
    return bad
  }, [form.hotkeys, form.screenshot.hotkey])

  return (
    <>
      <SettingsCard card="演出控制" flash={flashCard} title="演出控制">
        {ACTIONS.map((a) => (
          <SetLine key={a.id} title={a.title} hint={a.hint}>
            <div className="shot-key-row">
              <HotkeyRecorder value={form.hotkeys[a.id]} onChange={(v) => setKey(a.id, v)} />
              <button className="panel-btn" disabled={!form.hotkeys[a.id]} onClick={() => setKey(a.id, '')}>
                清除
              </button>
            </div>
          </SetLine>
        ))}
        {conflicts.size > 0 && (
          <div className="set-note hotkey-conflict">
            有组合键与其他动作或截屏快捷键冲突,冲突项不会生效(先设置的优先)。
          </div>
        )}
        <div className="set-note">
          以上为系统级全局快捷键:无论前台是什么应用都会触发。留空 = 未设置,不会占用任何按键。
          单键绑定仅支持 F1~F12——字母/数字单键会被全局吞掉,任何应用里都打不出那个字符,故不收录。
        </div>
      </SettingsCard>
      <SettingsCard card="截屏" flash={flashCard} title="截屏">
        <SetLine title="全局截屏快捷键" hint="框选一块区域,截图复制到剪贴板">
          <div className="shot-key-row">
            <SetSwitch
              checked={form.screenshot.enabled}
              label="启用全局截屏快捷键"
              onChange={(v) => {
                const next = { ...form.screenshot, enabled: v }
                setForm({ ...form, screenshot: next })
                saveField({ screenshot: next }, true)
              }}
            />
            <HotkeyRecorder
              value={form.screenshot.hotkey}
              onChange={(hotkey) => {
                const next = { ...form.screenshot, hotkey }
                setForm({ ...form, screenshot: next })
                saveField({ screenshot: next }, true)
              }}
            />
          </div>
        </SetLine>
      </SettingsCard>
    </>
  )
}
