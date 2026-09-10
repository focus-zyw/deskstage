// 直播设置:直播间(平台/房间号)、B站登录(Cookie + 扫码)、礼物互动开关
import { useSettings } from '../useSettingsSession'
import { SettingsCard, SetField, SetLine, SetSwitch } from '../SettingsPrimitives'

export function LiveSettings() {
  const { form, setForm, saveField, qrLogin, beginQrLogin, cancelQrLogin, flashCard } = useSettings()

  return (
    <>
      <SettingsCard
        card="直播间"
        flash={flashCard}
        title="直播间"
        desc="直播弹幕互动;点工具栏「主播」→「开播」启动,平台 v1 仅B站可用"
      >
        <SetField label="直播平台" htmlFor="cfg-live-platform">
          <select
            id="cfg-live-platform"
            value={form.live.platform}
            onChange={(e) => {
              const live = { ...form.live, platform: e.target.value as 'bilibili' | 'douyin' }
              setForm({ ...form, live })
              saveField({ live })
            }}
          >
            <option value="bilibili">B站</option>
            <option value="douyin" disabled>
              抖音(即将支持)
            </option>
          </select>
        </SetField>
        <SetField label="直播间号(B站房间号)" htmlFor="cfg-live-room" hint="直播间网址 live.bilibili.com/ 后面的数字">
          <input
            id="cfg-live-room"
            value={form.live.roomId}
            placeholder="如 21452505"
            inputMode="numeric"
            onChange={(e) => {
              const roomId = e.target.value.replace(/\D/g, '').slice(0, 32)
              const live = { ...form.live, roomId }
              setForm({ ...form, live })
              saveField({ live })
            }}
          />
        </SetField>
      </SettingsCard>
      <SettingsCard card="B站登录" flash={flashCard} title="B站登录" desc="选填;不填也能播,只是观众名被打码">
        <SetField
          label="B站 Cookie"
          htmlFor="cfg-live-cookie"
          hint="浏览器登录B站后 F12 → 应用 → Cookie 里的 SESSDATA,只填值或整串 Cookie 都行,建议用小号。填后以该账号身份连弹幕服务器,可看到观众真实用户名与舰长等级;不填功能照常,名字显示为「某***」打码样式"
        >
          <input
            id="cfg-live-cookie"
            type="password"
            value={form.live.cookie}
            placeholder="SESSDATA 值或完整 Cookie 串,建议小号"
            onChange={(e) => {
              const live = { ...form.live, cookie: e.target.value.trim().slice(0, 600) }
              setForm({ ...form, live })
              saveField({ live })
            }}
          />
        </SetField>
        <SetLine
          title="礼物互动(道具动效与感谢语)"
          hint="观众送礼物时角色旁飞入道具并道谢,完全免 AI、无 API Key 也可用;关闭后礼物只记观众活动"
        >
          <SetSwitch
            checked={form.live.giftReactionsEnabled !== false}
            label="礼物互动(道具动效与感谢语)"
            onChange={(v) => {
              const live = { ...form.live, giftReactionsEnabled: v }
              setForm({ ...form, live })
              saveField({ live })
            }}
          />
        </SetLine>
        <SetLine title="扫码登录" hint="不想手贴?用手机B站App扫一下,自动回填并保存">
          {qrLogin ? (
            <button className="panel-btn" onClick={cancelQrLogin}>
              取消扫码
            </button>
          ) : (
            <button className="panel-btn" onClick={beginQrLogin}>
              扫码登录B站
            </button>
          )}
        </SetLine>
        {qrLogin && (
          <div className="qr-row">
            {(qrLogin.qrOfficial || qrLogin.qrClassic) && (
              <div style={{ display: 'flex', gap: 10 }}>
                {qrLogin.qrOfficial && (
                  <div style={{ textAlign: 'center' }}>
                    <img src={qrLogin.qrOfficial} alt="二维码A(新版App)" width={148} height={148} />
                    <div className="set-note">格式A(新版App)</div>
                  </div>
                )}
                {qrLogin.qrClassic && (
                  <div style={{ textAlign: 'center' }}>
                    <img src={qrLogin.qrClassic} alt="二维码B(旧版App)" width={148} height={148} />
                    <div className="set-note">格式B(旧版App)</div>
                  </div>
                )}
              </div>
            )}
            <span className="set-note">
              {qrLogin.hint ??
                (qrLogin.phase === 'waiting'
                  ? '两个码各扫一次:哪个在手机上弹出登录确认就点确认(两码同一会话);都报错请升级手机B站App'
                  : '')}
            </span>
          </div>
        )}
      </SettingsCard>
    </>
  )
}
