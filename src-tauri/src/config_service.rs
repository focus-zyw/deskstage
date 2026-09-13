// 统一状态中心:config.json 与共享数据文件的唯一写者(Rust 进程级)。
//
// 为什么收归 Rust:main/settings 两个 WebView 各持一份前端模块实例,内存锁
// 互不可见,"主窗唯一写者"只是事件约定(GeneralSettings/VoiceSettings 就有
// 绕过中继直写的点)。所有读写经这把进程级 Mutex 串行,竞态从约定变机制。
// 顺带交付前端做不好的三件事:
//   · 原子写:同目录临时文件 + rename(旧实现原地覆盖,Rust 读端被迫做撕裂读重试)
//   · 版本迁移:version 戳 + MIGRATIONS 表,加载时按序补迁并落盘
//   · 密钥事务:备好临时文件 → 写凭据库 → rename;任一步失败旧文件原样保留 = 回滚
//
// 分工:字段级 schema 校验/清洗/默认值单源在前端 sanitizeConfig(40+ 字段的
// schema 不在 Rust 复制);Rust 只管结构、版本与密钥。
// 广播:config-changed / store-changed 由 Rust emit 到全部窗口(含写者,前端幂等
// 采纳),替代旧"主窗写完 emitTo 设置窗"的单向通知。
//
// 数据文件(data_get/data_set):设置窗可写的共享 store(bubble-themes/
// custom-modes/memory/topic-state)。它们的 version 与清洗本就在前端,保持
// TS 单源;这里只提供串行化 + 原子写 + 广播。

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

/// 当前配置 schema 版本。历史文件无 version 字段视为 0(遗留)。
pub const CURRENT_VERSION: u32 = 1;

type Migration = fn(&mut Value);

/// 迁移注册表:索引 = from_version,加载时从旧版本按序应用到 CURRENT_VERSION。
/// v0→v1 只落版本戳:遗留形状(缺字段/旧键名)仍由前端读时 sanitize 兜底。
/// 未来 schema 变更:在此追加步骤并 CURRENT_VERSION +1,老文件启动时自动补迁。
const MIGRATIONS: &[Migration] = &[];

/// 共享数据文件白名单:store 名 ↔ 文件名(与前端各 store 的 FILE_NAME 一致)。
const DATA_STORES: &[(&str, &str)] = &[
    ("bubble-themes", "bubble-themes.json"),
    ("custom-modes", "custom-modes.json"),
    ("memory", "memory.json"),
    ("topic-state", "topic-state.json"),
];

/// 进程级配置状态:一把锁串行化全部读写(单写者的机制化)。
#[derive(Default)]
pub struct ConfigState {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    /// 已提交配置(含 version 戳;内存含真实密钥,落盘副本经 strip_secrets 剥离;
    /// None = 尚未从磁盘加载)
    config: Option<Value>,
    /// 数据文件缓存:store 名 → 已解析 JSON(Null = 文件不存在)
    data: HashMap<String, Value>,
    /// 数据 revision:每 store 独立计数,首次加载记 1,成功写入 +1。
    /// CAS 提交用——"读(revision)→改→条件写"整体在前端,memory 这类读改写密集
    /// 的 store 靠 revision 对比防双窗互相覆盖(data_set 全量替换只串行了写入本身)
    data_revisions: HashMap<String, u64>,
}

fn data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| e.to_string())
        .map(|p| p.join("data"))
}

/// 原子写:同目录临时文件写全量,再 rename 覆盖(同盘 rename 原子;
/// 先例:密钥迁移 config.json.migrating)。失败时清理临时文件,原文件不受半截内容破坏。
fn atomic_write(file: &std::path::Path, body: &str) -> Result<(), String> {
    let name = file
        .file_name()
        .ok_or_else(|| "路径缺少文件名".to_string())?
        .to_string_lossy()
        .to_string();
    let tmp = file.with_file_name(format!("{name}.tmp"));
    std::fs::write(&tmp, body).map_err(|e| format!("写临时文件失败: {e}"))?;
    if let Err(e) = std::fs::rename(&tmp, file) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("替换文件失败: {e}"));
    }
    Ok(())
}

/// 首启桩:只带版本戳。字段级默认值单源在前端(DEFAULT_CONFIG + sanitizeConfig),
/// 前端读到桩会清洗成全默认配置;桩文件同时保住"config.json 存在"的读方前提。
fn write_stub(file: &std::path::Path) -> Result<Value, String> {
    let cfg = json!({ "version": CURRENT_VERSION });
    let body = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    atomic_write(file, &body)?;
    Ok(cfg)
}

