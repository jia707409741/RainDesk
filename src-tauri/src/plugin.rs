//! 插件中心：运行时加载 Rust 编译的动态库（Windows .dll / Linux .so / macOS .dylib）。
//!
//! 插件需要导出以下 C  ABI（详见 examples/raindesk-demo-plugin）：
//! - `raindesk_plugin_info() -> *mut c_char`：返回 JSON 元数据字符串（由插件分配）
//! - `raindesk_plugin_invoke(action: *const c_char, args: *const c_char) -> *mut c_char`：调用动作，返回 JSON/文本
//! - `raindesk_plugin_free(ptr: *mut c_char)`：释放上面两个函数返回的字符串
//! - 可选 `raindesk_plugin_init(ctx: *const c_char) -> i32`：初始化，ctx 为 JSON 上下文
//! - 可选 `raindesk_plugin_shutdown()`：卸载前清理
//!
//! 内存约定：返回字符串由插件用 CString::into_raw 分配，宿主调用插件导出的
//! `raindesk_plugin_free` 释放；宿主传入的指针宿主自己释放，插件不得释放。

use std::ffi::{CStr, CString};
use std::fs;
use std::os::raw::c_char;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use libloading::{Library, Symbol};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::store::AppState;

/// 插件接口版本。插件 manifest 里的 apiVersion 必须等于该值。
pub const API_VERSION: u32 = 1;

type InfoFn = unsafe extern "C" fn() -> *mut c_char;
type InvokeFn = unsafe extern "C" fn(*const c_char, *const c_char) -> *mut c_char;
type FreeFn = unsafe extern "C" fn(*mut c_char);
type InitFn = unsafe extern "C" fn(*const c_char) -> i32;
type ShutdownFn = unsafe extern "C" fn();

/// 插件可执行动作
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginAction {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
}

/// 插件元数据（由 raindesk_plugin_info 返回）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    /// emoji 图标
    #[serde(default)]
    pub icon: String,
    #[serde(default, rename = "apiVersion")]
    pub api_version: u32,
    #[serde(default)]
    pub actions: Vec<PluginAction>,
}

/// 传给前端的插件状态
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    #[serde(flatten)]
    pub manifest: PluginManifest,
    /// 动态库文件名
    pub file_name: String,
    /// 是否启用（停用状态保存在 store.json）
    pub enabled: bool,
    /// 动态库是否成功加载并初始化
    pub loaded: bool,
    /// 加载失败原因（加载成功时为 null）
    pub error: Option<String>,
    /// 插件目录里的唯一标识，供启用/调用/移除使用
    pub key: String,
}

/// 已加载的插件实例
struct LoadedPlugin {
    key: String,
    file_name: String,
    path: PathBuf,
    lib: Library,
    manifest: Option<PluginManifest>,
    error: Option<String>,
}

/// 插件管理器（作为 Tauri managed state）
#[derive(Default)]
pub struct PluginManager {
    plugins: Mutex<Vec<LoadedPlugin>>,
}

fn timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 插件目录：数据目录下的 plugins 子目录
pub fn plugins_dir(app: &tauri::AppHandle) -> PathBuf {
    match app.try_state::<AppState>() {
        Some(state) => state
            .data_path()
            .parent()
            .map(|p| p.join("plugins"))
            .unwrap_or_else(|| crate::config::default_data_dir(app).join("plugins")),
        None => crate::config::default_data_dir(app).join("plugins"),
    }
}

fn is_plugin_file(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let expected = std::env::consts::DLL_EXTENSION.to_ascii_lowercase();
    ext == expected || (cfg!(windows) && ext == "dll")
}

/// 读取插件返回的 C 字符串，并调用插件导出的 free 释放
unsafe fn take_string(lib: &Library, ptr: *mut c_char) -> Result<String, String> {
    if ptr.is_null() {
        return Err("插件返回了空指针".into());
    }
    let text = CStr::from_ptr(ptr).to_string_lossy().into_owned();
    let free: Symbol<FreeFn> = lib
        .get(b"raindesk_plugin_free\0")
        .map_err(|e| format!("插件缺少 raindesk_plugin_free 导出: {e}"))?;
    free(ptr);
    Ok(text)
}

