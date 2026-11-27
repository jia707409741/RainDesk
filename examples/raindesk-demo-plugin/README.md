# RainDesk 示例插件（Rust）

演示如何用 Rust 编写一个可被 RainDesk 插件中心运行时加载的动态库插件。

## 编译

在项目根目录执行：

```bash
cargo build --release --manifest-path examples/raindesk-demo-plugin/Cargo.toml
```

产物在：

```text
examples/raindesk-demo-plugin/target/release/raindesk_demo_plugin.dll
```

Windows 下是 `.dll`，Linux 下是 `.so`，macOS 下是 `.dylib`。

## 安装

两种方式：

1. 在 RainDesk「插件中心」点「安装插件」，选择上面编译出的 dll。
2. 手动把 dll 复制到插件目录（设置 → 数据目录 → `plugins/` 子目录；侧边栏也有「插件中心 → 打开插件目录」按钮），然后点「刷新」。

安装后可以在插件卡片上启用/停用，并调用 `hello`、`echo`、`now` 三个动作查看返回内容。

## 插件接口约定（C ABI）

插件需要导出以下符号，名称固定：

| 符号 | 签名 | 说明 |
| --- | --- | --- |
| `raindesk_plugin_info` | `extern "C" fn() -> *mut c_char` | 返回元数据 JSON 字符串 |
| `raindesk_plugin_invoke` | `extern "C" fn(action: *const c_char, args: *const c_char) -> *mut c_char` | 调用动作，返回 JSON/文本 |
| `raindesk_plugin_free` | `extern "C" fn(ptr: *mut c_char)` | 释放上面两个函数返回的字符串 |
| `raindesk_plugin_init` | `extern "C" fn(ctx: *const c_char) -> i32` | 可选，初始化，0 表示成功 |
| `raindesk_plugin_shutdown` | `extern "C" fn()` | 可选，卸载前清理 |

元数据 JSON 示例：

```json
{
  "id": "raindesk-demo-plugin",
  "name": "示例插件",
  "version": "1.0.0",
  "description": "插件说明",
  "author": "RainDesk",
  "icon": "🧩",
  "apiVersion": 1,
  "actions": [
    { "id": "hello", "name": "打个招呼", "description": "返回一条问候语" }
  ]
}
```

`apiVersion` 必须为 `1`。`actions` 决定插件中心里可点击的动作；点击时 `args` 默认为 `{}`，由前端输入框传入 JSON。

### 内存规则

- 返回给宿主的 C 字符串必须用 `CString::into_raw()` 分配，插件实现 `raindesk_plugin_free` 调用 `CString::from_raw()` 释放。
- 宿主传入的 `action` / `args` / `ctx` 指针由宿主管理，插件**不要**释放。
- Rust panic 不要跨越 FFI 边界，用 `std::panic::catch_unwind` 兜住（示例已演示）。

### 适配开源 Rust 项目

把开源 crate 作为依赖加进插件的 `Cargo.toml`，在 `raindesk_plugin_invoke` 里按 `action` 分发调用它的公开 API，再把结果序列化成 JSON 返回即可。运行时只要目标机器有对应平台的动态库，不需要重新编译 RainDesk。

> 注意：动态库与宿主共享进程，插件崩溃会连带影响 RainDesk；请只安装可信来源的插件。移除插件时动态库会被移到 `plugins/.trash/`，可手动恢复。
