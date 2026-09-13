// 首启向导:三步完成第一次成功互动的配置——①怎么称呼你 ②选模型并测试连接
// ③是否开语音。跳过模型 = 演示模式(内置剧本兜底,现有失败回落链路,无需新机制)。
//
// 只对"零痕迹"用户弹出(App 侧判定:无聊天记录且未填称呼),老用户升级后
// wizardDone 缺省 false 也不会被打扰;判定与北极星指标见 tests/wizardGate.test.mjs。
// "第一次成功互动"的本地判定 = 发送 → 任一通道回复 → 气泡呈现 → 聊天落盘一条,
// 全部可本地观测,不做遥测。
import { useState } from 'react'
import { saveConfig, useConfigSnapshot } from '../storage/configStore'
import { complete } from '../engine/llmGateway'
import { VENDORS, CUSTOM_VENDOR_ID, vendorIdOfBaseUrl } from '../engine/vendors'

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; model: string }
  | { kind: 'fail'; message: string }

export function FirstRunWizard({ onDone }: { onDone(skipped: boolean): void }) {
  const cfg = useConfigSnapshot()
  const [step, setStep] = useState(0)
  const [userName, setUserName] = useState('')
  const [vendorId, setVendorId] = useState(vendorIdOfBaseUrl(cfg.baseUrl))
  const [baseUrl, setBaseUrl] = useState(cfg.baseUrl)
  const [model, setModel] = useState(cfg.model)
  const [apiKey, setApiKey] = useState('')
  const [voiceOn, setVoiceOn] = useState(cfg.voice.enabled)
  const [test, setTest] = useState<TestState>({ kind: 'idle' })

  const preset = VENDORS.find((v) => v.id === vendorId)

  function pickVendor(id: string): void {
    setVendorId(id)
    const v = VENDORS.find((x) => x.id === id)
    if (v) {
      setBaseUrl(v.baseUrl)
      setModel(v.models[0] ?? '')
    }
  }

  /** 保存当前草稿(密钥经 saveConfig 进凭据库),再发一条最小请求验证连通。
   *  成败都保留输入,失败信息直接展示服务端说明 */
  async function testConnection(): Promise<void> {
    setTest({ kind: 'testing' })
    try {
      await saveConfig({
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      })
      const reply = await complete({
        messages: [{ role: 'user', content: '只回复两个字:成功' }],
        temperature: 0,
        maxTokens: 512,
        jsonMode: false,
        timeoutMs: 20_000,
      })
      setTest({ kind: 'ok', model: reply.trim().slice(0, 40) || model })
    } catch (e) {
      const err = e as Error & { serverMsg?: string }
      setTest({
        kind: 'fail',
        message: `${err.message}${err.serverMsg ? `:${err.serverMsg.slice(0, 160)}` : ''}`,
      })
    }
  }

  async function finish(skipped: boolean): Promise<void> {
    await saveConfig({
      wizardDone: true,
      userProfile: { ...cfg.userProfile, userName: userName.trim().slice(0, 30) },
      voice: { ...cfg.voice, enabled: voiceOn },
      ...(skipped
        ? {}
        : {
            baseUrl: baseUrl.trim(),
            model: model.trim(),
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          }),
    })
    onDone(skipped)
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    padding: '8px 10px',
    borderRadius: 8,
    border: '1px solid rgba(255,255,255,.18)',
    background: 'rgba(0,0,0,.25)',
    color: 'inherit',
    fontSize: 13,
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(8,10,18,.55)',
        zIndex: 60,
      }}
    >
      <div
        style={{
          width: 420,
          maxHeight: '78vh',
          overflowY: 'auto',
          borderRadius: 14,
          padding: '20px 22px',
          background: 'rgba(18,20,32,.96)',
          border: '1px solid rgba(255,255,255,.14)',
          boxShadow: '0 18px 60px rgba(0,0,0,.5)',
          color: '#e8eaf2',
          fontFamily: 'inherit',
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>
          {step === 0 && '👋 见个面吧'}
          {step === 1 && '🔌 连上大脑'}
          {step === 2 && '🔊 要开口说话吗'}
        </div>
        <div style={{ fontSize: 12, opacity: 0.65, marginBottom: 14 }}>
          第 {step + 1} 步,共 3 步 —— 30 秒搞定
        </div>

        {step === 0 && (
          <div style={{ display: 'grid', gap: 10 }}>
            <label style={{ fontSize: 13 }}>
              大家怎么称呼你?(角色会用这个叫你,可留空)
              <input
                style={{ ...inputStyle, marginTop: 6 }}
                value={userName}
                maxLength={30}
                placeholder="比如:小张"
                onChange={(e) => setUserName(e.target.value)}
              />
            </label>
            <div style={{ fontSize: 12, opacity: 0.6 }}>
              角色名、人设、雷区这些都能之后再调(设置 → 角色/人设)。
            </div>
            <button
              style={primaryBtn}
              onClick={() => {
                void saveConfig({
                  userProfile: { ...cfg.userProfile, userName: userName.trim().slice(0, 30) },
                })
                setStep(1)
              }}
            >
              下一步
            </button>
          </div>
        )}

        {step === 1 && (
          <div style={{ display: 'grid', gap: 10 }}>
            <label style={{ fontSize: 13 }}>
              模型服务商
              <select
                style={{ ...inputStyle, marginTop: 6 }}
                value={vendorId}
                onChange={(e) => pickVendor(e.target.value)}
              >
                {VENDORS.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
                <option value={CUSTOM_VENDOR_ID}>自定义 / 本地(Ollama 等)</option>
              </select>
            </label>
            <label style={{ fontSize: 13 }}>
              接口地址
              <input
                style={{ ...inputStyle, marginTop: 6 }}
                value={baseUrl}
                onChange={(e) => {
                  setBaseUrl(e.target.value)
                  setVendorId(vendorIdOfBaseUrl(e.target.value))
                }}
              />
            </label>
            <label style={{ fontSize: 13 }}>
              模型
              {preset ? (
                <select
                  style={{ ...inputStyle, marginTop: 6 }}
                  value={preset.models.includes(model) ? model : preset.models[0]}
                  onChange={(e) => setModel(e.target.value)}
                >
                  {preset.models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  style={{ ...inputStyle, marginTop: 6 }}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="模型名,如 qwen2.5:7b"
                />
              )}
            </label>
            <label style={{ fontSize: 13 }}>
              API Key(只存进系统凭据库,不落配置文件)
              <input
                style={{ ...inputStyle, marginTop: 6 }}
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="粘贴服务商的 Key"
              />
            </label>
            <button style={primaryBtn} disabled={test.kind === 'testing'} onClick={() => void testConnection()}>
              {test.kind === 'testing' ? '测试中…' : '测试连接'}
            </button>
            {test.kind === 'ok' && (
              <div style={{ fontSize: 12, color: '#7fe08a' }}>✓ 连接成功({test.model})</div>
            )}
            {test.kind === 'fail' && (
              <div style={{ fontSize: 12, color: '#f0a0a0', wordBreak: 'break-all' }}>
                ✗ {test.message}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={ghostBtn} onClick={() => void finish(true)}>
                跳过,先用演示模式
              </button>
              <button style={ghostBtn} disabled={test.kind !== 'ok'} onClick={() => void finish(false)}>
                下一步
              </button>
            </div>
            <div style={{ fontSize: 12, opacity: 0.6 }}>
              没有钥匙也能玩:演示模式用内置剧本,之后再在 设置 → AI 模型 里填。
            </div>
          </div>
        )}

        {step === 2 && (
          <div style={{ display: 'grid', gap: 10 }}>
            <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={voiceOn}
                onChange={(e) => setVoiceOn(e.target.checked)}
              />
              开启语音(台词朗读;默认用硅基流动音色,可换)
            </label>
            <div style={{ fontSize: 12, opacity: 0.6 }}>
              语音服务与主模型相互独立,没配语音时角色照样演,只是不出声。
            </div>
            <button style={primaryBtn} onClick={() => void finish(false)}>
              开始吧 🎉
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

const primaryBtn: React.CSSProperties = {
  padding: '9px 14px',
  borderRadius: 9,
  border: 'none',
  background: '#5b7cfa',
  color: '#fff',
  fontSize: 13,
  cursor: 'pointer',
}
const ghostBtn: React.CSSProperties = {
  flex: 1,
  padding: '9px 10px',
  borderRadius: 9,
  border: '1px solid rgba(255,255,255,.2)',
  background: 'transparent',
  color: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
}
