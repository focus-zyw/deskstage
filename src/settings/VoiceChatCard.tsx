// 语音对话设置卡:对话模式、麦克风设备与电平测试(含底噪校准)、ASR 识别配置与测试连接、
// 打断实验开关。采集走 settings-preview 租约,与主窗语音会话在 Rust 侧互斥
// (会话持有麦克风时"开始测试"会被拒绝,错误原样展示);面板卸载即停采。
// VAD 参数语义见 docs/实时语音对话设计方案.md:起声 = 噪声底 + vadSensitivityDb。
import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listMics, rmsDbfs, startMic, MIC_SAMPLE_RATE, type MicDevice, type MicSession } from '../engine/mic'
import { bytesToBase64 } from '../engine/asr'
import { pcmToWav } from '../engine/tts/wav'
import { saveConfig, type VoiceChatConfig, type VoiceConfig } from '../storage/configStore'
import { useSettings } from './useSettingsSession'
import { SetField, SetLine, SetSwitch, SettingsCard } from './SettingsPrimitives'

const ASR_MODELS = ['FunAudioLLM/SenseVoiceSmall', 'TeleAI/TeleSpeechASR']

/** 电平条:-100~0 dBFS 映射为条宽,黄线 = 当前起声阈值(校准后显示) */
function LevelMeter(props: { dbfs: number; thresholdDbfs: number | null }) {
  const pct = Math.max(0, Math.min(100, props.dbfs + 100))
  const thPct =
    props.thresholdDbfs === null ? null : Math.max(0, Math.min(100, props.thresholdDbfs + 100))
  return (
    <div
      style={{
        position: 'relative',
        height: 10,
        borderRadius: 5,
        overflow: 'hidden',
        background: 'rgba(127,127,127,.18)',
        width: '100%',
      }}
    >
      <div
        style={{
          height: '100%',
          width: `${pct}%`,
          background: props.dbfs > -100 ? '#7c5cff' : 'transparent',
          transition: 'width .06s linear',
        }}
      />
      {thPct !== null && (
        <div
          style={{ position: 'absolute', top: 0, bottom: 0, left: `${thPct}%`, width: 2, background: '#ff9f43' }}
        />
      )}
    </div>
  )
}