/// 版本迁移:按 MIGRATIONS 从 from 补迁到当前版本,戳盘(下次启动不再迁移)。
fn migrate_version(cfg: &mut Value, file: &std::path::Path) -> Result<(), String> {
    let from = cfg.get("version").and_then(Value::as_u64).unwrap_or(0);
    if from > CURRENT_VERSION as u64 {
        return Err(format!("配置版本过新({from} > {CURRENT_VERSION}),请升级应用"));
    }
    if from == CURRENT_VERSION as u64 {
        return Ok(());
    }
    for &migration in MIGRATIONS.iter().skip(from as usize) {
        migration(cfg);
    }
    if let Some(obj) = cfg.as_object_mut() {
        obj.insert("version".into(), json!(CURRENT_VERSION));
    }
    let body = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    atomic_write(file, &body)
}

/// 加载单飞:读文件 → 版本迁移 → 凭据库回填密钥。锁内调用。
fn ensure_config_loaded(app: &AppHandle, inner: &mut Inner) -> Result<(), String> {
    if inner.config.is_some() {
        return Ok(());
    }
    // 首读前把历史明文迁进凭据库(secrets.rs 进程级单飞,双窗并发安全);
    // 失败不阻塞加载:文件里的旧明文照常可读,下次启动重试
    if let Err(e) = crate::secrets::secrets_migrate_if_needed(app.clone()) {
        log::warn!("明文密钥迁移未完成,下次启动重试: {e}");
    }
    let dir = data_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
    let file = dir.join("config.json");
    let mut cfg = match std::fs::read_to_string(&file) {
        Ok(raw) => match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => {
                // 手改损坏:备份现场后从桩重来(下次保存即写入合法配置),不吞证据
                let _ = std::fs::rename(&file, dir.join("config.json.corrupt"));
                log::warn!("配置解析失败({e}),原文件已备份为 config.json.corrupt,配置重置");
                write_stub(&file)?
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => write_stub(&file)?,
        Err(e) => return Err(format!("读取配置失败: {e}")),
    };
    migrate_version(&mut cfg, &file)?;
    crate::secrets::resolve_secrets(&mut cfg);
    inner.config = Some(cfg);
    Ok(())
}

/// 浅合并:patch 的顶层键覆盖 base(与旧前端 {...current, ...update} 同语义)。
/// 合并在 Rust 侧进行,两个窗口并发保存不会交错读改写互相覆盖。
fn merge_shallow(base: &mut Value, patch: &Value) {
    if let (Some(obj), Some(overrides)) = (base.as_object_mut(), patch.as_object()) {
        for (k, v) in overrides {
            obj.insert(k.clone(), v.clone());
        }
    }
}

/// 只读访问:已加载的内存配置(含 version 戳与真实密钥)。
/// 供 Rust 侧消费方(endpoint_proxy 解析端点地址)使用,免撕裂读文件;
/// 未加载返回 None——不在这里触发磁盘 IO/凭据读取,加载由前端首读驱动。
pub fn committed(app: &AppHandle) -> Option<Value> {
    let state = app.state::<ConfigState>();
    let inner = state.inner.lock().ok()?;
    inner.config.clone()
}

#[tauri::command]
pub fn config_get(app: AppHandle, state: State<'_, ConfigState>) -> Result<Value, String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    ensure_config_loaded(&app, &mut inner)?;
    Ok(inner.config.clone().unwrap_or(Value::Null))
}

/// 保存:浅合并 → 密钥事务(备临时文件→写凭据库→rename)→ 内存提交 → 广播。
/// 任一步失败,磁盘与内存的旧值原样保留(回滚);返回合并后的完整配置。
#[tauri::command]
pub fn config_set(
    app: AppHandle,
    state: State<'_, ConfigState>,
    update: Value,
) -> Result<Value, String> {
    if !update.is_object() {
        return Err("配置更新必须是 JSON 对象".into());
    }
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    ensure_config_loaded(&app, &mut inner)?;
    let mut merged = inner
        .config
        .clone()
        .unwrap_or_else(|| json!({ "version": CURRENT_VERSION }));
    merge_shallow(&mut merged, &update);

    // ① 备好临时文件(旧文件未动);② 写凭据库,任一失败清理后报错——磁盘与内存均未变;
    // ③ rename 提交。空串 = 清除凭据,map 型整组紧凑 JSON(语义与前端旧实现一致)
    let file = data_dir(&app)?.join("config.json");
    let mut stripped = merged.clone();
    crate::secrets::strip_secrets(&mut stripped);
    let body = serde_json::to_string_pretty(&stripped).map_err(|e| e.to_string())?;
    let name = file
        .file_name()
        .ok_or_else(|| "路径缺少文件名".to_string())?
        .to_string_lossy()
        .to_string();
    let tmp = file.with_file_name(format!("{name}.tmp"));
    std::fs::write(&tmp, &body).map_err(|e| format!("写临时文件失败: {e}"))?;
    for (path, id, is_map) in crate::secrets::SECRET_PATHS {
        let Some(v) = crate::secrets::value_at(&update, path) else {
            continue;
        };
        let encoded = if *is_map {
            v.to_string()
        } else {
            v.as_str().unwrap_or_default().to_string()
        };
        if let Err(e) = crate::secrets::write_secret(id, &encoded) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
    }
    if let Err(e) = std::fs::rename(&tmp, &file) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("替换配置文件失败: {e}"));
    }

    inner.config = Some(merged.clone());
    // 广播到全部窗口(含写者;前端幂等采纳),这是唯一的通知通路
    let _ = app.emit("config-changed", json!({ "config": merged.clone() }));
    Ok(merged)
}

