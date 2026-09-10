// 工具与隐私:截屏快捷键/录屏排除、网页版生成实验、隐私说明。
// 网页版生成的窗口/状态轮询是本页私有的临时会话,挂载期间存活、切走即止。
import { useEffect, useRef, useState } from 'react'
import { WEBCHAT_SITES, webchatLogin, webchatProbe, webchatRestoreMain } from '../../engine/webchat'
import type { AppConfig } from '../../storage/configStore'
import { useSettings } from '../useSettingsSession'
import { HotkeyRecorder, SettingsCard, SetField, SetLine, SetSwitch } from '../SettingsPrimitives'

export function PrivacySettings() {
  const { form, setForm, saveField, flashCard } = useSettings()
  // 网页版生成:窗口/就绪状态的一行展示文本
  const [webchatStatusText, setWebchatStatusText] = useState('')
  const webchatPollRef = useRef(0)

  // 登录就绪轮询每 4 秒探测一次;切走本页/关窗即停,不留后台空转
  useEffect(() => () => window.clearInterval(webchatPollRef.current), [])

  /** 打开 Edge 窗口给用户登录(角色暂时隐藏让路);轮询就绪后自动恢复角色 */
  async function openWebchatWindow() {
    try {
      setWebchatStatusText('正在打开 Edge 窗口…')
      await webchatLogin(form.webchatSite)
      setWebchatStatusText('Edge 已打开:登录一次,成功后角色自动恢复')
      startWebchatReadyPoll()
    } catch (e) {
      setWebchatStatusText(`打开失败:${String(e)}`)
    }
  }

  /** 每 4 秒探测一次目标站点可否发消息,登录成功即恢复角色;最多等 5 分钟 */
  function startWebchatReadyPoll() {
    window.clearInterval(webchatPollRef.current)
    const started = Date.now()
    webchatPollRef.current = window.setInterval(() => {
      if (Date.now() - started > 5 * 60_000) {
        window.clearInterval(webchatPollRef.current)
        setWebchatStatusText('等待登录超时:登录完成后可点「查状态」或「恢复角色」')
        return
      }
      void webchatProbe()
        .then((p) => {
          if (!p.ready) {
            setWebchatStatusText(`探测中:${p.detail}`)
            return
          }
          window.clearInterval(webchatPollRef.current)
          setWebchatStatusText('已就绪 ✓ 登录成功,角色已恢复——可以直接点播了')
        })
        .catch((e) => setWebchatStatusText(`探测异常:${String(e)}`))
    }, 4000)
  }

  async function refreshWebchatStatus() {
    try {
      setWebchatStatusText('检查中…')
      const p = await webchatProbe()
      setWebchatStatusText(p.ready ? '已就绪 ✓(角色已恢复)' : `未就绪:${p.detail}`)
    } catch (e) {
      setWebchatStatusText(`状态获取失败:${String(e)}`)
    }
  }

  async function restoreMain() {
    try {
      await webchatRestoreMain()
      setWebchatStatusText('角色已恢复')
    } catch (e) {
      setWebchatStatusText(`恢复失败:${String(e)}`)
    }
  }

  return (
    <>
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
        <SetLine title="截屏/录屏时排除角色" hint="角色不进任何截图与录屏(Win10 2004+)">
          <SetSwitch
            checked={form.screenshot.hideSelf}
            label="截屏/录屏时排除角色"
            onChange={(v) => {
              const next = { ...form.screenshot, hideSelf: v }
              setForm({ ...form, screenshot: next })
              saveField({ screenshot: next }, true) // commit 内统一执行角色排除
            }}
          />
        </SetLine>
      </SettingsCard>
      <SettingsCard card="网页版生成" flash={flashCard} title="网页版生成" desc="实验">
        <SetLine
          title="主演出改用网页模型生成"
          hint="仅相声/日常段子走网页模型,记忆提取等小调用仍走 API;失败自动回退"
        >
          <SetSwitch
            checked={form.webchatEnabled}
            label="主演出改用网页模型生成"
            onChange={(v) => {
              setForm({ ...form, webchatEnabled: v })
              saveField({ webchatEnabled: v }, true)
            }}
          />
        </SetLine>
        {form.webchatEnabled && (
          <>
            <SetField label="网页模型站点" htmlFor="cfg-webchat-site">
              <select
                id="cfg-webchat-site"
                value={form.webchatSite}
                onChange={(e) => {
                  setForm({ ...form, webchatSite: e.target.value as AppConfig['webchatSite'] })
                  saveField({ webchatSite: e.target.value as AppConfig['webchatSite'] }, true)
                }}
              >
                {WEBCHAT_SITES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </SetField>
            <SetLine title="网页窗口" hint="首次需登录一次,登录态长期有效">
              <div className="shot-key-row">
                <button id="cfg-webchat-login" className="panel-btn" onClick={openWebchatWindow}>
                  打开窗口
                </button>
                <button className="panel-btn" onClick={() => void refreshWebchatStatus()}>
                  查状态
                </button>
                <button className="panel-btn" onClick={() => void restoreMain()}>
                  恢复角色
                </button>
              </div>
            </SetLine>
            {webchatStatusText && <div className="set-note">{webchatStatusText}</div>}
            <div className="set-note">
              生成用系统 Edge 的独立窗口(独立 profile,不影响日常浏览):登录一次长期有效;生成时会出现
              Edge 标签页,可最小化,完成后自动关闭。
            </div>
          </>
        )}
      </SettingsCard>
      <SettingsCard card="隐私与数据" flash={flashCard} title="隐私与数据">
        <div className="set-note">
          所有设置、记忆与历史仅保存在本机;桌面环境感知只在本机给应用分类,不上传窗口内容;截屏只在你按快捷键时进行;备忘里别写密码、验证码这类敏感信息。
        </div>
      </SettingsCard>
    </>
  )
}
