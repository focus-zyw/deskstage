// 角色语音:供应商与凭据、每角色音色分配、克隆音色、试听
import { PROVIDER_OPTIONS, providerById, previewSample } from '../../engine/tts'
import { saveConfig } from '../../storage/configStore'
import { useSettings } from '../useSettingsSession'
import { CloneVoiceRow, SettingsCard, SetField, SetLine, SetSwitch } from '../SettingsPrimitives'

export function VoiceSettings() {
  const { voice, setVoice, clonedVoices, setClonedVoices, saveField, flashCard } = useSettings()

  return (
    <>
      <SettingsCard card="语音与供应商" flash={flashCard} title="语音与供应商">
        <SetLine title="角色语音" hint="关闭后角色只动不出声">
          <SetSwitch
            checked={voice.enabled}
            label="角色语音"
            onChange={(v) => {
              const next = { ...voice, enabled: v }
              setVoice(next)
              saveField({ voice: next }, true)
            }}
          />
        </SetLine>
        {voice.enabled && (
          <>
            <SetField
              label="语音供应商"
              htmlFor="cfg-voice-provider"
              hint="硅基流动 CosyVoice2:流式快、便宜稳定;MiniMax Speech 2.8:情绪与语气表现力更强,按量价格更高"
            >
              <select
                id="cfg-voice-provider"
                value={voice.provider}
                onChange={(e) => {
                  const next = { ...voice, provider: e.target.value as typeof voice.provider }
                  setVoice(next)
                  saveField({ voice: next }, true)
                }}
              >
                {PROVIDER_OPTIONS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </SetField>
            {voice.provider === 'siliconflow' ? (
              <SetField
                label="语音 API Key"
                htmlFor="cfg-voice-key"
                hint="siliconflow.cn 的 API Key,与 AI 模型页的 key 相互独立"
              >
                <input
                  id="cfg-voice-key"
                  type="password"
                  placeholder="sk-...(siliconflow.cn)"
                  value={voice.apiKey}
                  onChange={(e) => {
                    const next = { ...voice, apiKey: e.target.value }
                    setVoice(next)
                    saveField({ voice: next })
                  }}
                  onBlur={(e) => {
                    const next = { ...voice, apiKey: e.target.value }
                    setVoice(next)
                    saveField({ voice: next }, true)
                  }}
                />
              </SetField>
            ) : (
              <>
                <SetField label="MiniMax API Key" htmlFor="cfg-mm-key" hint="MiniMax 开放平台的 API Key,与硅基流动相互独立">
                  <input
                    id="cfg-mm-key"
                    type="password"
                    placeholder="eyJ...(MiniMax)"
                    value={voice.minimax.apiKey}
                    onChange={(e) => {
                      const next = { ...voice, minimax: { ...voice.minimax, apiKey: e.target.value } }
                      setVoice(next)
                      saveField({ voice: next })
                    }}
                    onBlur={(e) => {
                      const next = { ...voice, minimax: { ...voice.minimax, apiKey: e.target.value } }
                      setVoice(next)
                      saveField({ voice: next }, true)
                    }}
                  />
                </SetField>
                <SetField label="MiniMax GroupId" htmlFor="cfg-mm-group" hint="MiniMax 开放平台账号的 GroupId">
                  <input
                    id="cfg-mm-group"
                    value={voice.minimax.groupId}
                    onChange={(e) => {
                      const next = { ...voice, minimax: { ...voice.minimax, groupId: e.target.value } }
                      setVoice(next)
                      saveField({ voice: next })
                    }}
                    onBlur={(e) => {
                      const next = { ...voice, minimax: { ...voice.minimax, groupId: e.target.value } }
                      setVoice(next)
                      saveField({ voice: next }, true)
                    }}
                  />
                </SetField>
                <SetField label="MiniMax 模型" htmlFor="cfg-mm-model" hint="turbo:便宜、流式快;hd:质量优先,价格更高">
                  <select
                    id="cfg-mm-model"
                    value={voice.minimax.model}
                    onChange={(e) => {
                      const next = { ...voice, minimax: { ...voice.minimax, model: e.target.value as typeof voice.minimax.model } }
                      setVoice(next)
                      saveField({ voice: next }, true)
                    }}
                  >
                    <option value="speech-2.8-turbo">speech-2.8-turbo(快)</option>
                    <option value="speech-2.8-hd">speech-2.8-hd(高质)</option>
                  </select>
                </SetField>
              </>
            )}
          </>
        )}
      </SettingsCard>
      {voice.enabled && (
        <SettingsCard card="音色与表现" flash={flashCard} title="音色与表现">
          <SetLine
            title="情感指令"
            hint="把 deadpan/excited/slow 语气映射为情感指令(CosyVoice2 经 <|endofprompt|> 引导,不会被朗读;MiniMax 走情绪参数),角色差异更可听"
          >
            <SetSwitch
              checked={voice.emotionHints}
              label="情感指令"
              onChange={(v) => {
                const next = { ...voice, emotionHints: v }
                setVoice(next)
                saveField({ voice: next }, true)
              }}
            />
          </SetLine>
          {(
            [
              ['A', '角色甲音色', 'cfg-voice-a'],
              ['B', '角色乙音色', 'cfg-voice-b'],
              ['C', '角色C音色(常驻小管家)', 'cfg-voice-c'],
            ] as const
          ).map(([slot, label, id]) => (
            <SetField key={slot} label={label} htmlFor={id}>
              <select
                id={id}
                value={voice.assignments[voice.provider][slot]}
                onChange={(e) => {
                  const next = {
                    ...voice,
                    assignments: {
                      ...voice.assignments,
                      [voice.provider]: { ...voice.assignments[voice.provider], [slot]: e.target.value },
                    },
                  }
                  setVoice(next)
                  saveField({ voice: next }, true)
                }}
              >
                {providerById(voice.provider).voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
                {voice.provider === 'siliconflow' && clonedVoices.length > 0 && (
                  <optgroup label="我的克隆音色">
                    {clonedVoices.map((v) => (
                      <option key={v.uri} value={v.uri}>
                        {v.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </SetField>
          ))}
          {voice.provider === 'siliconflow' && (
            <CloneVoiceRow
              apiKey={voice.apiKey}
              onCloned={(v) => {
                setClonedVoices((list) => [...list.filter((x) => x.uri !== v.uri), v])
                const next = {
                  ...voice,
                  assignments: {
                    ...voice.assignments,
                    siliconflow: { ...voice.assignments.siliconflow, B: v.uri },
                  },
                }
                setVoice(next)
                saveConfig({ voice: next }).catch(() => {})
              }}
            />
          )}
          <SetLine
            title="试听"
            hint="用角色甲的音色读一句固定台词;切换供应商后再点一次,可做同台词 A/B 对比"
          >
            <button id="cfg-voice-preview" className="panel-btn" type="button" onClick={() => previewSample()}>
              ▶ 试听一句
            </button>
          </SetLine>
        </SettingsCard>
      )}
    </>
  )
}