fn store_file(store: &str) -> Result<&'static str, String> {
    DATA_STORES
        .iter()
        .find(|(k, _)| *k == store)
        .map(|(_, f)| *f)
        .ok_or_else(|| format!("未知的 store: {store}"))
}

/// 惰性加载单 store:返回 (revision, 值)。首次加载(含文件不存在)revision 记 1。
/// 锁内调用。
fn ensure_data_loaded(
    app: &AppHandle,
    inner: &mut Inner,
    store: &str,
) -> Result<(u64, Value), String> {
    if let Some(rev) = inner.data_revisions.get(store) {
        let value = inner.data.get(store).cloned().unwrap_or(Value::Null);
        return Ok((*rev, value));
    }
    let file_name = store_file(store)?;
    let file = data_dir(app)?.join(file_name);
    let v = match std::fs::read_to_string(&file) {
        // 手改坏数据按不存在处理:返回 Null(前端清洗成空仓),下次保存即修复
        Ok(raw) => serde_json::from_str(&raw).unwrap_or(Value::Null),
        Err(_) => Value::Null,
    };
    inner.data.insert(store.to_string(), v.clone());
    inner.data_revisions.insert(store.to_string(), 1);
    Ok((1, v))
}

#[tauri::command]
pub fn data_get(app: AppHandle, state: State<'_, ConfigState>, store: String) -> Result<Value, String> {
    store_file(&store)?;
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    let (_, value) = ensure_data_loaded(&app, &mut inner, &store)?;
    Ok(value)
}

/// 带版本读取:前端 CAS"读→改→条件写"的第一步。
#[tauri::command]
pub fn data_get_with_revision(
    app: AppHandle,
    state: State<'_, ConfigState>,
    store: String,
) -> Result<Value, String> {
    store_file(&store)?;
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    let (revision, value) = ensure_data_loaded(&app, &mut inner, &store)?;
    Ok(json!({ "revision": revision, "value": value }))
}

/// CAS 提交的内存侧(无 IO):expected 不符返回 Err((当前 revision, 当前值))。
/// 相符则更新内存缓存并推进 revision,返回新 revision。调用方负责先做磁盘原子写。
fn cas_commit(inner: &mut Inner, store: &str, expected: u64, value: Value) -> Result<u64, (u64, Value)> {
    let current = inner.data_revisions.get(store).copied().unwrap_or(0);
    let current_value = inner.data.get(store).cloned().unwrap_or(Value::Null);
    if current != expected {
        return Err((current, current_value));
    }
    let new_rev = current + 1;
    inner.data.insert(store.to_string(), value.clone());
    inner.data_revisions.insert(store.to_string(), new_rev);
    Ok(new_rev)
}

/// 全量替换写:前端清洗后的完整 store 状态 → 原子落盘 → 广播(载荷带新值,
/// 两窗直接采纳,不再"通知后回磁盘重读")。revision 推进 +1(与 CAS 通路共用计数)。
#[tauri::command]
pub fn data_set(
    app: AppHandle,
    state: State<'_, ConfigState>,
    store: String,
    value: Value,
) -> Result<Value, String> {
    store_file(&store)?;
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    let dir = data_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
    let body = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    atomic_write(&dir.join(store_file(&store)?), &body)?;
    let current = inner.data_revisions.entry(store.clone()).or_insert(1);
    let revision = *current + 1;
    *current = revision;
    inner.data.insert(store.clone(), value.clone());
    let _ = app.emit(
        "store-changed",
        json!({ "store": store, "value": value, "revision": revision }),
    );
    Ok(value)
}

