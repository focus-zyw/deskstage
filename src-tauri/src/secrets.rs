// 系统凭据库(Windows Credential Manager)+ 配置明文一次性原子迁移。
//
// API Key / B站 Cookie 等敏感值只进凭据库,config.json 从此不落任何明文。
// SecretId 是封闭白名单(与前端 src/storage/secrets.ts 一致);map 型密钥
// (apiKeys)整组序列化为一条凭据——凭据库没有按前缀枚举的可靠 API,
// 封闭 id + 整组一条让"读回全部密钥"不需要枚举。
//
// 迁移为什么放 Rust:main/settings 两个 WebView 各持一份 configStore 模块实例,
// 前端模块级锁不跨窗口,双窗同时启动会竞争写配置;Rust 进程级单飞锁天然规避。
// 原子性:先写凭据库并逐条读回验证,全部成功后才用临时文件+rename 重写配置;
// 任一步失败保留旧配置不动,下次启动重试。成功后不留明文备份。

use serde_json::{Map, Value};
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

const SERVICE: &str = "dev.virtualcharacter.app";

/// 封闭的 SecretId 白名单(凭据库"账户名"),前端传别的 id 一律拒绝
const SECRET_IDS: [&str; 7] = [
    "llm:apiKey",
    "llm:apiKeys",
    "tts:voice",
    "tts:minimax",
    "asr:siliconflow",
    "ocr:apiKey",
    "llm:profileKeys",
];

fn id_allowed(id: &str) -> Result<(), String> {
    if SECRET_IDS.contains(&id) {
        Ok(())
    } else {
        Err(format!("未知的 SecretId: {id}"))
    }
}

/// 密钥路径表:(config.json 内 JSON 路径, SecretId, map 型整组一条)。
/// 路径治理单源:提取/剥离/回填/写库事务(config_service)全部遍历这张表,
/// 新增密钥只改这里与前端 configStore 的 SECRET_FIELDS。
pub const SECRET_PATHS: &[(&[&str], &str, bool)] = &[
    (&["apiKey"], "llm:apiKey", false),
    (&["apiKeys"], "llm:apiKeys", true),
    (&["voice", "apiKey"], "tts:voice", false),
    (&["voice", "minimax", "apiKey"], "tts:minimax", false),
    (&["voice", "asr", "apiKey"], "asr:siliconflow", false),
    (&["ocr", "apiKey"], "ocr:apiKey", false),
    (&["modelProfileKeys"], "llm:profileKeys", true),
];

/// 按 JSON 路径只读(存在才返回 Some);提取与写库事务共用。
pub fn value_at<'a>(cfg: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut cur = cfg;
    for key in path {
        cur = cur.get(key)?;
    }
    Some(cur)
}

/// 按 JSON 路径设值,中间层缺对象/非对象时补建为空对象(与前端 setByPath 同语义);
/// 根不是对象时放弃(调用方保证 config 根为对象)。
fn set_at_path(cfg: &mut Value, path: &[&str], value: Value) {
    let mut cur: Option<&mut Value> = Some(cfg);
    for key in &path[..path.len() - 1] {
        cur = cur.and_then(|v| {
            // 顺序借用:先判型(共享)→必要时补建空对象(可变,用完即还)→再下钻
            if !v.get(key).is_some_and(Value::is_object) {
                v.as_object_mut()?
                    .insert((*key).to_string(), Value::Object(Map::new()));
            }
            v.get_mut(key)
        });
    }
    if let Some(cur) = cur {
        if let Some(map) = cur.as_object_mut() {
            map.insert(path[path.len() - 1].to_string(), value);
        }
    }
}

pub fn read_secret(id: &str) -> Result<Option<String>, String> {
    id_allowed(id)?;
    let entry = keyring::Entry::new(SERVICE, id).map_err(|e| format!("打开凭据 {id} 失败: {e}"))?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("读取凭据 {id} 失败: {e}")),
    }
}

/// 空串语义 = 清除该凭据(与前端"输入框清空即删除"一致)
pub fn write_secret(id: &str, value: &str) -> Result<(), String> {
    id_allowed(id)?;
    let entry = keyring::Entry::new(SERVICE, id).map_err(|e| format!("打开凭据 {id} 失败: {e}"))?;
    if value.is_empty() {
        return match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("删除凭据 {id} 失败: {e}")),
        };
    }
    entry
        .set_password(value)
        .map_err(|e| format!("写入凭据 {id} 失败: {e}"))
}

