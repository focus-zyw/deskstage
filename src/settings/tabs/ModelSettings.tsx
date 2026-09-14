// AI 模型:主模型(厂商/Key/端点/模型名)、提取文字(OCR 视觉模型)、
// 群聊模型档案与角色绑定(自由群聊 Actor 系统,每角色可绑独立 API 模型/网页站点)。
import { VENDORS, CUSTOM_VENDOR_ID } from '../../engine/vendors'
import { WEBCHAT_SITES } from '../../engine/webchat'
import { isWebchatSite, type GroupActorConfig, type GroupModelBinding } from '../../storage/configStore'
import { SiteLoginRow } from '../SiteLoginRow'
import { useSettings, vendorKeyOf } from '../useSettingsSession'
import { SettingsCard, SetField, SetLine } from '../SettingsPrimitives'

/** 绑定 → 下拉值(api 缺省 profileId = 主模型) */
function bindingValue(b: GroupModelBinding): string {
  if (b.kind === 'api') return b.profileId ? `api:${b.profileId}` : 'api:main'
  if (b.kind === 'web') return `web:${b.site}`
  return 'off'
}

function bindingFromValue(v: string): GroupModelBinding {
  if (v.startsWith('api:')) {
    const pid = v.slice(4)
    return pid ? { kind: 'api', profileId: pid } : { kind: 'api' }
  }
  if (v.startsWith('web:')) {
    const site = v.slice(4)
    return isWebchatSite(site) ? { kind: 'web', site } : { kind: 'disabled' }
  }
  return { kind: 'disabled' }
}

