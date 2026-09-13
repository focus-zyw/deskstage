// 凭据库桥:API Key / B站 Cookie 等敏感值只进系统凭据库(Windows Credential Manager),
// 配置文件与 localStorage 永不落明文——读写两端都由 configStore 的
// SECRET_FIELDS 表统一改道,调用方(engine/settings)继续读 AppConfig 原字段。
//
// SecretId 是封闭白名单,与 src-tauri/src/secrets.rs 一一对应;map 型密钥
// (apiKeys)整组 JSON 序列化为一条,因为凭据库不支持按前缀枚举。
// 浏览器预览(!inTauri)降级:localStorage 独立键 vc-secret:*,仅开发调试用,
// 勿在其中输入生产凭证。
import { invoke } from '@tauri-apps/api/core'

export type SecretId =
  | 'llm:apiKey'
  | 'llm:apiKeys'
  | 'tts:voice'
  | 'tts:minimax'
  | 'video:apiKeys'
  | 'ocr:apiKey'
  | 'live:cookie'

const LS_PREFIX = 'vc-secret:'

// 与 configStore 的 inTauri 同判据;独立声明,避免 storage 内部循环引用
const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** 读取凭据。null = 凭据库无此条,调用方回退到配置本体的历史值
 *  (迁移失败或浏览器预览的兜底路径) */
export async function readSecret(id: SecretId): Promise<string | null> {
  if (!inTauri) {
    try {
      return localStorage.getItem(LS_PREFIX + id)
    } catch {
      return null
    }
  }
  return (await invoke<string | null>('secret_get', { id })) ?? null
}

/** 写凭据;空串语义 = 删除该凭据(与设置页"清空输入框即清除"一致) */
export async function writeSecret(id: SecretId, value: string): Promise<void> {
  if (!inTauri) {
    try {
      if (value === '') localStorage.removeItem(LS_PREFIX + id)
      else localStorage.setItem(LS_PREFIX + id, value)
    } catch {
      /* 预览环境存储不可用:静默,等同未持久化 */
    }
    return
  }
  await invoke('secret_set', { id, value })
}