pub fn delete_secret(id: &str) -> Result<(), String> {
    id_allowed(id)?;
    let entry = keyring::Entry::new(SERVICE, id).map_err(|e| format!("打开凭据 {id} 失败: {e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("删除凭据 {id} 失败: {e}")),
    }
}

#[tauri::command]
pub fn secret_get(id: String) -> Result<Option<String>, String> {
    read_secret(&id)
}

#[tauri::command]
pub fn secret_set(id: String, value: String) -> Result<(), String> {
    write_secret(&id, &value)
}

#[tauri::command]
pub fn secret_delete(id: String) -> Result<(), String> {
    delete_secret(&id)
}

/// 进程级单飞:双窗同时触发迁移也只执行一次;锁内 bool = 已完成
fn migration_state() -> &'static Mutex<bool> {
    static STATE: OnceLock<Mutex<bool>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(false))
}

/// 首次读取配置前由前端调用。返回是否实际迁移了明文。
/// 失败时保留旧配置原样返回 Err,前端照常按旧明文运行,下次启动重试。
#[tauri::command]
pub fn secrets_migrate_if_needed(app: tauri::AppHandle) -> Result<bool, String> {
    let mut state = migration_state().lock().map_err(|e| e.to_string())?;
    if *state {
        return Ok(false);
    }
    let migrated = migrate_config_file(&app)?;
    if migrated {
        log::info!("已将配置中的明文密钥迁移进系统凭据库");
    }
    // 迁移失败时不置位:保持旧配置原样返回 Err,下次启动重试
    *state = true;
    Ok(migrated)
}

fn migrate_config_file(app: &tauri::AppHandle) -> Result<bool, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("data");
    let file = dir.join("config.json");
    if !file.exists() {
        // 首启:配置文件由前端稍后写入默认值,无明文可迁
        return Ok(false);
    }
    let raw = std::fs::read_to_string(&file).map_err(|e| format!("读取配置失败: {e}"))?;
    let mut cfg: Value = serde_json::from_str(&raw).map_err(|e| format!("解析配置失败: {e}"))?;
    let secrets = extract_secrets(&cfg);
    if secrets.is_empty() {
        return Ok(false);
    }
    // 1) 逐条写入 → 2) 逐条读回验证;任一步失败立即中止,配置文件未动
    for (id, value) in &secrets {
        write_secret(id, value)?;
        let got = read_secret(id)?;
        if got.as_deref() != Some(value.as_str()) {
            let _ = delete_secret(id);
            return Err(format!("凭据读回验证失败: {id}"));
        }
    }
    // 3) 原子重写无密钥配置:同目录临时文件写全量再 rename(同盘 rename 原子)
    strip_secrets(&mut cfg);
    let tmp = dir.join("config.json.migrating");
    let body = serde_json::to_string_pretty(&cfg).map_err(|e| format!("序列化配置失败: {e}"))?;
    std::fs::write(&tmp, body).map_err(|e| format!("写迁移临时文件失败: {e}"))?;
    std::fs::rename(&tmp, &file).map_err(|e| format!("替换配置文件失败: {e}"))?;
    Ok(true)
}

/// 从配置对象提取全部明文密钥,返回 (SecretId, 值)。空串/缺字段跳过;
/// map 型(apiKeys)整体序列化为紧凑 JSON。
fn extract_secrets(cfg: &Value) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for (path, id, is_map) in SECRET_PATHS {
        let picked = match value_at(cfg, path) {
            Some(v @ Value::Object(m)) if *is_map && !m.is_empty() => Some(v.to_string()),
            Some(Value::String(s)) if !is_map && !s.trim().is_empty() => Some(s.clone()),
            _ => None,
        };
        if let Some(v) = picked {
            out.push(((*id).to_string(), v));
        }
    }
    out
}

