// AI 模型:主模型(厂商/Key/端点/模型名)与提取文字(OCR 视觉模型)
import { VENDORS, CUSTOM_VENDOR_ID } from '../../engine/vendors'
import { useSettings, vendorKeyOf } from '../useSettingsSession'
import { SettingsCard, SetField, SetLine } from '../SettingsPrimitives'

export function ModelSettings() {
  const { form, setForm, saveField, vendorId, setVendorId, keyDrafts, setKeyDrafts, flashCard } = useSettings()

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
    </>
  )
}
