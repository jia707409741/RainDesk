mod autostart;
mod commands;
mod config;
mod icon;
mod models;
mod store;

use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{Emitter, Listener, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use commands::{hide_reminder, show_reminder};
use store::AppState;

/// 后台提醒引擎：每 10 秒扫描一次到期待办，弹窗提醒并通知主界面刷新
fn start_reminder_engine(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(10));

        let state = match app.try_state::<AppState>() {
            Some(s) => s,
            None => continue,
        };

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);

        // 收集本次需要提醒的待办
        let due_todos: Vec<models::Todo> = {
            let guard = match state.store.lock() {
                Ok(g) => g,
                Err(_) => continue,
            };
            guard
                .todos
                .iter()
                .filter(|t| {
                    if t.done || t.reminded {
                        return false;
                    }
                    match t.due {
                        Some(due) => now >= due - (t.remind_before as i64) * 60_000,
                        None => false,
                    }
                })
                .cloned()
                .collect()
        };

        if due_todos.is_empty() {
            continue;
        }

        // 标记为已提醒并持久化，避免重复提醒
        {
            let mut guard = match state.store.lock() {
                Ok(g) => g,
                Err(_) => continue,
            };
            for todo in &due_todos {
                if let Some(t) = guard.todos.iter_mut().find(|x| x.id == todo.id) {
                    t.reminded = true;
                }
            }
        }
        let _ = state.persist();

        // 通知主界面刷新（到期高亮 / 红点）
        let _ = app.emit("todo-due", due_todos.len());

        // 弹出置顶提醒窗口（显示第一条，并告知还有几条）
        let first = due_todos[0].clone();
        let count = due_todos.len();
        let _ = show_reminder(app.clone(), first, count);
    });
}

/// 注册全局快捷键。
/// - toggle：显示 / 隐藏主面板
/// - new_todo：唤出主面板并直接打开「新建待办」
/// 返回注册过程中遇到的错误描述（空列表表示全部成功）。
/// 调用前应先 `unregister_all`，避免重复注册。
pub fn apply_global_shortcuts(
    app: &tauri::AppHandle,
    toggle: &str,
    new_todo: &str,
) -> Vec<String> {
    let mut errors = Vec::new();
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();

    if !toggle.trim().is_empty() {
        if let Err(e) = gs.on_shortcut(toggle, |app, _shortcut, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            if let Some(win) = app.get_webview_window("main") {
                // 最小化窗口在 Windows 上 is_visible() 仍为 true，
                // 直接 hide 会让用户以为快捷键没反应；应先还原。
                let minimized = win.is_minimized().unwrap_or(false);
                let visible = win.is_visible().unwrap_or(false);
                if minimized || !visible {
                    let _ = win.unminimize();
                    let _ = win.show();
                    let _ = win.set_focus();
                } else {
                    let _ = win.hide();
                }
            }
        }) {
            errors.push(format!("主面板快捷键「{toggle}」注册失败：{e}"));
        } else {
            println!("[RainDesk] 快捷键 {toggle} 注册成功（显示/隐藏主面板）");
        }
    }

    if !new_todo.trim().is_empty() {
        if let Err(e) = gs.on_shortcut(new_todo, |app, _shortcut, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
            let _ = app.emit("quick-new-todo", ());
        }) {
            errors.push(format!("新建待办快捷键「{new_todo}」注册失败：{e}"));
        } else {
            println!("[RainDesk] 快捷键 {new_todo} 注册成功（快速新建待办）");
        }
    }

    errors
}

/// 启动时按当前设置注册快捷键
fn register_global_shortcuts(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let (toggle, new_todo) = {
        let state = app
            .try_state::<AppState>()
            .ok_or("AppState 未初始化")?;
        let guard = state.store.lock().map_err(|e| e.to_string())?;
        (
            guard.settings.toggle_shortcut.clone(),
            guard.settings.new_todo_shortcut.clone(),
        )
    };
    for err in apply_global_shortcuts(app, &toggle, &new_todo) {
        eprintln!("[RainDesk] {err}");
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            // 数据目录：由默认目录中的 location.json 指向，未配置时使用默认应用数据目录
            let data_path = config::resolve_data_path(app.handle());
            app.manage(AppState::load(data_path));

            // 启动提醒引擎
            start_reminder_engine(app.handle().clone());

            // 窗口关闭时清理提醒窗口标记（便于下次会话）
            let app_handle = app.handle().clone();
            app.listen("reminder-closed", move |_| {
                commands::REMINDER_WIN_CREATED.store(false, Ordering::SeqCst);
                let _ = hide_reminder(app_handle.clone());
            });

            // 注册全局快捷键：显示/隐藏主面板、快速新建待办
            register_global_shortcuts(app.handle())?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_store,
            commands::save_store,
            commands::get_data_dir,
            commands::get_data_dir_info,
            commands::open_data_dir,
            commands::pick_data_dir,
            commands::set_data_dir,
            commands::launch_shortcut,
            commands::show_reminder,
            commands::hide_reminder,
            commands::complete_todo,
            commands::shortcuts_from_paths,
            commands::get_autostart,
            commands::set_autostart,
            commands::set_shortcuts,
            commands::suspend_shortcuts,
            commands::noop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
