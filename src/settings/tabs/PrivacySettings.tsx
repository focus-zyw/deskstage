// 工具与隐私:录屏排除、网页版生成实验、隐私说明。
// 截屏快捷键的设置已挪到「快捷键」分页统一管理;本页只留捕获排除开关。
// 网页版生成的窗口/状态轮询是本页私有的临时会话,挂载期间存活、切走即止。
import { useEffect, useRef, useState } from 'react'
import { WEBCHAT_SITES, webchatLogin, webchatProbe, webchatRestoreMain } from '../../engine/webchat'
import type { AppConfig } from '../../storage/configStore'
import { toolList } from '../../tools/registry'
import { SiteLoginRow } from '../SiteLoginRow'
import { useSettings } from '../useSettingsSession'
import { SettingsCard, SetField, SetLine, SetSwitch } from '../SettingsPrimitives'

// 站点登录行已抽为共享组件 SiteLoginRow(AI 剧场与群聊角色绑定共用)

export function PrivacySettings() {
  const { form, setForm, saveField, flashCard } = useSettings()
  // 网页版生成:窗口/就绪状态的一行展示文本
  const [webchatStatusText, setWebchatStatusText] = useState('')
  const webchatPollRef = useRef(0)

  // 登录就绪轮询每 4 秒探测一次;切走本页/关窗即停,不留后台空转
  useEffect(() => () => window.clearInterval(webchatPollRef.current), [])

  /** 打开 Edge 窗口给用户登录；角色保持显示，轮询站点是否就绪 */
  async function openWebchatWindow() {
    try {
      setWebchatStatusText('正在打开 Edge 窗口…')
      await webchatLogin(form.webchatSite)
      setWebchatStatusText('Edge 已打开:角色保持显示,登录完成后自动确认状态')
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
          setWebchatStatusText('已就绪 ✓ 登录成功——可以直接点播了')
        })
        .catch((e) => setWebchatStatusText(`探测异常:${String(e)}`))
    }, 4000)
  }

  async function refreshWebchatStatus() {
    try {
      setWebchatStatusText('检查中…')
      const p = await webchatProbe()
      setWebchatStatusText(p.ready ? '已就绪 ✓' : `未就绪:${p.detail}`)
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
          hint="主演出点播(全部模式,含自定义)与直播弹幕回复(攒批慢速)走网页模型;记忆提取等小调用仍走 API;失败自动回退"
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
      <SettingsCard card="AI剧场" flash={flashCard} title="AI剧场" desc="实验">
        <SetLine title="启用 AI 剧场模式" hint="多个网页 AI 各演一个角色,逐轮即兴接话;实验功能,默认关">
          <SetSwitch
            checked={form.aiTheater.enabled}
            label="启用 AI 剧场模式"
            onChange={(v) => {
              const next = { ...form.aiTheater, enabled: v }
              setForm({ ...form, aiTheater: next })
              saveField({ aiTheater: next }, true)
            }}
          />
        </SetLine>
        {form.aiTheater.enabled && (
          <>
            <SetField label="甲的站点" htmlFor="cfg-theater-a">
              <select
                id="cfg-theater-a"
                value={form.aiTheater.actorA}
                onChange={(e) => {
                  const next = { ...form.aiTheater, actorA: e.target.value as AppConfig['aiTheater']['actorA'] }
                  setForm({ ...form, aiTheater: next })
                  saveField({ aiTheater: next }, true)
                }}
              >
                {WEBCHAT_SITES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </SetField>
            <SiteLoginRow label="甲登录" site={form.aiTheater.actorA} />
            <SetField label="乙的站点" htmlFor="cfg-theater-b">
              <select
                id="cfg-theater-b"
                value={form.aiTheater.actorB}
                onChange={(e) => {
                  const next = { ...form.aiTheater, actorB: e.target.value as AppConfig['aiTheater']['actorB'] }
                  setForm({ ...form, aiTheater: next })
                  saveField({ aiTheater: next }, true)
                }}
              >
                {WEBCHAT_SITES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </SetField>
            <SiteLoginRow label="乙登录" site={form.aiTheater.actorB} />
            <div className="set-note">
              两个角色各绑一个网页会话,甲乙可同站(会话独立),建议选不同模型对比效果;演出时后台会开两个
              Edge 标签页,可最小化。两个站点都需要先登录一次。
            </div>
          </>
        )}
      </SettingsCard>
      <SettingsCard card="表达导演" flash={flashCard} title="表达导演" desc="实验">
        <SetLine title="启用表达导演" hint="每轮为角色规划怎么说话(动作/立场/长度/旧梗回收),让回复更像本人;实验功能,默认关">
          <SetSwitch
            checked={form.expressionV2}
            label="启用表达导演"
            onChange={(v) => {
              setForm({ ...form, expressionV2: v })
              saveField({ expressionV2: v }, true)
            }}
          />
        </SetLine>
        <div className="set-note">
          只影响群聊角色回复的"说法",不改变谁说话与发言额度;规划在本地完成,不增加模型调用。关闭后立即回到旧版行为。
        </div>
      </SettingsCard>
      <SettingsCard card="角色工具" flash={flashCard} title="角色工具" desc="角色按对话自主使用">
        {toolList().map((t) => {
          const m = t.manifest
          const enabled = form.tools.switches[m.id] ?? m.defaultEnabled
          return (
            <SetLine
              key={m.id}
              title={m.label}
              hint={`${m.description}${m.risk === 'external' ? '(敏感:每次执行前向你确认)' : ''}`}
            >
              <SetSwitch
                checked={enabled}
                label={m.label}
                onChange={(v) => {
                  const switches = { ...form.tools.switches, [m.id]: v }
                  setForm({ ...form, tools: { ...form.tools, switches } })
                  saveField({ tools: { ...form.tools, switches } }, true)
                }}
              />
            </SetLine>
          )
        })}
        {Object.keys(form.tools.autoApproved).length > 0 && (
          <SetLine title="记住的授权" hint="敏感工具的「不再询问」记录,清除后恢复每次确认">
            <button
              className="panel-btn"
              onClick={() => {
                setForm({ ...form, tools: { ...form.tools, autoApproved: {} } })
                saveField({ tools: { ...form.tools, autoApproved: {} } }, true)
              }}
            >
              清除全部
            </button>
          </SetLine>
        )}
        <div className="set-note">
          工具调用会先按这句话判断要不要动手,再经过权限确认与超时保护;调用记录只留本机内存(最近
          50 条),不上传。屏幕/剪贴板内容识别结果只作为当轮回复的资料,不写入长期记忆。
        </div>
      </SettingsCard>
      <SettingsCard card="世界感知" flash={flashCard} title="世界感知" desc="敏感档,默认关">
        <SetLine title="读取前台窗口标题" hint="角色知道你在哪个窗口忙;标题会截断清洗、仅本机进提示词,不上传;关闭时不采集">
          <SetSwitch
            checked={form.contextSense.windowTitle}
            label="读取前台窗口标题"
            onChange={(v) => {
              const next = { ...form.contextSense, windowTitle: v }
              setForm({ ...form, contextSense: next })
              saveField({ contextSense: next }, true)
            }}
          />
        </SetLine>
        <SetLine title="桌面文件数摘要" hint="每 10 分钟统计一次桌面文件数量(不读文件名与内容),桌面太乱时角色可能会提一嘴">
          <SetSwitch
            checked={form.contextSense.desktopDigest}
            label="桌面文件数摘要"
            onChange={(v) => {
              const next = { ...form.contextSense, desktopDigest: v }
              setForm({ ...form, contextSense: next })
              saveField({ contextSense: next }, true)
            }}
          />
        </SetLine>
        <div className="set-note">
          「看桌面」与「读剪贴板」是按需工具,开关在下方「角色工具」卡里;读剪贴板默认关,只在明确要求时读取一次。
        </div>
      </SettingsCard>
      <SettingsCard card="隐私与数据" flash={flashCard} title="隐私与数据">
        <div className="set-note">
          所有设置、记忆与历史仅保存在本机;桌面环境感知只在本机给应用分类,不上传窗口内容;截屏只在你按快捷键时进行;备忘里别写密码、验证码这类敏感信息。
        </div>
      </SettingsCard>
    </>
  )
}