/// 从配置对象剥离全部密钥字段(map 型整体删除),其余字段原样保留
pub fn strip_secrets(cfg: &mut Value) {
    for (path, _, _) in SECRET_PATHS {
        let mut cur: Option<&mut Value> = Some(cfg);
        for key in &path[..path.len() - 1] {
            cur = cur.and_then(|v| v.get_mut(key));
        }
        if let Some(Value::Object(map)) = cur {
            map.remove(path[path.len() - 1]);
        }
    }
}

/// 读取末尾回填(统一状态中心 config_get 用):凭据库有条目则覆盖进内存配置;
/// 无条目保留文件里的值(迁移失败的兜底);凭据损坏/读取失败保留原值不打挂读取。
pub fn resolve_secrets(cfg: &mut Value) {
    for (path, id, is_map) in SECRET_PATHS {
        let stored = match read_secret(id) {
            Ok(Some(v)) => v,
            _ => continue,
        };
        let value = if *is_map {
            serde_json::from_str::<Value>(&stored).unwrap_or(Value::Null)
        } else {
            Value::String(stored)
        };
        if value.is_null() {
            continue;
        }
        set_at_path(cfg, path, value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extract_picks_all_paths_in_whitelist_order() {
        let cfg = json!({
            "apiKey": "sk-main",
            "apiKeys": {"deepseek": "sk-a"},
            "voice": {"apiKey": "sk-tts", "minimax": {"apiKey": "sk-mm", "groupId": "g"},
                      "asr": {"apiKey": "sk-asr"}},
            "ocr": {"apiKey": "sk-ocr"}
        });
        let out = extract_secrets(&cfg);
        let ids: Vec<&str> = out.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "llm:apiKey",
                "llm:apiKeys",
                "tts:voice",
                "tts:minimax",
                "asr:siliconflow",
                "ocr:apiKey"
            ]
        );
        // map 型整组一条(紧凑 JSON);groupId 等非密钥字段不单独出条
        assert_eq!(out[1].1, r#"{"deepseek":"sk-a"}"#);
    }

    #[test]
    fn extract_skips_empty_and_missing_fields() {
        let cfg = json!({
            "apiKey": "  ",
            "voice": {"minimax": {"apiKey": ""}}
        });
        assert!(extract_secrets(&cfg).is_empty());
    }

    #[test]
    fn strip_removes_only_secret_fields() {
        let mut cfg = json!({
            "apiKey": "sk",
            "apiKeys": {"deepseek": "sk"},
            "model": "deepseek-chat",
            "voice": {"apiKey": "sk", "provider": "siliconflow",
                      "minimax": {"apiKey": "sk", "groupId": "g"},
                      "asr": {"apiKey": "sk", "model": "FunAudioLLM/SenseVoiceSmall"}},
            "ocr": {"apiKey": "sk", "model": "glm-4.6v-flash"}
        });
        strip_secrets(&mut cfg);
        let obj = cfg.as_object().unwrap();
        assert!(!obj.contains_key("apiKey") && !obj.contains_key("apiKeys"));
        assert_eq!(obj["model"], "deepseek-chat");
        assert_eq!(obj["voice"]["provider"], "siliconflow");
        assert!(obj["voice"].get("apiKey").is_none());
        assert_eq!(obj["voice"]["minimax"]["groupId"], "g");
        assert!(obj["voice"]["minimax"].get("apiKey").is_none());
        assert_eq!(obj["voice"]["asr"]["model"], "FunAudioLLM/SenseVoiceSmall");
        assert!(obj["voice"]["asr"].get("apiKey").is_none());
        assert!(obj["ocr"].get("apiKey").is_none());
        assert_eq!(obj["ocr"]["model"], "glm-4.6v-flash");
    }

    #[test]
    #[ignore = "真机凭据库冒烟:写/读/删一条测试凭据;CI 跳过,本机 cargo test -- --ignored 验证"]
    fn credential_manager_roundtrip() {
        // 用独立 service 名,不碰真实凭据
        let entry = keyring::Entry::new("dev.virtualcharacter.app.test", "smoke").unwrap();
        entry.set_password("v1").unwrap();
        assert_eq!(entry.get_password().unwrap(), "v1");
        entry.delete_credential().unwrap();
        assert!(matches!(entry.get_password(), Err(keyring::Error::NoEntry)));
    }
}
