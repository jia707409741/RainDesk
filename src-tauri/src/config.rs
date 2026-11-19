use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;

/// 轻量位置配置：只记录用户自定义的数据目录。
/// 它固定存放在默认应用数据目录里，避免“读取 store.json 的路径本身也写在 store.json 里”的循环依赖。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LocationConfig {
    #[serde(default)]
    data_dir: Option<String>,
}

/// 默认应用数据目录（例如 %APPDATA%\com.raindesk.app）
pub fn default_data_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("raindesk"))
}

/// 位置配置文件路径，永远在默认目录
fn location_path(app: &tauri::AppHandle) -> PathBuf {
    default_data_dir(app).join("location.json")
}

/// 启动时解析实际使用的 store.json 路径
pub fn resolve_data_path(app: &tauri::AppHandle) -> PathBuf {
    let default_store = default_data_dir(app).join("store.json");
    let text = match fs::read_to_string(location_path(app)) {
        Ok(t) => t,
        Err(_) => return default_store,
    };
    let cfg = match serde_json::from_str::<LocationConfig>(&text) {
        Ok(c) => c,
        Err(_) => return default_store,
    };
    match cfg.data_dir {
        Some(dir) if !dir.trim().is_empty() => PathBuf::from(dir).join("store.json"),
        _ => default_store,
    }
}

/// 写入（或清除）自定义数据目录
pub fn write_data_dir(app: &tauri::AppHandle, dir: Option<&Path>) -> Result<(), String> {
    let cfg_path = location_path(app);
    if let Some(parent) = cfg_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    let cfg = LocationConfig {
        data_dir: dir.map(|p| p.to_string_lossy().to_string()),
    };
    let text = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    let tmp = cfg_path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("写入位置配置失败: {e}"))?;
    fs::rename(&tmp, &cfg_path).map_err(|e| format!("保存位置配置失败: {e}"))?;
    Ok(())
}
