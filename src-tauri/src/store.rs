use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::models::Store;

/// 应用状态：持有持久化数据和数据文件路径。
/// data_path 用 Mutex 包裹，支持运行时切换数据目录后立即生效。
pub struct AppState {
    pub store: Mutex<Store>,
    data_path: Mutex<PathBuf>,
}

impl AppState {
    pub fn load(data_path: PathBuf) -> Self {
        let store = match fs::read_to_string(&data_path) {
            Ok(text) => serde_json::from_str::<Store>(&text).unwrap_or_else(|e| {
                eprintln!("[RainDesk] 数据文件解析失败({e})，使用默认数据");
                Store::default()
            }),
            Err(_) => Store::default(),
        };
        AppState {
            store: Mutex::new(store),
            data_path: Mutex::new(data_path),
        }
    }

    /// 当前 store.json 的完整路径
    pub fn data_path(&self) -> PathBuf {
        self.data_path
            .lock()
            .map(|p| p.clone())
            .unwrap_or_default()
    }

    /// 切换数据文件路径
    pub fn set_data_path(&self, path: PathBuf) {
        if let Ok(mut guard) = self.data_path.lock() {
            *guard = path;
        }
    }

    /// 将当前内存中的数据写回磁盘（原子写：先临时文件再替换）
    pub fn persist(&self) -> Result<(), String> {
        let path = self.data_path();
        let store = self.store.lock().map_err(|e| e.to_string())?;
        Self::write_store(&path, &store)
    }

    /// 把指定数据写到指定路径（原子写）
    pub fn write_store(path: &Path, store: &Store) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, text).map_err(|e| e.to_string())?;
        fs::rename(&tmp, path).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 从指定路径加载数据（文件不存在时返回 Err）
    pub fn read_store(path: &Path) -> Result<Store, String> {
        let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
        serde_json::from_str::<Store>(&text).map_err(|e| e.to_string())
    }
}
