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

/// 个性化设置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// 图标格子大小（像素），范围 44~88
    pub icon_size: u32,
    /// 是否显示快捷方式名称
    pub show_names: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            icon_size: 60,
            show_names: true,
        }
    }
}

/// 应用持久化数据
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Store {
    pub groups: Vec<Group>,
    pub todos: Vec<Todo>,
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
            settings: Settings::default(),
        }
    }
}
