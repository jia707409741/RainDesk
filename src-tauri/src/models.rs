use serde::{Deserialize, Serialize};

/// 一个快捷方式（启动项／URL／文件夹／命令）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shortcut {
    pub id: String,
    pub name: String,
    /// 目标：可执行文件路径、URL、文件夹路径或命令
    pub target: String,
    /// 类型：app | url | folder | command
    pub kind: String,
    /// 展示用的 emoji 图标（当 iconData 为空时使用）
    pub icon: String,
    /// 主题色标识（对应前端 CSS 类）：blue/green/purple/orange/pink/cyan
    pub color: String,
    /// 真实文件图标（PNG 的 data URL，可选；拖入文件时从系统提取）
    #[serde(default)]
    pub icon_data: Option<String>,
}

/// 分组
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub shortcuts: Vec<Shortcut>,
}

/// 待办事项
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub id: String,
    pub title: String,
    pub note: String,
    /// 截止时间（Unix 毫秒时间戳），None 表示无截止时间
    pub due: Option<i64>,
    /// 提前提醒分钟数
    pub remind_before: i32,
    /// 优先级：low | medium | high | urgent（旧数据缺省为 medium）
    #[serde(default = "default_priority")]
    pub priority: String,
    pub done: bool,
    /// 是否已经弹窗提醒过，避免重复提醒
    pub reminded: bool,
    pub created_at: i64,
}

/// 备忘录
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Memo {
    pub id: String,
    pub title: String,
    pub content: String,
    /// 是否置顶（旧数据缺省为 false）
    #[serde(default)]
    pub pinned: bool,
    pub created_at: i64,
    /// 最后修改时间（旧数据缺省为创建时间）
    #[serde(default)]
    pub updated_at: i64,
}

/// 个性化设置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// 图标格子大小（像素），范围 44~88
    pub icon_size: u32,
    /// 是否显示快捷方式名称
    pub show_names: bool,
    /// 界面主题：dark（夜间）| light（日间），旧数据缺省为 dark
    #[serde(default = "default_theme")]
    pub theme: String,
    /// 显示 / 隐藏主面板的全局快捷键，空字符串表示未设置
    #[serde(default = "default_toggle_shortcut")]
    pub toggle_shortcut: String,
    /// 快速新建待办的全局快捷键
    #[serde(default = "default_new_todo_shortcut")]
    pub new_todo_shortcut: String,
    /// 备忘录展示方式：card（卡片）| list（列表），旧数据缺省为 card
    #[serde(default = "default_memo_view")]
    pub memo_view: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            icon_size: 60,
            show_names: true,
            theme: default_theme(),
            toggle_shortcut: default_toggle_shortcut(),
            new_todo_shortcut: default_new_todo_shortcut(),
            memo_view: default_memo_view(),
        }
    }
}

fn default_theme() -> String {
    "dark".into()
}

fn default_toggle_shortcut() -> String {
    "Ctrl+Shift+R".into()
}

fn default_new_todo_shortcut() -> String {
    "Ctrl+Shift+T".into()
}

fn default_memo_view() -> String {
    "card".into()
}

/// 应用持久化数据
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Store {
    pub groups: Vec<Group>,
    pub todos: Vec<Todo>,
    /// 备忘录（旧数据没有该字段时为空列表）
    #[serde(default)]
    pub memos: Vec<Memo>,
    #[serde(default)]
    pub settings: Settings,
}

fn default_priority() -> String {
    "medium".into()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl Default for Store {
    fn default() -> Self {
        let t = now_ms();
        Store {
            groups: vec![
                Group {
                    id: "g-work".into(),
                    name: "工作效率".into(),
                    icon: "💼".into(),
                    shortcuts: vec![
                        Shortcut {
                            id: "s1".into(),
                            name: "文件资源管理器".into(),
                            target: "explorer.exe".into(),
                            kind: "app".into(),
                            icon: "📁".into(),
                            color: "blue".into(),
                            icon_data: None,
                        },
                        Shortcut {
                            id: "s2".into(),
                            name: "记事本".into(),
                            target: "notepad.exe".into(),
                            kind: "app".into(),
                            icon: "📝".into(),
                            color: "green".into(),
                            icon_data: None,
                        },
                    ],
                },
                Group {
                    id: "g-web".into(),
                    name: "常用网站".into(),
                    icon: "🌐".into(),
                    shortcuts: vec![
                        Shortcut {
                            id: "s3".into(),
                            name: "Bing 搜索".into(),
                            target: "https://www.bing.com".into(),
                            kind: "url".into(),
                            icon: "🔍".into(),
                            color: "cyan".into(),
                            icon_data: None,
                        },
                    ],
                },
            ],
            todos: vec![
                Todo {
                    id: "t1".into(),
                    title: "欢迎使用 RainDesk 👋".into(),
                    note: "在「快捷方式」页管理分组图标，在「待办事项」页添加带截止时间的任务。".into(),
                    due: None,
                    remind_before: 0,
                    priority: default_priority(),
                    done: false,
                    reminded: false,
                    created_at: t,
                },
            ],
            memos: vec![Memo {
                id: "m1".into(),
                title: "欢迎使用备忘录".into(),
                content: "在「备忘录」里记录临时想法、长文字或参考资料。\n\n• 点击图钉可以置顶，置顶项会排在最前面\n• 右上角可切换卡片 / 列表展示\n• 支持导出为 Markdown 文件".into(),
                pinned: true,
                created_at: t,
                updated_at: t,
            }],
            settings: Settings::default(),
        }
    }
}