/// CAS 条件写:expected_revision 与当前不符 → {status:"conflict", revision, value=当前值},
/// 前端取最新值重放 mutation 再提交;相符 → 原子落盘 + 内存提交 + 广播。
/// 让"读→改→写"整体原子的是这套协议本身,进程锁只保证判定与提交不分隔。
#[tauri::command]
pub fn data_set_if_revision(
    app: AppHandle,
    state: State<'_, ConfigState>,
    store: String,
    expected_revision: u64,
    value: Value,
) -> Result<Value, String> {
    store_file(&store)?;
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    let (current_rev, current) = ensure_data_loaded(&app, &mut inner, &store)?;
    if current_rev != expected_revision {
        return Ok(json!({
            "status": "conflict",
            "revision": current_rev,
            "value": current,
        }));
    }
    let dir = data_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
    let body = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    atomic_write(&dir.join(store_file(&store)?), &body)?;
    let new_rev = cas_commit(&mut inner, &store, expected_revision, value.clone())
        .map_err(|_| "CAS 提交状态不一致(判定已通过,理论不可达)".to_string())?;
    let _ = app.emit(
        "store-changed",
        json!({ "store": store, "value": value, "revision": new_rev }),
    );
    Ok(json!({ "status": "ok", "revision": new_rev, "value": value }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cas_commit_rejects_stale_and_advances_on_match() {
        let mut inner = Inner::default();
        inner.data.insert("memory".into(), json!({ "a": 1 }));
        inner.data_revisions.insert("memory".into(), 1);
        // 旧 revision:拒绝并带回当前值(前端据此重放 mutation)
        let err = cas_commit(&mut inner, "memory", 0, json!({ "a": 9 })).unwrap_err();
        assert_eq!(err.0, 1);
        assert_eq!(err.1["a"], 1);
        // 匹配:提交并推进 revision
        let rev = cas_commit(&mut inner, "memory", 1, json!({ "a": 2 })).unwrap();
        assert_eq!(rev, 2);
        assert_eq!(inner.data["memory"]["a"], 2);
        assert_eq!(inner.data_revisions["memory"], 2);
    }

    #[test]
    fn merge_shallow_overrides_top_level_keys_only() {
        let mut base = json!({
            "baseUrl": "https://a.com/v1",
            "voice": { "enabled": true, "provider": "siliconflow" },
            "dnd": false
        });
        merge_shallow(
            &mut base,
            &json!({ "voice": { "enabled": false }, "extra": 1 }),
        );
        // 整节替换(浅合并语义):patch 的 voice 完整覆盖,不深合并
        assert_eq!(base["voice"], json!({ "enabled": false }));
        assert_eq!(base["baseUrl"], "https://a.com/v1");
        assert_eq!(base["extra"], 1);
    }

    #[test]
    fn merge_shallow_ignores_non_object_inputs() {
        let mut base = json!({ "a": 1 });
        merge_shallow(&mut base, &json!("not-an-object"));
        assert_eq!(base, json!({ "a": 1 }));
    }

    #[test]
    fn atomic_write_replaces_content_and_leaves_no_tmp() {
        let dir = std::env::temp_dir().join(format!("vc-cfg-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("config.json");
        atomic_write(&file, "{\"v\":1}").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{\"v\":1}");
        atomic_write(&file, "{\"v\":2}").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{\"v\":2}");
        assert!(!dir.join("config.json.tmp").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn migrate_version_stamps_legacy_file_and_is_idempotent() {
        let dir = std::env::temp_dir().join(format!("vc-mig-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("config.json");
        // 遗留文件(无 version):补戳后落盘
        std::fs::write(&file, "{\"baseUrl\":\"https://a.com\"}").unwrap();
        let mut cfg: Value =
            serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        migrate_version(&mut cfg, &file).unwrap();
        assert_eq!(cfg["version"], CURRENT_VERSION);
        let on_disk: Value =
            serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(on_disk["version"], CURRENT_VERSION);
        // 已是当前版本:不再重写(内容原样,幂等)
        let before = std::fs::read_to_string(&file).unwrap();
        migrate_version(&mut cfg, &file).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), before);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn migrate_version_rejects_future_versions() {
        let dir = std::env::temp_dir().join(format!("vc-migf-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("config.json");
        let mut cfg = json!({ "version": CURRENT_VERSION + 1 });
        assert!(migrate_version(&mut cfg, &file).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn store_file_whitelist_only() {
        assert_eq!(store_file("bubble-themes").unwrap(), "bubble-themes.json");
        assert_eq!(store_file("memory").unwrap(), "memory.json");
        assert_eq!(store_file("topic-state").unwrap(), "topic-state.json");
        assert!(store_file("history").is_err());
        assert!(store_file("../config").is_err());
    }
}
