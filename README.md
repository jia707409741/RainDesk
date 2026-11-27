# RainDesk

RainDesk 是一个 Windows 桌面效率小工具，把**分组快捷启动器**、**待办提醒**和**备忘录**集中放在一个常驻托盘的小面板里。它基于 Tauri 2 + 原生前端（HTML / CSS / JavaScript）构建，体积小、启动快，数据全部保存在本地。

当前版本：**v0.1.5**

## 功能介绍

### 快捷方式
- 按分组管理常用入口，支持新建分组、编辑分组名称和 emoji 图标。
- 支持添加**应用程序、网址、文件夹、命令**四类快捷方式，可自定义名称、图标和颜色。
- 图标可拖动排序、跨分组移动，也可以直接从系统里把文件拖进面板添加。
- 点击即可启动对应目标。

### 待办事项
- 新建待办时支持标题、备注、截止时间、优先级（低 / 中 / 高 / 加急）和提前提醒时间。
- 后台提醒引擎每 10 秒检查一次，到点弹出置顶提醒窗口，避免错过重要事项。
- 支持按「全部 / 进行中 / 已完成」筛选，勾选后可批量办结、编辑或删除，也能查看待办详情。
- 侧边栏待办入口带有未完成数量角标。

### 备忘录
- 在待办事项下方新增的独立页面，用于记录灵感和长文本（标题最多 40 字，内容最多 5000 字）。
- 支持**卡片 / 列表**两种展示方式，切换后会被记住。
- 支持图钉**置顶**，置顶项排在最前并有明显标识。
- 支持**搜索**：默认同时匹配标题和正文，也可用 `标题:关键词` / `内容:关键词`（或 `title:` / `content:`）限定范围；命中词会高亮，右侧显示结果计数，可一键清空。
- 支持单条导出和全部导出，通过系统保存对话框写成 Markdown 文件。

### 插件中心
- 侧边栏「备忘录」下方新增插件中心，**运行时加载 Rust 编译的动态库**（Windows `.dll`、Linux `.so`、macOS `.dylib`），新增插件无需重新编译 RainDesk。
- 自动扫描数据目录下的 `plugins/`，展示插件名称、版本、作者、说明、加载状态与声明的动作；支持**安装**（选择 dll 复制进插件目录）、**刷新**、**打开目录**和**移除**（移到 `.trash`，可恢复）。
- 支持**启用 / 停用**插件（状态持久化在 `store.json`），停用时动作按钮自动置灰。
- 每个动作可传入 JSON 参数并在页面底部查看格式化后的返回结果；内置示例插件演示 `hello` / `echo` / `now`。
- 插件接口为稳定的 C ABI：`raindesk_plugin_info`、`raindesk_plugin_invoke`、`raindesk_plugin_free`，可选 `raindesk_plugin_init`、`raindesk_plugin_shutdown`；`apiVersion` 需为 `1`。示例工程在 `examples/raindesk-demo-plugin/`，可把任意开源 Rust crate 包装后导出这些符号。
- 动态库与宿主共享进程，请只安装可信来源的插件；插件内部 panic 需用 `catch_unwind` 自行兜住。

### 其他特性
- **单实例启动**：重复双击桌面图标不会开出多个进程或托盘图标，而是把已有窗口唤醒到前台。
- **系统托盘常驻**：左键显示 / 隐藏主面板，右键菜单可显示或真正退出；点窗口关闭按钮只是隐藏，不退出程序。
- **全局快捷键**（可在设置里修改）：默认 `Ctrl + Shift + R` 显示 / 隐藏面板，`Ctrl + Shift + T` 唤出面板并直接新建待办。
- **外观个性化**：日间 / 夜间主题切换，图标大小调节，是否显示图标名称。
- **开机自启**：可在设置中开启登录 Windows 后自动运行。
- **数据目录可自定义**：默认使用应用数据目录，通过 `location.json` 指向实际数据文件，也可以在设置里更换；侧边栏「数据目录」按钮可直接打开。

## 技术栈

- 桌面框架：Tauri 2（Rust 后端 + WebView 前端）
- 前端：原生 HTML / CSS / JavaScript，无前端构建步骤
- 主要插件：single-instance、notification、dialog、global-shortcut
- 数据存储：本地 JSON 文件（`store.json`），结构带默认值，兼容旧版本数据

## 目录结构

```text
RainDesk/
├── frontend/              # 前端页面、样式、脚本与内置图标
│   ├── index.html
│   ├── styles.css
│   ├── app.js
│   └── vendor/            # Tauri API 的本地封装
├── src-tauri/             # Rust 后端
│   ├── src/
│   │   ├── lib.rs         # 应用入口、托盘、快捷键、单实例与提醒引擎
│   │   ├── commands.rs    # 前端可调用的命令
│   │   ├── models.rs      # 数据结构（分组、待办、备忘录、设置）
│   │   ├── store.rs       # 数据加载与持久化
│   │   ├── config.rs      # 数据目录解析
│   │   ├── icon.rs        # 图标处理
│   │   └── autostart.rs   # 开机自启
│   ├── capabilities/      # Tauri 权限配置
│   ├── icons/             # 应用图标
│   ├── tauri.conf.json
│   └── Cargo.toml
├── examples/
│   └── raindesk-demo-plugin/    # Rust 动态库插件示例
└── package.json
```

## 本地开发与构建

需要 Node.js 和 Rust 工具链（Tauri 2 的 Windows 环境还需要 WebView2 Runtime）。

```bash
# 开发模式（会连接 http://localhost:1420）
npm run tauri dev

# 构建发布版（安装包、exe、资源嵌入）
npm run tauri build
```

> 注意：发布版必须用 `npm run tauri build`，不要用 `cargo build --release`。后者缺少 `custom-protocol` 特性，Tauri 会按开发模式处理，不嵌入前端资源，运行时会去连 `localhost:1420` 并出现「无法访问此页面」。

构建产物位于 `src-tauri/target/release/`，安装包在 `src-tauri/target/release/bundle/nsis/`。项目根目录的 `RainDesk_0.1.5_x64-setup.exe`（安装包）、`RainDesk_0.1.5_x64-portable.zip`（便携包）和 `RainDesk.exe`（独立 exe）是同步好的发布产物。

编译示例插件：

```bash
cargo build --release --manifest-path examples/raindesk-demo-plugin/Cargo.toml
```

把生成的 `examples/raindesk-demo-plugin/target/release/raindesk_demo_plugin.dll` 放进插件目录（或在插件中心点「安装插件」选择它）。插件接口与适配方法见 `examples/raindesk-demo-plugin/README.md`。

## 许可

MIT