export function ModelSettings() {
  const { form, setForm, saveField, vendorId, setVendorId, keyDrafts, setKeyDrafts, flashCard } = useSettings()

  /** 角色绑定变更:整体替换 groupChatActors(字段级 schema 单源在 configStore) */
  function updateActor(slot: 'A' | 'B' | 'C', patch: Partial<GroupActorConfig>) {
    const next = { ...form.groupChatActors, [slot]: { ...form.groupChatActors[slot], ...patch } }
    setForm({ ...form, groupChatActors: next })
    saveField({ groupChatActors: next }, true)
  }

  const actorRows: { slot: 'A' | 'B' | 'C'; name: string; cfg: GroupActorConfig }[] = [
    { slot: 'A', name: form.names.a || '甲', cfg: form.groupChatActors.A },
    { slot: 'B', name: form.names.b || '乙', cfg: form.groupChatActors.B },
    { slot: 'C', name: form.names.c || '丙', cfg: form.groupChatActors.C },
  ]
  const profileEntries = Object.entries(form.modelProfiles)

  function addProfile() {
    const base = VENDORS[0]
    let n = profileEntries.length + 1
    let id = `p${n}`
    while (form.modelProfiles[id]) {
      n += 1
      id = `p${n}`
    }
    const next = {
      ...form.modelProfiles,
      [id]: { label: `档案${n}`, baseUrl: base.baseUrl, model: base.models[0] ?? '' },
    }
    setForm({ ...form, modelProfiles: next })
    saveField({ modelProfiles: next }, true)
  }

  function updateProfile(id: string, patch: { label?: string; baseUrl?: string; model?: string }) {
    const cur = form.modelProfiles[id]
    if (!cur) return
    const next = { ...form.modelProfiles, [id]: { ...cur, ...patch } }
    setForm({ ...form, modelProfiles: next })
    saveField({ modelProfiles: next })
  }

  function updateProfileKey(id: string, key: string) {
    const next = { ...form.modelProfileKeys, [id]: key }
    setForm({ ...form, modelProfileKeys: next })
    saveField({ modelProfileKeys: next })
  }

  /** 删除档案:同步删除其 Key 映射(整组重写,llm:profileKeys 凭据随写库事务更新) */
  function removeProfile(id: string) {
    const profiles = { ...form.modelProfiles }
    delete profiles[id]
    const keys = { ...form.modelProfileKeys }
    delete keys[id]
    setForm({ ...form, modelProfiles: profiles, modelProfileKeys: keys })
    saveField({ modelProfiles: profiles, modelProfileKeys: keys }, true)
  }

  return (
    <>
      <SettingsCard card="主模型" flash={flashCard} title="主模型" desc="对话 / 演出 / 台词生成">
        <SetField label="厂商" htmlFor="cfg-vendor">
          <select
            id="cfg-vendor"
            value={vendorId}
            onChange={(e) => {
              const id = e.target.value
              // 当前输入的 key 存回旧厂商的键,再从新厂商的键带出(没有则空)
              const drafts = { ...keyDrafts, [vendorKeyOf(vendorId, form.baseUrl)]: form.apiKey }
              setKeyDrafts(drafts)
              setVendorId(id)
              let baseUrl = form.baseUrl
              let model = form.model
              if (id !== CUSTOM_VENDOR_ID) {
                const v = VENDORS.find((x) => x.id === id)!
                baseUrl = v.baseUrl
                model = v.models[0] ?? ''
              }
              const apiKey = drafts[vendorKeyOf(id, baseUrl)] ?? ''
              setForm({ ...form, baseUrl, model, apiKey })
              saveField(
                {
                  baseUrl,
                  model,
                  apiKey,
                  apiKeys: { ...form.apiKeys, ...drafts },
                },
                true,
              )
            }}
          >
            {VENDORS.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
            <option value={CUSTOM_VENDOR_ID}>本地 / 自定义</option>
          </select>
        </SetField>
        <SetField
          label={`API Key${vendorId === CUSTOM_VENDOR_ID ? '(本地服务可为空)' : ''}`}
          htmlFor="cfg-key"
          hint="每个厂商(自定义按接口地址)分别记忆,切换自动带出"
        >
          <input
            id="cfg-key"
            type="password"
            value={form.apiKey}
            onChange={(e) => {
              const v = e.target.value
              setForm({ ...form, apiKey: v })
              setKeyDrafts((d) => ({ ...d, [vendorKeyOf(vendorId, form.baseUrl)]: v }))
              saveField({ apiKey: v, apiKeys: { ...form.apiKeys, [vendorKeyOf(vendorId, form.baseUrl)]: v } })
            }}
            onBlur={() => saveField({}, true)}
          />
        </SetField>
        <SetField label="接口地址" htmlFor="cfg-url">
          <input
            id="cfg-url"
            value={form.baseUrl}
            placeholder={
              vendorId === CUSTOM_VENDOR_ID ? 'http://localhost:11434/v1' : 'https://api.deepseek.com/v1'
            }
            onChange={(e) => {
              // 自定义端点键含 baseUrl:先把 key 存回旧地址的键,换地址互不串
              const drafts = { ...keyDrafts, [vendorKeyOf(vendorId, form.baseUrl)]: form.apiKey }
              setKeyDrafts(drafts)
              setForm({ ...form, baseUrl: e.target.value })
              saveField({ baseUrl: e.target.value, apiKeys: { ...form.apiKeys, ...drafts } })
            }}
          />
        </SetField>
        <SetField label="模型" htmlFor="cfg-model">
          {vendorId === CUSTOM_VENDOR_ID ? (
            <input
              id="cfg-model"
              value={form.model}
              placeholder="如 qwen2.5:7b(Ollama 模型名)"
              onChange={(e) => {
                setForm({ ...form, model: e.target.value })
                saveField({ model: e.target.value })
              }}
            />
          ) : (
            <select
              id="cfg-model"
              value={form.model}
              onChange={(e) => {
                setForm({ ...form, model: e.target.value })
                saveField({ model: e.target.value }, true)
              }}
            >
              {(VENDORS.find((v) => v.id === vendorId)?.models ?? []).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          )}
        </SetField>
      </SettingsCard>
      <SettingsCard
        card="提取文字"
        flash={flashCard}
        title="提取文字"
        desc="AI 视觉模型优先,失败自动本地兜底;AI 连续失效会熔断 10 分钟直接走本地;智谱 glm-4.6v-flash 免费"
      >
        <SetLine title="识别引擎" hint="自动=AI 优先本地兜底(连败自动熔断);仅本地=不再请求 AI">
          <div className="seg-group">
            {(
              [
                ['auto', '自动'],
                ['local', '仅本地'],
                ['ai', '仅 AI'],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                className={`seg-btn${form.ocr.engine === v ? ' on' : ''}`}
                onClick={() => {
                  const ocr = { ...form.ocr, engine: v }
                  setForm({ ...form, ocr })
                  saveField({ ocr }, true)
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </SetLine>
        <SetField
          label="OCR API Key(留空 = 只用本地识别)"
          htmlFor="cfg-ocr-key"
          hint="bigmodel.cn 注册即得"
        >
          <input
            id="cfg-ocr-key"
            type="password"
            value={form.ocr.apiKey}
            onChange={(e) => {
              const ocr = { ...form.ocr, apiKey: e.target.value }
              setForm({ ...form, ocr })
              saveField({ ocr })
            }}
          />
        </SetField>
        <SetField label="OCR 接口地址(OpenAI 兼容)" htmlFor="cfg-ocr-url">
          <input
            id="cfg-ocr-url"
            value={form.ocr.baseUrl}
            onChange={(e) => {
              const ocr = { ...form.ocr, baseUrl: e.target.value }
              setForm({ ...form, ocr })
              saveField({ ocr })
            }}
          />
        </SetField>
        <SetField label="OCR 视觉模型" htmlFor="cfg-ocr-model">
          <input
            id="cfg-ocr-model"
            value={form.ocr.model}
            placeholder="glm-4.6v-flash"
            onChange={(e) => {
              const ocr = { ...form.ocr, model: e.target.value }
              setForm({ ...form, ocr })
              saveField({ ocr })
            }}
          />
        </SetField>
      </SettingsCard>
      <SettingsCard
        card="群聊角色绑定"
        flash={flashCard}
        title="群聊角色绑定"
        desc="自由群聊:每个角色独立绑定模型,各自判断接话或旁听;调用量比旧版高(C 默认关闭)"
      >
        {actorRows.map(({ slot, name, cfg }) => (
          <div key={slot}>
            <SetField label={`${name}的模型`} htmlFor={`cfg-gc-${slot}`}>
              <select
                id={`cfg-gc-${slot}`}
                value={bindingValue(cfg.binding)}
                onChange={(e) => updateActor(slot, { binding: bindingFromValue(e.target.value) })}
              >
                <option value="api:main">主模型({form.model})</option>
                {profileEntries.map(([pid, p]) => (
                  <option key={pid} value={`api:${pid}`}>
                    {p.label}
                  </option>
                ))}
                {WEBCHAT_SITES.map((s) => (
                  <option key={s.id} value={`web:${s.id}`}>
                    {s.label}(网页)
                  </option>
                ))}
                <option value="off">不参与</option>
              </select>
            </SetField>
            {cfg.binding.kind === 'web' && (
              <SiteLoginRow label={`${name}的网页登录`} site={cfg.binding.site} />
            )}
            <SetLine title={`${name}的活跃度`} hint="安静=少接话;热闹=更爱聊(都会自动收敛,不会无限聊下去)">
              <div className="seg-group">
                {(
                  [
                    ['quiet', '安静'],
                    ['natural', '平衡'],
                    ['lively', '热闹'],
                  ] as const
                ).map(([v, label]) => (
                  <button
                    key={v}
                    className={`seg-btn${cfg.autonomy === v ? ' on' : ''}`}
                    onClick={() => updateActor(slot, { autonomy: v })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </SetLine>
            {slot === 'C' && !form.characters.C.enabled && (
              <div className="set-note">C 当前在基础设置里隐藏;重新显示后会按这里的绑定参与群聊</div>
            )}
          </div>
        ))}
      </SettingsCard>
      <SettingsCard
        card="模型档案"
        flash={flashCard}
        title="模型档案"
        desc="可被群聊角色绑定的独立 API 端点;Key 只进系统凭据库,不落配置文件"
      >
        {profileEntries.length === 0 && (
          <div className="set-note">还没有档案。新增一个,群聊角色就能绑定与主模型不同的 API 模型。</div>
        )}
        {profileEntries.map(([id, p]) => (
          <div key={id} style={{ borderTop: '1px solid var(--line, rgba(128,128,128,.25))', marginTop: 8, paddingTop: 8 }}>
            <SetLine title={`档案:${p.label}`} hint="删除档案会一并清除其 Key">
              <button className="panel-btn" onClick={() => removeProfile(id)}>
                删除此档案
              </button>
            </SetLine>
            <SetField label="显示名" htmlFor={`cfg-mp-label-${id}`}>
              <input
                id={`cfg-mp-label-${id}`}
                value={p.label}
                onChange={(e) => updateProfile(id, { label: e.target.value })}
              />
            </SetField>
            <SetField label="接口地址(OpenAI 兼容)" htmlFor={`cfg-mp-url-${id}`}>
              <input
                id={`cfg-mp-url-${id}`}
                value={p.baseUrl}
                placeholder="https://api.deepseek.com/v1"
                onChange={(e) => updateProfile(id, { baseUrl: e.target.value })}
              />
            </SetField>
            <SetField label="模型" htmlFor={`cfg-mp-model-${id}`}>
              <input
                id={`cfg-mp-model-${id}`}
                value={p.model}
                placeholder="deepseek-chat"
                onChange={(e) => updateProfile(id, { model: e.target.value })}
              />
            </SetField>
            <SetField label="API Key" htmlFor={`cfg-mp-key-${id}`} hint="只进系统凭据库;留空 = 沿用未保存状态">
              <input
                id={`cfg-mp-key-${id}`}
                type="password"
                value={form.modelProfileKeys[id] ?? ''}
                onChange={(e) => updateProfileKey(id, e.target.value)}
                onBlur={() => saveField({}, true)}
              />
            </SetField>
          </div>
        ))}
        <SetLine title="新增档案" hint="以预设厂商为底,改地址与模型即可">
          <button className="panel-btn" onClick={addProfile}>
            + 新增模型档案
          </button>
        </SetLine>
      </SettingsCard>
    </>
  )
}
