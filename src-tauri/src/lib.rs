mod autostart;
mod commands;
mod config;
mod icon;
mod models;
mod plugin;
mod store;

use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::menu::MenuBuilder;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
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

/// 还原主面板并置于前台（托盘、快捷键与二次启动时共用）。
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// 显示 / 隐藏主面板（托盘与全局快捷键共用）。
/// 最小化状态下优先还原，避免用户误以为快捷键失效。
fn toggle_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let minimized = win.is_minimized().unwrap_or(false);
        let visible = win.is_visible().unwrap_or(false);
        if minimized || !visible {
            show_main_window(app);
        } else {
            let _ = win.hide();
        }
    }
}

/// 创建系统托盘图标：左键显示/隐藏主面板，右键菜单可显示/隐藏或退出。
fn setup_tray(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let menu = MenuBuilder::new(app)
        .text("tray-show", "显示 / 隐藏主面板")
        .separator()
        .text("tray-quit", "退出 RainDesk")
        .build()?;

    let tray = TrayIconBuilder::with_id("raindesk-main")
        .icon(tauri::image::Image::from_bytes(include_bytes!(
            "../icons/icon.png"
        ))?)
        .tooltip("RainDesk - 待办与快捷启动器")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-show" => toggle_main_window(app),
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    // TrayIcon 是引用计数类型，最后一个实例被 drop 时图标会移除，
    // 放进 managed state 使其随应用一直存活。
    app.manage(tray);
    Ok(())
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
            toggle_main_window(app);
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
            show_main_window(app);
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
        // 单实例：第二次双击时直接把已运行实例的主面板唤醒到前台，
        // 不再创建第二个进程，也就不会重复注册系统托盘图标。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            // 数据目录：由默认目录中的 location.json 指向，未配置时使用默认应用数据目录
            let data_path = config::resolve_data_path(app.handle());
            app.manage(AppState::load(data_path));

            // 插件中心：扫描数据目录下的 plugins 并加载 Rust 动态库
            let plugin_manager = plugin::PluginManager::default();
            plugin_manager.reload(app.handle());
            app.manage(plugin_manager);

            // 启动提醒引擎
            start_reminder_engine(app.handle().clone());

            // 窗口关闭时清理提醒窗口标记（便于下次会话）
            let app_handle = app.handle().clone();
            app.listen("reminder-closed", move |_| {
                commands::REMINDER_WIN_CREATED.store(false, Ordering::SeqCst);
                let _ = hide_reminder(app_handle.clone());
            });

            // 主面板点叉号/Alt+F4 时只隐藏窗口，进程继续常驻；
            // 真正的退出走系统托盘右键菜单。
            if let Some(main_win) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                main_win.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        if let Some(win) = handle.get_webview_window("main") {
                            let _ = win.hide();
                        }
                    }
                });
            }

            // 系统托盘图标（左键显示/隐藏，右键菜单退出）
            setup_tray(app.handle())?;

            // 注册全局快捷键：显示/隐藏主面板、快速新建待办
            register_global_shortcuts(app.handle())?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_store,
            commands::save_store,
            commands::export_memos,
            plugin::list_plugins,
            plugin::set_plugin_enabled,
            plugin::invoke_plugin,
            plugin::install_plugin,
            plugin::remove_plugin,
            plugin::open_plugins_dir,
            plugin::get_plugin_dir,
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
