mod autostart;
mod commands;
mod config;
mod icon;
mod models;
mod store;

use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{Emitter, Listener, Manager};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
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
            commands::noop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