/// 读取插件元数据
unsafe fn read_manifest(lib: &Library) -> Result<PluginManifest, String> {
    let info: Symbol<InfoFn> = lib
        .get(b"raindesk_plugin_info\0")
        .map_err(|e| format!("插件缺少 raindesk_plugin_info 导出: {e}"))?;
    let ptr = info();
    let json = take_string(lib, ptr)?;
    let manifest: PluginManifest =
        serde_json::from_str(&json).map_err(|e| format!("插件元数据 JSON 解析失败: {e}"))?;
    if manifest.name.trim().is_empty() {
        return Err("插件元数据缺少 name".into());
    }
    if manifest.api_version != API_VERSION {
        return Err(format!(
            "插件接口版本不兼容（插件 {}，宿主 {API_VERSION}）",
            manifest.api_version
        ));
    }
    Ok(manifest)
}

/// 调用可选的初始化函数
unsafe fn call_init(lib: &Library, app: &tauri::AppHandle) -> Result<(), String> {
    let Ok(init): Result<Symbol<InitFn>, _> = lib.get(b"raindesk_plugin_init\0") else {
        return Ok(());
    };
    let context = serde_json::json!({
        "apiVersion": API_VERSION,
        "dataDir": plugins_dir(app)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
    });
    let ctx = CString::new(context.to_string()).map_err(|e| e.to_string())?;
    let code = init(ctx.as_ptr());
    if code != 0 {
        return Err(format!("插件初始化失败（返回码 {code}）"));
    }
    Ok(())
}

impl PluginManager {
    /// 重新扫描插件目录并加载全部动态库
    pub fn reload(&self, app: &tauri::AppHandle) {
        let mut guard = match self.plugins.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        // 卸载旧插件前给它们一个清理机会
        for old in guard.iter() {
            unsafe {
                if let Ok(shutdown) = old.lib.get::<ShutdownFn>(b"raindesk_plugin_shutdown\0") {
                    shutdown();
                }
            }
        }
        guard.clear();

        let dir = plugins_dir(app);
        if fs::create_dir_all(&dir).is_err() {
            return;
        }
        let Ok(entries) = fs::read_dir(&dir) else { return };
        let mut files: Vec<PathBuf> = entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.is_file() && is_plugin_file(p))
            .collect();
        files.sort();

        let mut used_ids: Vec<String> = Vec::new();
        for path in files {
            let file_name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let stem = path
                .file_stem()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| file_name.clone());
            let mut key = stem.clone();
            let mut counter = 2;
            while used_ids.contains(&key) {
                key = format!("{stem}-{counter}");
                counter += 1;
            }
            used_ids.push(key.clone());

            let (lib, manifest, error) = match unsafe { Library::new(&path) } {
                Ok(lib) => {
                    let result = (|| unsafe {
                        let manifest = read_manifest(&lib)?;
                        call_init(&lib, app)?;
                        Ok(manifest)
                    })();
                    match result {
                        Ok(m) => (lib, Some(m), None),
                        Err(e) => (lib, None, Some(e)),
                    }
                }
                Err(e) => {
                    eprintln!("[RainDesk] 插件 {file_name} 加载失败: {e}");
                    continue;
                }
            };
            guard.push(LoadedPlugin {
                key,
                file_name,
                path,
                lib,
                manifest,
                error,
            });
        }
    }
}

fn disabled_plugins(state: &State<'_, AppState>) -> Result<Vec<String>, String> {
    let guard = state.store.lock().map_err(|e| e.to_string())?;
    Ok(guard.settings.disabled_plugins.clone())
}

/// 列出所有插件及其状态
#[tauri::command]
pub fn list_plugins(
    manager: State<'_, PluginManager>,
    state: State<'_, AppState>,
) -> Result<Vec<PluginInfo>, String> {
    let disabled = disabled_plugins(&state)?;
    let guard = manager.plugins.lock().map_err(|e| e.to_string())?;
    Ok(guard
        .iter()
        .map(|p| {
            let error = p.error.clone();
            let loaded = p.manifest.is_some() && error.is_none();
            PluginInfo {
                manifest: p
                    .manifest
                    .clone()
                    .unwrap_or_else(|| PluginManifest {
                        id: p.key.clone(),
                        name: p.file_name.clone(),
                        ..Default::default()
                    }),
                file_name: p.file_name.clone(),
                enabled: !disabled.contains(&p.key),
                loaded,
                error,
                key: p.key.clone(),
            }
        })
        .collect())
}

/// 启用 / 停用插件（写入 store.json 持久化）
#[tauri::command]
pub fn set_plugin_enabled(
    key: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let mut guard = state.store.lock().map_err(|e| e.to_string())?;
        let list = &mut guard.settings.disabled_plugins;
        list.retain(|x| x != &key);
        if !enabled {
            list.push(key);
        }
    }
    state.persist()
}

