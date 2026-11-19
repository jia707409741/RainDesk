//! 从文件系统路径提取真实图标，编码为 PNG data URL。
//! 使用 Windows Shell/GDI API，PNG 与 base64 均为手写实现，零第三方依赖。

#[cfg(windows)]
mod win {
    use std::ffi::c_void;

    #[repr(C)]
    pub struct ShFileInfoW {
        pub h_icon: isize,
        pub i_icon: i32,
        pub dw_attributes: u32,
        pub sz_display_name: [u16; 260],
        pub sz_type_name: [u16; 80],
    }

    impl Default for ShFileInfoW {
        fn default() -> Self {
            Self {
                h_icon: 0,
                i_icon: 0,
                dw_attributes: 0,
                sz_display_name: [0; 260],
                sz_type_name: [0; 80],
            }
        }
    }

    #[repr(C)]
    #[derive(Default)]
    pub struct IconInfo {
        pub f_icon: i32,
        pub x_hotspot: u32,
        pub y_hotspot: u32,
        pub hbm_mask: isize,
        pub hbm_color: isize,
    }

    #[repr(C)]
    #[derive(Default)]
    pub struct Bitmap {
        pub bm_type: i32,
        pub bm_width: i32,
        pub bm_height: i32,
        pub bm_width_bytes: i32,
        pub bm_planes: u16,
        pub bm_bits_pixel: u16,
        pub bm_bits: *mut c_void,
    }

    #[repr(C)]
    #[derive(Default)]
    pub struct BitmapInfoHeader {
        pub bi_size: u32,
        pub bi_width: i32,
        pub bi_height: i32,
        pub bi_planes: u16,
        pub bi_bit_count: u16,
        pub bi_compression: u32,
        pub bi_size_image: u32,
        pub bi_x_pels_per_meter: i32,
        pub bi_y_pels_per_meter: i32,
        pub bi_clr_used: u32,
        pub bi_clr_important: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    pub struct BitmapInfo {
        pub header: BitmapInfoHeader,
        // 32bpp 不需要调色板，但结构至少留一个表项
        pub colors: [u8; 4],
    }

    const SHGFI_ICON: u32 = 0x000000100;
    const SHGFI_LARGEICON: u32 = 0x000000000;

    #[link(name = "shell32")]
    extern "system" {
        #[link_name = "SHGetFileInfoW"]
        pub fn sh_get_file_info_w(
            path: *const u16,
            attrs: u32,
            shfi: *mut ShFileInfoW,
            size: u32,
            flags: u32,
        ) -> isize;
    }

    #[link(name = "user32")]
    extern "system" {
        #[link_name = "GetIconInfo"]
        pub fn get_icon_info(icon: isize, info: *mut IconInfo) -> i32;
        #[link_name = "DestroyIcon"]
        pub fn destroy_icon(icon: isize) -> i32;
    }

    #[link(name = "gdi32")]
    extern "system" {
        #[link_name = "GetObjectW"]
        pub fn get_object_w(obj: isize, size: i32, out: *mut c_void) -> i32;
        #[link_name = "CreateCompatibleDC"]
        pub fn create_compatible_dc(hdc: isize) -> isize;
        #[link_name = "DeleteDC"]
        pub fn delete_dc(hdc: isize) -> i32;
        #[link_name = "DeleteObject"]
        pub fn delete_object(obj: isize) -> i32;
        #[link_name = "GetDIBits"]
        pub fn get_di_bits(
            hdc: isize,
            hbmp: isize,
            start: u32,
            count: u32,
            bits: *mut c_void,
            info: *mut BitmapInfo,
            usage: u32,
        ) -> i32;
    }

