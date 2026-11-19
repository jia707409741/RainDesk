//! 开机自启动：通过注册表 HKCU\Software\Microsoft\Windows\CurrentVersion\Run 实现。
//! 手写 Win32 API 声明，零第三方依赖。

const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const APP_NAME: &str = "RainDesk";

#[cfg(windows)]
mod reg {
    const HKEY_CURRENT_USER: isize = 0x8000_0001isize;
    const KEY_QUERY_VALUE: u32 = 0x0001;
    const KEY_SET_VALUE: u32 = 0x0002;
    const REG_SZ: u32 = 1;
    const ERROR_SUCCESS: i32 = 0;
    const ERROR_FILE_NOT_FOUND: i32 = 2;

    #[link(name = "advapi32")]
    extern "system" {
        #[link_name = "RegOpenKeyExW"]
        fn reg_open_key_ex(
            key: isize,
            sub_key: *const u16,
            options: u32,
            access: u32,
            result: *mut isize,
        ) -> i32;
        #[link_name = "RegCloseKey"]
        fn reg_close_key(key: isize) -> i32;
        #[link_name = "RegQueryValueExW"]
        fn reg_query_value_ex(
            key: isize,
            value_name: *const u16,
            reserved: *mut u32,
            value_type: *mut u32,
            data: *mut u8,
            data_size: *mut u32,
        ) -> i32;
        #[link_name = "RegSetValueExW"]
        fn reg_set_value_ex(
            key: isize,
            value_name: *const u16,
            reserved: u32,
            value_type: u32,
            data: *const u8,
            data_size: u32,
        ) -> i32;
        #[link_name = "RegDeleteValueW"]
        fn reg_delete_value(key: isize, value_name: *const u16) -> i32;
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// 查询 HKCU\Run 下指定值是否存在且非空。
    pub fn query(app_name: &str) -> Result<bool, String> {
        let sub = wide(super::RUN_KEY);
        let name = wide(app_name);
        let mut key: isize = 0;
        let ret = unsafe {
            reg_open_key_ex(
                HKEY_CURRENT_USER,
                sub.as_ptr(),
                0,
                KEY_QUERY_VALUE,
                &mut key,
            )
        };
        if ret != ERROR_SUCCESS {
            return Ok(false); // 键不存在 = 未启用
        }
        let mut value_type = 0u32;
        let mut size = 0u32;
        let q = unsafe {
            reg_query_value_ex(
                key,
                name.as_ptr(),
                std::ptr::null_mut(),
                &mut value_type,
                std::ptr::null_mut(),
                &mut size,
            )
        };
        unsafe { reg_close_key(key) };
        match q {
            ERROR_SUCCESS => Ok(size > 0),
            ERROR_FILE_NOT_FOUND => Ok(false),
            _ => Err(format!("查询注册表失败（代码 {}）", q)),
        }
    }

    /// 写入自启动项；command 为带引号的 exe 路径。
    pub fn set(app_name: &str, command: &str) -> Result<(), String> {
        let sub = wide(super::RUN_KEY);
        let name = wide(app_name);
        let mut key: isize = 0;
        let ret = unsafe {
            reg_open_key_ex(
                HKEY_CURRENT_USER,
                sub.as_ptr(),
                0,
                KEY_SET_VALUE,
                &mut key,
            )
        };
        if ret != ERROR_SUCCESS {
            return Err(format!("打开注册表失败（代码 {}）", ret));
        }
        // REG_SZ 需要以 NUL 结尾的 UTF-16 字节
        let mut data = wide(command);
        let byte_len = data.len() * 2;
        let s = unsafe {
            reg_set_value_ex(
                key,
                name.as_ptr(),
                0,
                REG_SZ,
                data.as_mut_ptr() as *const u8,
                byte_len as u32,
            )
        };
        unsafe { reg_close_key(key) };
        if s != ERROR_SUCCESS {
            return Err(format!("写入注册表失败（代码 {}）", s));
        }
        Ok(())
    }

    /// 删除自启动项。
    pub fn remove(app_name: &str) -> Result<(), String> {
        let sub = wide(super::RUN_KEY);
        let name = wide(app_name);
        let mut key: isize = 0;
        let ret = unsafe {
            reg_open_key_ex(
                HKEY_CURRENT_USER,
                sub.as_ptr(),
                0,
                KEY_SET_VALUE,
                &mut key,
            )
        };
        if ret != ERROR_SUCCESS {
            return Ok(()); // 键不存在，本来就未启用
        }
        let d = unsafe { reg_delete_value(key, name.as_ptr()) };
        unsafe { reg_close_key(key) };
        if d == ERROR_SUCCESS || d == ERROR_FILE_NOT_FOUND {
            Ok(())
        } else {
            Err(format!("删除自启动项失败（代码 {}）", d))
        }
    }
}

/// 当前是否已启用开机自启动
pub fn is_enabled() -> Result<bool, String> {
    #[cfg(windows)]
    {
        reg::query(APP_NAME)
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

/// 设置开机自启动开关
pub fn set_enabled(enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        if enabled {
            let exe = std::env::current_exe()
                .map_err(|e| format!("获取程序路径失败: {e}"))?;
            let path = exe.to_string_lossy().to_string();
            // 路径含空格时用引号包裹，避免注册表解析错误
            let command = if path.contains(' ') {
                format!("\"{}\"", path)
            } else {
                path
            };
            reg::set(APP_NAME, &command)
        } else {
            reg::remove(APP_NAME)
        }
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Ok(())
    }
}