/// 调用插件动作，返回插件输出的 JSON / 文本
#[tauri::command]
pub fn invoke_plugin(
    key: String,
    action: String,
    args: Option<String>,
    manager: State<'_, PluginManager>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    if disabled_plugins(&state)?.contains(&key) {
        return Err("插件已停用，请先启用".into());
    }
    let guard = manager.plugins.lock().map_err(|e| e.to_string())?;
    let plugin = guard
        .iter()
        .find(|p| p.key == key)
        .ok_or_else(|| format!("插件 {key} 未加载"))?;
    if let Some(err) = &plugin.error {
        return Err(format!("插件加载失败: {err}"));
    }
    let action_c = CString::new(action).map_err(|e| format!("动作名含非法字符: {e}"))?;
    let args_c = CString::new(args.unwrap_or_else(|| "{}".into()))
        .map_err(|e| format!("参数含非法字符: {e}"))?;
    unsafe {
        let invoke: Symbol<InvokeFn> = plugin
            .lib
            .get(b"raindesk_plugin_invoke\0")
            .map_err(|e| format!("插件缺少 raindesk_plugin_invoke 导出: {e}"))?;
        let ptr = invoke(action_c.as_ptr(), args_c.as_ptr());
        take_string(&plugin.lib, ptr)
    }
}

/// 选择并安装插件动态库（复制到插件目录）
#[tauri::command]
pub fn install_plugin(
    app: tauri::AppHandle,
    manager: State<'_, PluginManager>,
) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("安装 RainDesk 插件（Rust 动态库）")
        .add_filter("Rust 插件", &[std::env::consts::DLL_EXTENSION])
        .add_filter("所有文件", &["*"])
        .blocking_pick_file();
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else {
        return Ok(None);
    };
    if !is_plugin_file(&path) {
        return Err(format!(
            "不支持的文件类型，需要 .{} 动态库",
            std::env::consts::DLL_EXTENSION
        ));
    }
    let dir = plugins_dir(&app);
    fs::create_dir_all(&dir).map_err(|e| format!("创建插件目录失败: {e}"))?;
    let name = path
        .file_name()
        .ok_or_else(|| "文件名无效".to_string())?;
    let mut target = dir.join(name);
    if target.exists() {
        let stem = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "plugin".into());
        let ext = path
            .extension()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| std::env::consts::DLL_EXTENSION.into());
        target = dir.join(format!("{stem}-{}.{ext}", timestamp_ms()));
    }
    fs::copy(&path, &target).map_err(|e| format!("复制插件失败: {e}"))?;
    manager.reload(&app);
    Ok(Some(target.to_string_lossy().to_string()))
}

/// 移除插件：把动态库移到 plugins/.trash，可恢复，不做永久删除
#[tauri::command]
pub fn remove_plugin(
    key: String,
    app: tauri::AppHandle,
    manager: State<'_, PluginManager>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let source = {
        let guard = manager.plugins.lock().map_err(|e| e.to_string())?;
        guard
            .iter()
            .find(|p| p.key == key)
            .map(|p| p.path.clone())
            .ok_or_else(|| format!("插件 {key} 不存在"))?
    };
    let trash = plugins_dir(&app).join(".trash");
    fs::create_dir_all(&trash).map_err(|e| format!("创建回收目录失败: {e}"))?;
    let name = source
        .file_name()
        .ok_or_else(|| "文件名无效".to_string())?;
    let target = trash.join(format!("{}-{}.{}", timestamp_ms(), name.to_string_lossy(), "bak"));
    fs::rename(&source, &target).map_err(|e| format!("移除插件失败: {e}"))?;

    {
        let mut guard = state.store.lock().map_err(|e| e.to_string())?;
        guard.settings.disabled_plugins.retain(|x| x != &key);
    }
    state.persist()?;
    manager.reload(&app);
    Ok(())
}

/// 插件目录路径（用于界面提示）
#[tauri::command]
pub fn get_plugin_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = plugins_dir(&app);
    fs::create_dir_all(&dir).map_err(|e| format!("创建插件目录失败: {e}"))?;
    Ok(dir.to_string_lossy().to_string())
}

/// 打开插件目录
#[tauri::command]
pub fn open_plugins_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = plugins_dir(&app);
    fs::create_dir_all(&dir).map_err(|e| format!("创建插件目录失败: {e}"))?;
    #[cfg(windows)]
    std::process::Command::new("explorer.exe")
        .arg(&dir)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

impl Default for PluginManifest {
    fn default() -> Self {
        PluginManifest {
            id: String::new(),
            name: String::new(),
            version: String::new(),
            description: String::new(),
            author: String::new(),
            icon: String::new(),
            api_version: 0,
            actions: Vec::new(),
        }
    }
}