export function VoiceChatCard() {
  const { voice, setVoice, saveField, flashCard } = useSettings()
  const vc = voice.voiceChat
  const patch = (p: Partial<VoiceChatConfig>, immediate = true) => {
    const next = { ...voice, voiceChat: { ...vc, ...p } }
    setVoice(next)
    saveField({ voice: next }, immediate)
  }
  const patchAsr = (p: Partial<VoiceConfig['asr']>, immediate = false) => {
    const next = { ...voice, asr: { ...voice.asr, ...p } }
    setVoice(next)
    saveField({ voice: next }, immediate)
  }

  // 麦克风测试:租约/电平采样/校准
  const [devices, setDevices] = useState<MicDevice[]>([])
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState('')
  const [level, setLevel] = useState(-120)
  const [noiseFloor, setNoiseFloor] = useState<number | null>(null)
  const sessionRef = useRef<MicSession | null>(null)
  const levelRef = useRef(-120)
  const calibrateRef = useRef<number[] | null>(null)

  useEffect(() => {
    if (vc.mode === 'off') return
    void listMics()
      .then(setDevices)
      .catch((e) => setTestError(String(e)))
    return () => {
      // 卸载(切页/关窗)即停采;Rust 侧通道断开也会自停,双保险
      void sessionRef.current?.stop()
      sessionRef.current = null
      setTesting(false)
    }
  }, [vc.mode])

  const startTest = async () => {
    setTestError('')
    try {
      const frames = (pcm: Int16Array) => {
        const db = rmsDbfs(pcm)
        levelRef.current = db
        calibrateRef.current?.push(db)
      }
      sessionRef.current = await startMic({
        owner: 'settings-preview',
        deviceId: vc.deviceId || undefined,
        onFrame: frames,
      })
      setTesting(true)
      // 100ms 采样刷新条(30ms 一帧 setState 太密)
      const timer = window.setInterval(() => setLevel(levelRef.current), 100)
      const old = sessionRef.current
      // 覆盖 stop:停采同时清掉定时器
      sessionRef.current = {
        stop: async () => {
          window.clearInterval(timer)
          await old.stop()
        },
      }
    } catch (e) {
      setTestError(String(e))
    }
  }
  const stopTest = async () => {
    await sessionRef.current?.stop()
    sessionRef.current = null
    setTesting(false)
    setLevel(-120)
  }
  const calibrate = () => {
    calibrateRef.current = []
    window.setTimeout(() => {
      const xs = calibrateRef.current ?? []
      calibrateRef.current = null
      if (xs.length === 0) return
      xs.sort((a, b) => a - b)
      // 取中位数做底噪:偶发敲击/喷麦不抬阈值
      const mid = Math.floor(xs.length / 2)
      const floor = xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2
      setNoiseFloor(floor)
    }, 2000)
  }

  // ASR 测试连接:先落盘(密钥进凭据库)再发 1s 静音 wav
  const [asrTest, setAsrTest] = useState<{ state: 'idle' | 'testing' | 'ok' | 'fail'; msg: string }>({
    state: 'idle',
    msg: '',
  })
  const testAsr = async () => {
    setAsrTest({ state: 'testing', msg: '' })
    try {
      await saveConfig({ voice: { ...voice, asr: voice.asr } })
      const pcm = new Int16Array(MIC_SAMPLE_RATE) // 1 秒静音:只验 key+模型+连通
      const wav = new Uint8Array(pcmToWav(new Uint8Array(pcm.buffer), MIC_SAMPLE_RATE, 1, 16))
      const r = await invoke<{ text: string }>('asr_transcribe', {
        wavBase64: bytesToBase64(wav),
        model: voice.asr.model,
      })
      setAsrTest({ state: 'ok', msg: `连接正常(识别返回:${r.text ? `“${r.text}”` : '空'})` })
    } catch (e) {
      setAsrTest({ state: 'fail', msg: String(e) })
    }
  }

  const thresholdDbfs = noiseFloor === null ? null : noiseFloor + vc.vadSensitivityDb

  return (
    <SettingsCard
      card="语音对话"
      flash={flashCard}
      title="语音对话(实时)"
      desc="对着麦克风说话,角色听懂后语音回答"
    >
      <SetField
        label="对话模式"
        htmlFor="cfg-vc-mode"
        hint="按键说话:按住全局热键说话、松开送识别(「快捷键」页可设,任何时刻按下 = 打断);免按键:自动检测说话起止;关闭 = 不占用麦克风"
      >
        <select
          id="cfg-vc-mode"
          value={vc.mode}
          onChange={(e) => patch({ mode: e.target.value as VoiceChatConfig['mode'] })}
        >
          <option value="off">关闭</option>
          <option value="ptt">按键说话</option>
          <option value="hands-free">免按键(自动检测)</option>
        </select>
      </SetField>
      {vc.mode !== 'off' && (
        <>
          <SetField label="麦克风" htmlFor="cfg-vc-device" hint="缺省用系统默认设备;拔插设备后重新打开本页刷新列表">
            <select
              id="cfg-vc-device"
              value={vc.deviceId}
              onChange={(e) => patch({ deviceId: e.target.value })}
            >
              <option value="">系统默认</option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {d.default ? '(默认)' : ''}
                </option>
              ))}
            </select>
          </SetField>
          <SetLine
            title="麦克风测试"
            hint="点开始后对麦克风说话,紫色条应有起伏;「校准」请保持安静 2 秒,校准后黄线 = 说话判定阈值(低于黄线视为安静)"
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 260 }}>
              {testing ? (
                <button type="button" className="panel-btn" onClick={() => void stopTest()}>
                  停止测试
                </button>
              ) : (
                <button type="button" className="panel-btn" onClick={() => void startTest()}>
                  开始测试
                </button>
              )}
              <button type="button" className="panel-btn" onClick={calibrate}>
                校准
              </button>
            </div>
          </SetLine>
          <LevelMeter dbfs={level} thresholdDbfs={thresholdDbfs} />
          {noiseFloor !== null && (
            <p className="set-note">
              底噪 ≈ {noiseFloor.toFixed(0)} dB,起声阈值 ≈ {thresholdDbfs?.toFixed(0)} dB
            </p>
          )}
          {testError && <p className="set-note">麦克风不可用:{testError}(检查系统「设置 → 隐私 → 麦克风」是否允许桌面应用)</p>}
          <div className="set-grid">
            <SetField
              label="说话灵敏度"
              htmlFor="cfg-vc-sens"
              hint={`起声阈值 = 底噪 + ${vc.vadSensitivityDb} dB;调小更灵敏、更易受环境噪音影响`}
            >
              <input
                id="cfg-vc-sens"
                type="range"
                min={6}
                max={24}
                step={1}
                value={vc.vadSensitivityDb}
                onChange={(e) => patch({ vadSensitivityDb: Number(e.target.value) }, false)}
                onMouseUp={() => patch({}, true)}
              />
            </SetField>
            <SetField
              label="结束静音时长"
              htmlFor="cfg-vc-silence"
              hint={`静音 ${vc.silenceMs} ms 判定一句说完;调小响应快、易截断,调大更完整、更拖沓`}
            >
              <input
                id="cfg-vc-silence"
                type="range"
                min={400}
                max={1500}
                step={50}
                value={vc.silenceMs}
                onChange={(e) => patch({ silenceMs: Number(e.target.value) }, false)}
                onMouseUp={() => patch({}, true)}
              />
            </SetField>
          </div>
          <SetLine
            title="说话时允许语音打断"
            hint="实验项:角色说话时你开口即打断(阈值会自动抬高以过滤回声)。外放场景可能误触发,建议戴耳机;按键说话模式下按住热键任何时候都能打断,不依赖此开关"
          >
            <SetSwitch checked={vc.autoInterrupt} label="说话时允许语音打断" onChange={(v) => patch({ autoInterrupt: v })} />
          </SetLine>
          <SetField
            label="识别 API Key"
            htmlFor="cfg-vc-asr-key"
            hint="siliconflow.cn 的 API Key,只用于语音识别,与朗读/对话的 key 相互独立"
          >
            <input
              id="cfg-vc-asr-key"
              type="password"
              placeholder="sk-...(siliconflow.cn)"
              value={voice.asr.apiKey}
              onChange={(e) => patchAsr({ apiKey: e.target.value })}
              onBlur={(e) => patchAsr({ apiKey: e.target.value }, true)}
            />
          </SetField>
          <SetField
            label="识别模型"
            htmlFor="cfg-vc-asr-model"
            hint="SenseVoiceSmall 免费(有限流);TeleSpeechASR 按量计费;也可手动填官方模型列表里的其他值"
          >
            <input
              id="cfg-vc-asr-model"
              list="asr-model-suggestions"
              value={voice.asr.model}
              onChange={(e) => patchAsr({ model: e.target.value })}
              onBlur={(e) => patchAsr({ model: e.target.value }, true)}
            />
            <datalist id="asr-model-suggestions">
              {ASR_MODELS.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </SetField>
          <SetLine title="识别测试连接" hint={asrTest.msg || '发 1 秒静音验证密钥与模型;识别质量以真实说话为准'}>
            <button type="button" className="panel-btn" disabled={asrTest.state === 'testing'} onClick={() => void testAsr()}>
              {asrTest.state === 'testing' ? '测试中…' : '测试连接'}
            </button>
          </SetLine>
          {asrTest.state === 'fail' && <p className="set-note">{asrTest.msg}</p>}
          {asrTest.state === 'ok' && <p className="set-note">{asrTest.msg}</p>}
        </>
      )}
    </SettingsCard>
  )
}
