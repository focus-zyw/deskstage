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

use serde_json::Value;
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

const SERVICE: &str = "dev.virtualcharacter.app";

/// 封闭的 SecretId 白名单(凭据库"账户名"),前端传别的 id 一律拒绝
const SECRET_IDS: [&str; 7] = [
    "llm:apiKey",
    "llm:apiKeys",
    "tts:voice",
    "tts:minimax",
    "video:apiKeys",
    "ocr:apiKey",
    "live:cookie",
];

fn id_allowed(id: &str) -> Result<(), String> {
    if SECRET_IDS.contains(&id) {
        Ok(())
    } else {
        Err(format!("未知的 SecretId: {id}"))
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
    let str_at = |path: &[&str]| -> Option<String> {
        let mut cur = cfg;
        for p in path {
            cur = cur.get(p)?;
        }
        match cur {
            Value::String(s) if !s.trim().is_empty() => Some(s.clone()),
            _ => None,
        }
    };
    let map_at = |path: &[&str]| -> Option<String> {
        let mut cur = cfg;
        for p in path {
            cur = cur.get(p)?;
        }
        match cur {
            Value::Object(m) if !m.is_empty() => Some(cur.to_string()),
            _ => None,
        }
    };
    let mut out = Vec::new();
    for (path, id, is_map) in [
        (&["apiKey"][..], "llm:apiKey", false),
        (&["apiKeys"][..], "llm:apiKeys", true),
        (&["voice", "apiKey"][..], "tts:voice", false),
        (&["voice", "minimax", "apiKey"][..], "tts:minimax", false),
        (&["videoGen", "apiKeys"][..], "video:apiKeys", true),
        (&["ocr", "apiKey"][..], "ocr:apiKey", false),
        (&["live", "cookie"][..], "live:cookie", false),
    ] {
        let picked = if is_map { map_at(path) } else { str_at(path) };
        if let Some(v) = picked {
            out.push((id.to_string(), v));
        }
    }
    out
}

/// 从配置对象剥离全部明文密钥字段(map 型整体删除),其余字段原样保留
fn strip_secrets(cfg: &mut Value) {
    let Some(obj) = cfg.as_object_mut() else {
        return;
    };
    obj.remove("apiKey");
    obj.remove("apiKeys");
    if let Some(voice) = obj.get_mut("voice").and_then(Value::as_object_mut) {
        voice.remove("apiKey");
        if let Some(mm) = voice.get_mut("minimax").and_then(Value::as_object_mut) {
            mm.remove("apiKey");
        }
    }
    if let Some(video) = obj.get_mut("videoGen").and_then(Value::as_object_mut) {
        video.remove("apiKeys");
    }
    if let Some(ocr) = obj.get_mut("ocr").and_then(Value::as_object_mut) {
        ocr.remove("apiKey");
    }
    if let Some(live) = obj.get_mut("live").and_then(Value::as_object_mut) {
        live.remove("cookie");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extract_picks_all_seven_paths_in_whitelist_order() {
        let cfg = json!({
            "apiKey": "sk-main",
            "apiKeys": {"deepseek": "sk-a"},
            "voice": {"apiKey": "sk-tts", "minimax": {"apiKey": "sk-mm", "groupId": "g"}},
            "videoGen": {"apiKeys": {"ark": "sk-v"}},
            "ocr": {"apiKey": "sk-ocr"},
            "live": {"cookie": "SESSDATA=xx"}
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
                "video:apiKeys",
                "ocr:apiKey",
                "live:cookie"
            ]
        );
        // map 型整组一条(紧凑 JSON);groupId 等非密钥字段不单独出条
        assert_eq!(out[1].1, r#"{"deepseek":"sk-a"}"#);
    }

    #[test]
    fn extract_skips_empty_and_missing_fields() {
        let cfg = json!({
            "apiKey": "  ",
            "voice": {"minimax": {"apiKey": ""}},
            "live": {}
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
                      "minimax": {"apiKey": "sk", "groupId": "g"}},
            "videoGen": {"apiKeys": {"ark": "sk"}, "provider": "ark"},
            "ocr": {"apiKey": "sk", "model": "glm-4.6v-flash"},
            "live": {"cookie": "SESSDATA=xx", "roomId": "1"}
        });
        strip_secrets(&mut cfg);
        let obj = cfg.as_object().unwrap();
        assert!(!obj.contains_key("apiKey") && !obj.contains_key("apiKeys"));
        assert_eq!(obj["model"], "deepseek-chat");
        assert_eq!(obj["voice"]["provider"], "siliconflow");
        assert!(obj["voice"].get("apiKey").is_none());
        assert_eq!(obj["voice"]["minimax"]["groupId"], "g");
        assert!(obj["voice"]["minimax"].get("apiKey").is_none());
        assert!(obj["videoGen"].get("apiKeys").is_none());
        assert_eq!(obj["videoGen"]["provider"], "ark");
        assert!(obj["ocr"].get("apiKey").is_none());
        assert_eq!(obj["ocr"]["model"], "glm-4.6v-flash");
        assert!(obj["live"].get("cookie").is_none());
        assert_eq!(obj["live"]["roomId"], "1");
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
