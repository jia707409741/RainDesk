use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{Emitter, Manager, State, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

use crate::models::{Group, Shortcut, Store, Todo};
use crate::store::AppState;

/// Windows Shell 启动：直接交给系统关联程序处理，不会创建 cmd 控制台窗口。
#[cfg(windows)]
mod shell {
    const SW_SHOWNORMAL: i32 = 1;

    #[link(name = "shell32")]
    extern "system" {
        #[link_name = "ShellExecuteW"]
        fn shell_execute_w(
            hwnd: isize,
            operation: *const u16,
            file: *const u16,
            params: *const u16,
            dir: *const u16,
            show_cmd: i32,
        ) -> isize;
    }

    /// 用 ShellExecuteW "open" 打开目标；返回值 >32 表示成功。
    pub fn open(target: &str) -> Result<(), String> {
        let op: Vec<u16> = "open\0".encode_utf16().collect();
        let file: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();
        let ret = unsafe {
            shell_execute_w(
                0,
                op.as_ptr(),
                file.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        if ret <= 32 {
            Err(format!("系统打开失败（代码 {}）", ret))
        } else {
            Ok(())
        }
    }
}

/// 全局标记：提醒悬浮窗是否已经创建过（避免重复创建）
pub static REMINDER_WIN_CREATED: AtomicBool = AtomicBool::new(false);

// ---------- 数据读写 ----------

#[tauri::command]
pub fn get_store(state: State<'_, AppState>) -> Result<Store, String> {
    let store = state.store.lock().map_err(|e| e.to_string())?;
    Ok(store.clone())
}

#[tauri::command]
pub fn save_store(store: Store, state: State<'_, AppState>) -> Result<(), String> {
    {
        let mut guard = state.store.lock().map_err(|e| e.to_string())?;
        *guard = store;
    }
    state.persist()
}

/// 数据目录信息（当前 / 默认 / 是否已自定义）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDirInfo {
    /// 当前实际使用的数据目录
    pub current: String,
    /// 应用默认数据目录
    pub default: String,
    /// 当前是否使用自定义目录
    pub customized: bool,
    /// 仅 set_data_dir 返回：migrated=数据已复制过去；switched=切换到该目录已有数据
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
}

fn dir_of(store_path: &PathBuf) -> PathBuf {
    store_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
}

fn build_dir_info(app: &tauri::AppHandle, state: &AppState, mode: Option<String>) -> DataDirInfo {
    let current = dir_of(&state.data_path());
    let default = crate::config::default_data_dir(app);
    DataDirInfo {
        current: current.to_string_lossy().to_string(),
        default: default.to_string_lossy().to_string(),
        customized: current != default,
        mode,
    }
}

/// 返回数据文件所在目录信息，方便用户备份 / 在设置里展示
#[tauri::command]
pub fn get_data_dir_info(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<DataDirInfo, String> {
    Ok(build_dir_info(&app, &state, None))
}

/// 兼容旧调用：只返回当前数据目录字符串
#[tauri::command]
pub fn get_data_dir(state: State<'_, AppState>) -> Result<String, String> {
    Ok(dir_of(&state.data_path()).to_string_lossy().to_string())
}

#[tauri::command]
pub fn open_data_dir(state: State<'_, AppState>) -> Result<(), String> {
    let dir = dir_of(&state.data_path());
    #[cfg(windows)]
    Command::new("explorer.exe")
        .arg(&dir)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 弹出系统文件夹选择框，返回用户选中的目录（取消则返回 null）
#[tauri::command]
pub async fn pick_data_dir(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let folder = app.dialog().file().blocking_pick_folder();
    Ok(folder
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().to_string()))
}

/// 设置自定义数据目录。
/// - 目标目录已有 store.json：直接切换到该目录的数据（可用于恢复备份）
/// - 目标目录为空：把当前数据复制过去（原文件保留作为备份）
#[tauri::command]
pub fn set_data_dir(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<DataDirInfo, String> {
    let raw = path.trim();
    if raw.is_empty() {
        return Err("目录不能为空".into());
    }
    let dir = PathBuf::from(raw);
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建目录: {e}"))?;
    if !dir.is_dir() {
        return Err("目标路径不是文件夹".into());
    }

    let target_store = dir.join("store.json");
    let mode;

    if target_store.exists() {
        // 目标已有数据：加载它，实现数据集切换
        let loaded = AppState::read_store(&target_store)
            .map_err(|e| format!("目标目录数据文件损坏: {e}"))?;
        {
            let mut guard = state.store.lock().map_err(|e| e.to_string())?;
            *guard = loaded;
        }
        mode = "switched";
    } else {
        // 目标为空：复制当前数据过去
        let current = state.store.lock().map_err(|e| e.to_string())?.clone();
        AppState::write_store(&target_store, &current)?;
        mode = "migrated";
    }

    // 先落盘数据，再写位置指针，最后更新内存路径，保证任一步失败都不会指向无效数据
    crate::config::write_data_dir(&app, Some(&dir))?;
    state.set_data_path(target_store);

    Ok(build_dir_info(&app, &state, Some(mode.into())))
}

// ---------- 启动快捷方式 ----------

/// 打开一个快捷方式。app=可执行程序，url=网址，folder=文件夹，command=原始命令
#[tauri::command]
pub fn launch_shortcut(shortcut: Shortcut) -> Result<(), String> {
    let target = shortcut.target.trim();
    if target.is_empty() {
        return Err("目标为空".into());
    }

    #[cfg(windows)]
    {
        match shortcut.kind.as_str() {
            // 网址 / 程序 / 文件夹统一交给 ShellExecute：不弹 cmd 控制台，
            // 且能正确处理带空格路径、.lnk 快捷方式、系统关联打开。
            "url" => shell::open(target).map_err(|e| format!("打开网址失败: {e}"))?,
            "folder" => shell::open(target).map_err(|e| format!("打开文件夹失败: {e}"))?,
            "app" => shell::open(target).map_err(|e| format!("启动程序失败: {e}"))?,
            "command" => {
                // 命令类必须经 cmd 解释，用 CREATE_NO_WINDOW 隐藏控制台窗口。
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x08000000;
                Command::new("cmd")
                    .args(["/C", target])
                    .creation_flags(CREATE_NO_WINDOW)
                    .spawn()
                    .map_err(|e| format!("执行命令失败: {e}"))?;
            }
            _ => shell::open(target).map_err(|e| format!("启动失败: {e}"))?,
        }
    }
    Ok(())
}

// ---------- 提醒悬浮窗 ----------

/// 创建（或复用）置顶提醒窗口，并把待办数据推送进去
#[tauri::command]
pub fn show_reminder(app: tauri::AppHandle, todo: Todo, count: usize) -> Result<(), String> {
    if !REMINDER_WIN_CREATED.load(Ordering::SeqCst) {
        let fallback = tauri::PhysicalSize::new(1920u32, 1080u32);
        let monitor_size = app
            .primary_monitor()
            .ok()
            .flatten()
            .map(|m| *m.size())
            .unwrap_or(fallback);
        let win_w = 380.0f64;
        let win_h = 230.0f64;
        let x = monitor_size.width as f64 - win_w - 24.0;
        let y = monitor_size.height as f64 - win_h - 60.0;

        WebviewWindowBuilder::new(&app, "reminder", tauri::WebviewUrl::App("reminder.html".into()))
            .title("待办提醒")
            .inner_size(win_w, win_h)
            .position(x.max(0.0), y.max(0.0))
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .decorations(false)
            .shadow(true)
            .visible(true)
            .build()
            .map_err(|e| format!("创建提醒窗口失败: {e}"))?;
        REMINDER_WIN_CREATED.store(true, Ordering::SeqCst);

        // 等待 WebView 初始化完成后再推送数据
        let app2 = app.clone();
        let todo2 = todo.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(700));
            let _ = app2.emit_to("reminder", "reminder-data", (todo2, count));
        });
    } else if let Some(win) = app.get_webview_window("reminder") {
        let _ = app.emit_to("reminder", "reminder-data", (todo, count));
        let _ = win.show();
        let _ = win.set_focus();
    }
    Ok(())
}

#[tauri::command]
pub fn hide_reminder(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("reminder") {
        let _ = win.hide();
    }
    Ok(())
}

/// 提醒窗口中点击"完成"：更新待办状态并持久化
#[tauri::command]
pub fn complete_todo(id: String, state: State<'_, AppState>) -> Result<Vec<Todo>, String> {
    {
        let mut guard = state.store.lock().map_err(|e| e.to_string())?;
        if let Some(todo) = guard.todos.iter_mut().find(|t| t.id == id) {
            todo.done = true;
            todo.reminded = true;
        }
    }
    state.persist()?;
    let guard = state.store.lock().map_err(|e| e.to_string())?;
    Ok(guard.todos.clone())
}

// ---------- 系统托盘（Windows 任务栏）通知 ----------

/// 根据拖入的文件/文件夹路径推断出快捷方式信息（不写入 store，由前端决定放入哪个分组）
#[tauri::command]
pub fn shortcuts_from_paths(paths: Vec<String>) -> Result<Vec<Shortcut>, String> {
    let mut result = Vec::new();
    for (i, path) in paths.iter().enumerate() {
        if path.is_empty() {
            continue;
        }
        let p = std::path::Path::new(path);
        let file_name = p
            .file_stem()
            .or_else(|| p.file_name())
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "快捷方式".into());

        let is_dir = p.is_dir();
        let ext = p
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();

        let (kind, target, icon, color): (&str, String, &str, &str) = if is_dir {
            ("folder", path.clone(), "📁", "blue")
        } else if ext == "url" || ext == "website" {
            // 解析 .url / .website 文件中的 URL=
            let url = parse_url_file(path).unwrap_or_else(|| path.clone());
            ("url", url, "🌐", "cyan")
        } else if ext == "exe" || ext == "msi" || ext == "bat" || ext == "cmd" || ext == "app" {
            ("app", path.clone(), "⚙️", "purple")
        } else {
            // 其他文件：用 start 交给系统默认程序打开
            let (ic, co) = infer_by_ext(&ext);
            ("app", path.clone(), ic, co)
        };

        // 从系统提取真实文件图标（PNG data URL）；失败则前端回退到 emoji。
        // 文件夹、exe、lnk、普通文件都能拿到；.url 用其原始路径的图标。
        let icon_data = crate::icon::icon_data_url(path);

        result.push(Shortcut {
            id: format!("s-drop-{}-{}", now(), i),
            name: file_name,
            target,
            kind: kind.into(),
            icon: icon.into(),
            color: color.into(),
            icon_data,
        });
    }
    Ok(result)
}

