//! RainDesk 插件示例。
//!
//! 任意 Rust crate 都可以按下面的 C ABI 包装成 RainDesk 插件：
//! 在 Cargo.toml 中设置 crate-type = ["cdylib"]，导出 info / invoke / free 三个函数，
//! 可选导出 init / shutdown。返回给宿主的 C 字符串必须用 CString::into_raw，
//! 并实现 raindesk_plugin_free 让宿主释放。

use std::ffi::{CStr, CString, c_char};
use std::panic::{self, AssertUnwindSafe};

use serde_json::{json, Value};

const API_VERSION: u32 = 1;

/// 插件元数据（JSON 字符串）
#[no_mangle]
pub extern "C" fn raindesk_plugin_info() -> *mut c_char {
    let manifest = json!({
        "id": "raindesk-demo-plugin",
        "name": "示例插件",
        "version": "1.0.0",
        "description": "演示 Rust 动态库插件：问候、回显参数、获取时间。可照此模板改造开源 Rust crate。",
        "author": "RainDesk",
        "icon": "🧩",
        "apiVersion": API_VERSION,
        "actions": [
            { "id": "hello", "name": "打个招呼", "description": "返回一条问候语" },
            { "id": "echo", "name": "回显参数", "description": "把传入的 JSON 参数原样返回" },
            { "id": "now", "name": "当前时间戳", "description": "返回 Unix 毫秒时间戳" }
        ]
    });
    to_raw(manifest)
}

/// 可选初始化：ctx 是宿主传入的 JSON 字符串（apiVersion、dataDir）
#[no_mangle]
pub extern "C" fn raindesk_plugin_init(ctx: *const c_char) -> i32 {
    if !ctx.is_null() {
        let text = unsafe { CStr::from_ptr(ctx) }.to_string_lossy().into_owned();
        let _: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    }
    0
}

/// 调用动作。args 为 JSON 字符串；返回值也是 JSON 字符串。
#[no_mangle]
pub extern "C" fn raindesk_plugin_invoke(
    action: *const c_char,
    args: *const c_char,
) -> *mut c_char {
    // 先把 C 字符串转换成 Rust 字符串，避免 panic 跨越 FFI 边界
    let action = if action.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(action) }.to_string_lossy().into_owned()
    };
    let args_text = if args.is_null() {
        "{}".to_string()
    } else {
        unsafe { CStr::from_ptr(args) }.to_string_lossy().into_owned()
    };

    let result = panic::catch_unwind(AssertUnwindSafe(|| {
        let parsed: Value = serde_json::from_str(&args_text).unwrap_or(Value::Null);
        match action.as_str() {
            "hello" => json!({
                "ok": true,
                "message": "你好，来自 Rust 插件的问候 👋",
                "from": "raindesk-demo-plugin"
            }),
            "echo" => json!({ "ok": true, "args": parsed }),
            "now" => json!({
                "ok": true,
                "timestampMs": std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0)
            }),
            _ => json!({ "ok": false, "error": format!("未知动作: {action}") }),
        }
    }))
    .unwrap_or_else(|_| json!({ "ok": false, "error": "插件内部发生 panic" }));

    to_raw(result)
}

/// 释放由本插件返回的字符串（宿主一定会调用）
#[no_mangle]
pub unsafe extern "C" fn raindesk_plugin_free(ptr: *mut c_char) {
    if !ptr.is_null() {
        drop(CString::from_raw(ptr));
    }
}

/// 可选：宿主卸载前调用，用于清理后台线程等资源
#[no_mangle]
pub extern "C" fn raindesk_plugin_shutdown() {}

fn to_raw(value: Value) -> *mut c_char {
    let text = value.to_string();
    CString::new(text)
        .unwrap_or_else(|_| CString::new(r#"{"ok":false,"error":"包含 NUL 字符"}"#).unwrap())
        .into_raw()
}