    /// 提取路径图标的 32x32 RGBA 像素，成功返回 (宽, 高, rgba)。
    pub unsafe fn extract_rgba(path: &str) -> Option<(usize, usize, Vec<u8>)> {
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let mut shfi = ShFileInfoW::default();
        let size = std::mem::size_of::<ShFileInfoW>() as u32;
        let ret = sh_get_file_info_w(
            wide.as_ptr(),
            0,
            &mut shfi,
            size,
            SHGFI_ICON | SHGFI_LARGEICON,
        );
        if ret == 0 || shfi.h_icon == 0 {
            return None;
        }
        let hicon = shfi.h_icon;

        let mut ii = IconInfo::default();
        if get_icon_info(hicon, &mut ii) == 0 {
            destroy_icon(hicon);
            return None;
        }
        // 单色图标没有 hbmColor，退回用 mask 也无法得到彩色，直接放弃
        if ii.hbm_color == 0 {
            if ii.hbm_mask != 0 { delete_object(ii.hbm_mask); }
            destroy_icon(hicon);
            return None;
        }

        let mut bm = Bitmap::default();
        let bm_size = std::mem::size_of::<Bitmap>() as i32;
        if get_object_w(ii.hbm_color, bm_size, &mut bm as *mut _ as *mut c_void) == 0
            || bm.bm_width <= 0
            || bm.bm_height <= 0
        {
            if ii.hbm_mask != 0 { delete_object(ii.hbm_mask); }
            delete_object(ii.hbm_color);
            destroy_icon(hicon);
            return None;
        }
        let w = bm.bm_width as usize;
        let h = bm.bm_height as usize;

        let hdc = create_compatible_dc(0);
        if hdc == 0 {
            if ii.hbm_mask != 0 { delete_object(ii.hbm_mask); }
            delete_object(ii.hbm_color);
            destroy_icon(hicon);
            return None;
        }

        let mut bmi = BitmapInfo::default();
        bmi.header.bi_size = std::mem::size_of::<BitmapInfoHeader>() as u32;
        bmi.header.bi_width = w as i32;
        // 正数高度 = 自下而上的 DIB
        bmi.header.bi_height = h as i32;
        bmi.header.bi_planes = 1;
        bmi.header.bi_bit_count = 32;
        bmi.header.bi_compression = 0; // BI_RGB

        let buf_len = w * h * 4;
        let mut buf = vec![0u8; buf_len];
        let lines = get_di_bits(
            hdc,
            ii.hbm_color,
            0,
            h as u32,
            buf.as_mut_ptr() as *mut c_void,
            &mut bmi,
            0,
        );

        delete_dc(hdc);
        if ii.hbm_mask != 0 { delete_object(ii.hbm_mask); }
        delete_object(ii.hbm_color);
        destroy_icon(hicon);

        if lines == 0 {
            return None;
        }

        // BGRA (bottom-up) -> RGBA (top-down)
        let mut rgba = vec![0u8; buf_len];
        let mut any_alpha = false;
        for y in 0..h {
            let src_row = (h - 1 - y) * w * 4;
            let dst_row = y * w * 4;
            for x in 0..w {
                let s = src_row + x * 4;
                let d = dst_row + x * 4;
                let a = buf[s + 3];
                if a != 0 { any_alpha = true; }
                rgba[d] = buf[s + 2];
                rgba[d + 1] = buf[s + 1];
                rgba[d + 2] = buf[s];
                rgba[d + 3] = a;
            }
        }
        // 某些图标 GetDIBits 不带有效 alpha，兜底设为不透明，避免全部透明看不见
        if !any_alpha {
            for px in rgba.chunks_exact_mut(4) {
                px[3] = 255;
            }
        }
        Some((w, h, rgba))
    }
}

// ---------- 手写 PNG 编码 ----------

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

fn adler32(data: &[u8]) -> u32 {
    let mut a = 1u32;
    let mut b = 0u32;
    for &x in data {
        a = (a + x as u32) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}

fn push_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let mut chunk = Vec::with_capacity(4 + data.len());
    chunk.extend_from_slice(kind);
    chunk.extend_from_slice(data);
    out.extend_from_slice(&chunk);
    out.extend_from_slice(&crc32(&chunk).to_be_bytes());
}

/// 用 zlib "stored block"（无压缩）封装，避免引入 flate2
fn zlib_stored(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.push(0x78); // zlib header (CM=8, CINFO=7)
    out.push(0x01); // FLG: no compression / fastest
    if data.is_empty() {
        out.push(1);
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0xFFFFu16.to_le_bytes());
    } else {
        let mut pos = 0usize;
        while pos < data.len() {
            let len = (data.len() - pos).min(65535);
            let final_flag = if pos + len >= data.len() { 1u8 } else { 0u8 };
            out.push(final_flag); // BFINAL, BTYPE=00 (stored)
            out.extend_from_slice(&(len as u16).to_le_bytes());
            out.extend_from_slice(&(!(len as u16)).to_le_bytes());
            out.extend_from_slice(&data[pos..pos + len]);
            pos += len;
        }
    }
    out.extend_from_slice(&adler32(data).to_be_bytes());
    out
}

fn encode_png(w: usize, h: usize, rgba: &[u8]) -> Vec<u8> {
    // 每行加一个 filter byte = 0 (None)
    let mut raw = Vec::with_capacity((w * 4 + 1) * h);
    for y in 0..h {
        raw.push(0);
        let start = y * w * 4;
        raw.extend_from_slice(&rgba[start..start + w * 4]);
    }
    let mut png = Vec::new();
    png.extend_from_slice(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&(w as u32).to_be_bytes());
    ihdr.extend_from_slice(&(h as u32).to_be_bytes());
    ihdr.push(8); // bit depth
    ihdr.push(6); // color type: RGBA
    ihdr.push(0); // compression
    ihdr.push(0); // filter
    ihdr.push(0); // interlace
    push_chunk(&mut png, b"IHDR", &ihdr);
    push_chunk(&mut png, b"IDAT", &zlib_stored(&raw));
    push_chunk(&mut png, b"IEND", &[]);
    png
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64(data: &[u8]) -> String {
    let mut s = String::with_capacity((data.len() + 2) / 3 * 4);
    let mut i = 0usize;
    while i + 3 <= data.len() {
        let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8) | (data[i + 2] as u32);
        s.push(B64[((n >> 18) & 63) as usize] as char);
        s.push(B64[((n >> 12) & 63) as usize] as char);
        s.push(B64[((n >> 6) & 63) as usize] as char);
        s.push(B64[(n & 63) as usize] as char);
        i += 3;
    }
    let rem = data.len() - i;
    if rem == 1 {
        let n = (data[i] as u32) << 16;
        s.push(B64[((n >> 18) & 63) as usize] as char);
        s.push(B64[((n >> 12) & 63) as usize] as char);
        s.push('=');
        s.push('=');
    } else if rem == 2 {
        let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8);
        s.push(B64[((n >> 18) & 63) as usize] as char);
        s.push(B64[((n >> 12) & 63) as usize] as char);
        s.push(B64[((n >> 6) & 63) as usize] as char);
        s.push('=');
    }
    s
}

/// 对外接口：文件路径 -> PNG data URL
pub fn icon_data_url(path: &str) -> Option<String> {
    #[cfg(windows)]
    {
        let (w, h, rgba) = unsafe { win::extract_rgba(path)? };
        let png = encode_png(w, h, &rgba);
        Some(format!("data:image/png;base64,{}", base64(&png)))
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        None
    }
}