fn now() -> i128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i128)
        .unwrap_or(0)
}

/// 从 .url / .website (INI 格式) 中读取 URL= 行
fn parse_url_file(path: &str) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    for line in text.lines() {
        let line = line.trim();
        if line.to_ascii_lowercase().starts_with("url=") {
            let url = line[4..].trim().to_string();
            if !url.is_empty() {
                return Some(url);
            }
        }
    }
    None
}

/// 按扩展名推断图标和颜色
fn infer_by_ext(ext: &str) -> (&'static str, &'static str) {
    match ext {
        "txt" | "md" | "doc" | "docx" | "rtf" | "pdf" => ("📄", "blue"),
        "xls" | "xlsx" | "csv" | "numbers" => ("📊", "green"),
        "ppt" | "pptx" | "key" => ("📽️", "orange"),
        "png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp" | "svg" | "ico" => ("🖼️", "pink"),
        "mp4" | "mkv" | "avi" | "mov" | "wmv" | "flv" => ("🎬", "purple"),
        "mp3" | "wav" | "flac" | "aac" | "m4a" => ("🎵", "cyan"),
        "zip" | "rar" | "7z" | "tar" | "gz" => ("📦", "orange"),
        "lnk" => ("🔗", "blue"),
        "ps1" | "sh" | "py" | "js" | "ts" => ("💻", "green"),
        "html" | "htm" | "css" => ("🌐", "cyan"),
        _ => ("📌", "blue"),
    }
}

