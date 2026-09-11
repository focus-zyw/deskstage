// 角色语音:供应商与凭据、每角色音色分配、克隆音色、GPT-SoVITS 参考音色表、试听
import { PROVIDER_OPTIONS, providerById, previewSample } from '../../engine/tts'
import { saveConfig, type GptsovitsVoice } from '../../storage/configStore'
import { useSettings } from '../useSettingsSession'
import { CloneVoiceRow, SettingsCard, SetField, SetLine, SetSwitch } from '../SettingsPrimitives'

/** api_v2 支持的语言代码(与 configStore 清洗白名单一致) */
const GPT_LANGS = ['auto', 'zh', 'en', 'ja', 'ko', 'yue'] as const

export function VoiceSettings() {
  const { voice, setVoice, clonedVoices, setClonedVoices, saveField, flashCard } = useSettings()

  /** GPT-SoVITS 块整体修补:immediate=true 立即落盘(下拉/增删),文本输入走防抖 */
  const patchGptsovits = (patch: Partial<typeof voice.gptsovits>, immediate = false) => {
    const next = { ...voice, gptsovits: { ...voice.gptsovits, ...patch } }
    setVoice(next)
    saveField({ voice: next }, immediate)
  }
  const patchGptVoice = (id: string, patch: Partial<GptsovitsVoice>, immediate = false) => {
    patchGptsovits({ voices: voice.gptsovits.voices.map((v) => (v.id === id ? { ...v, ...patch } : v)) }, immediate)
  }
  const addGptVoice = () => {
    patchGptsovits(
      {
        voices: [
          ...voice.gptsovits.voices,
          {
            id: `gv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            name: `音色${voice.gptsovits.voices.length + 1}`,
            refAudioPath: '',
            promptText: '',
            promptLang: 'zh',
          },
        ],
      },
      true,
    )
  }
  const removeGptVoice = (id: string) => {
    patchGptsovits({ voices: voice.gptsovits.voices.filter((v) => v.id !== id) }, true)
  }
  /** 参考音色文本输入:onChange 防抖落盘,onBlur 立即落盘(与 API Key 输入同节奏) */
  const gptVoiceText = (id: string, key: 'name' | 'refAudioPath' | 'promptText') => ({
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      patchGptVoice(id, { [key]: e.target.value } as Partial<GptsovitsVoice>),
    onBlur: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      patchGptVoice(id, { [key]: e.target.value } as Partial<GptsovitsVoice>, true),
  })

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
              hint="硅基流动 CosyVoice2:流式快、便宜稳定;MiniMax Speech 2.8:情绪与语气表现力更强,按量价格更高;GPT-SoVITS:本地自建、用自己的音色模型,需先在那台机器跑起 api_v2.py"
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
            {voice.provider === 'siliconflow' && (
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
            )}
            {voice.provider === 'minimax' && (
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
            {voice.provider === 'gptsovits' && (
              <>
                <SetField
                  label="服务地址"
                  htmlFor="cfg-gpt-url"
                  hint="api_v2.py 的地址(默认端口 9880);填 http://局域网IP:9880 可让另一台机器跑推理。无需 API Key"
                >
                  <input
                    id="cfg-gpt-url"
                    placeholder="http://127.0.0.1:9880"
                    value={voice.gptsovits.url}
                    onChange={(e) => patchGptsovits({ url: e.target.value })}
                    onBlur={(e) => patchGptsovits({ url: e.target.value }, true)}
                  />
                </SetField>
                <div className="set-grid">
                  <SetField label="流式档位" htmlFor="cfg-gpt-stream" hint="3 首包最快、音质略降;2 平衡;1 质量优先、首包最慢">
                    <select
                      id="cfg-gpt-stream"
                      value={voice.gptsovits.streamMode}
                      onChange={(e) => patchGptsovits({ streamMode: Number(e.target.value) as 1 | 2 | 3 }, true)}
                    >
                      <option value={3}>3 · 首包最快</option>
                      <option value={2}>2 · 平衡(推荐)</option>
                      <option value={1}>1 · 质量优先</option>
                    </select>
                  </SetField>
                  <SetField label="台词语言" htmlFor="cfg-gpt-textlang" hint="发给 api_v2 的 text_lang;auto 按台词内容自动检测">
                    <select
                      id="cfg-gpt-textlang"
                      value={voice.gptsovits.textLang}
                      onChange={(e) => patchGptsovits({ textLang: e.target.value }, true)}
                    >
                      {GPT_LANGS.map((l) => (
                        <option key={l} value={l}>
                          {l === 'auto' ? 'auto · 自动检测' : l}
                        </option>
                      ))}
                    </select>
                  </SetField>
                </div>
              </>
            )}
          </>
        )}
      </SettingsCard>
      {voice.enabled && (
        <SettingsCard card="音色与表现" flash={flashCard} title="音色与表现">
          <SetLine
            title="情感指令"
            hint={
              voice.provider === 'gptsovits'
                ? 'GPT-SoVITS 无情感指令通道,语气差异仅由语速表达,此开关对其无效;想要情绪区分可给同一角色配不同情绪的参考音色'
                : '把 deadpan/excited/slow 语气映射为情感指令(CosyVoice2 经 <|endofprompt|> 引导,不会被朗读;MiniMax 走情绪参数),角色差异更可听'
            }
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
                {voice.provider === 'gptsovits' && <option value="">未分配(用第一个音色)</option>}
                {(voice.provider === 'gptsovits'
                  ? voice.gptsovits.voices.map((v) => ({ id: v.id, label: v.name }))
                  : providerById(voice.provider).voices
                ).map((v) => (
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
      {voice.enabled && voice.provider === 'gptsovits' && (
        <SettingsCard card="GPT-SoVITS 参考音色" flash={flashCard} title="GPT-SoVITS 参考音色">
          <p className="set-note">
            GPT-SoVITS 用参考音频定义音色:路径填服务器本机(跑 api_v2.py 那台机器)上的音频文件,
            参考文本写音频里说的话、语言选一致;10 秒内清晰人声、无明显底噪效果最好。
            配好后到上方「音色与表现」把音色分给各角色。
          </p>
          {voice.gptsovits.voices.map((v, i) => (
            <div key={v.id} className="gpt-voice">
              <div className="gpt-voice-head">
                <span className="gpt-voice-title">#{i + 1}</span>
                <input
                  aria-label="音色名称"
                  placeholder="音色名称"
                  maxLength={50}
                  value={v.name}
                  {...gptVoiceText(v.id, 'name')}
                />
                <button type="button" className="panel-btn gpt-voice-del" onClick={() => removeGptVoice(v.id)}>
                  删除
                </button>
              </div>
              <SetField label="参考音频路径(服务器本机)" htmlFor={`cfg-gpt-${v.id}-path`}>
                <input
                  id={`cfg-gpt-${v.id}-path`}
                  placeholder='D:\gptsovits\refs\ana.wav'
                  maxLength={500}
                  value={v.refAudioPath}
                  {...gptVoiceText(v.id, 'refAudioPath')}
                />
              </SetField>
              <SetField label="参考文本(音频里说的话)" htmlFor={`cfg-gpt-${v.id}-text`}>
                <textarea
                  id={`cfg-gpt-${v.id}-text`}
                  rows={2}
                  maxLength={300}
                  placeholder="写这段参考音频里说的话,语言要和下面选的一致"
                  value={v.promptText}
                  {...gptVoiceText(v.id, 'promptText')}
                />
              </SetField>
              <SetField label="参考文本语言" htmlFor={`cfg-gpt-${v.id}-lang`}>
                <select
                  id={`cfg-gpt-${v.id}-lang`}
                  value={v.promptLang}
                  onChange={(e) => patchGptVoice(v.id, { promptLang: e.target.value }, true)}
                >
                  {GPT_LANGS.map((l) => (
                    <option key={l} value={l}>
                      {l === 'auto' ? 'auto · 自动检测' : l}
                    </option>
                  ))}
                </select>
              </SetField>
            </div>
          ))}
          <button type="button" className="panel-btn primary" onClick={addGptVoice}>
            ＋ 添加参考音色
          </button>
        </SettingsCard>
      )}
    </>
  )
}