/// 查询开机自启动状态
#[tauri::command]
pub fn get_autostart() -> Result<bool, String> {
    crate::autostart::is_enabled()
}

/// 设置开机自启动
#[tauri::command]
pub fn set_autostart(enabled: bool) -> Result<(), String> {
    crate::autostart::set_enabled(enabled)
}

/// 更新全局快捷键：先校验并尝试注册，成功后写入设置；任一失败则回滚到旧快捷键并返回错误。
#[tauri::command]
pub fn set_shortcuts(
    toggle: String,
    new_todo: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let toggle = toggle.trim().to_string();
    let new_todo = new_todo.trim().to_string();
    if toggle.is_empty() || new_todo.is_empty() {
        return Err("快捷键不能为空".into());
    }
    if toggle == new_todo {
        return Err("两个快捷键不能相同".into());
    }

    // 记录旧值用于回滚
    let (old_toggle, old_new_todo) = {
        let guard = state.store.lock().map_err(|e| e.to_string())?;
        (
            guard.settings.toggle_shortcut.clone(),
            guard.settings.new_todo_shortcut.clone(),
        )
    };

    let errors = crate::apply_global_shortcuts(&app, &toggle, &new_todo);
    if !errors.is_empty() {
        // 有注册失败：回滚到旧快捷键，保持原有可用状态
        let _ = crate::apply_global_shortcuts(&app, &old_toggle, &old_new_todo);
        return Err(errors.join("；"));
    }

    // 注册成功：写入设置并持久化
    {
        let mut guard = state.store.lock().map_err(|e| e.to_string())?;
        guard.settings.toggle_shortcut = toggle;
        guard.settings.new_todo_shortcut = new_todo;
    }
    state.persist()
}

/// 暂停所有全局快捷键（录制新快捷键时调用，避免按下旧组合键触发原有行为）。
#[tauri::command]
pub fn suspend_shortcuts(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    app.global_shortcut()
        .unregister_all()
        .map_err(|e| e.to_string())
}

/// 触发一次系统通知（使用 Tauri notification 插件的 JS API 亦可，这里预留给 Rust 侧调用）
#[tauri::command]
pub fn noop() -> Result<(), String> {
    Ok(())
}

/// 仅用于占位以保持 Group/Store 类型被引用（编译期检查）
#[allow(dead_code)]
fn _type_markers(_g: Group, _s: Shortcut, _st: Store, _t: Todo) {}
