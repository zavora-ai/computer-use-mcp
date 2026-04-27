// ── macOS implementation ──────────────────────────────────────────────────────
#[cfg(target_os = "macos")]
mod macos {
    use base64::Engine;
    use core_foundation::array::CFArrayRef;
    use core_foundation::base::{CFRelease, TCFType};
    use core_foundation::dictionary::CFDictionaryRef;
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;
    use napi_derive::napi;
    use objc::runtime::{Class, Object};
    use objc::{msg_send, sel, sel_impl};
    use std::collections::hash_map::DefaultHasher;
    use std::ffi::CStr;
    use std::fs::OpenOptions;
    use std::hash::{Hash, Hasher};
    use std::process::Command;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SHOT_SEQ: AtomicU32 = AtomicU32::new(0);

    type CGWindowID = u32;
    type RawCFTypeRef = *const std::ffi::c_void;

    extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relativeToWindow: CGWindowID) -> CFArrayRef;
        fn CFArrayGetCount(array: CFArrayRef) -> isize;
        fn CFArrayGetValueAtIndex(array: CFArrayRef, idx: isize) -> RawCFTypeRef;
        fn CFDictionaryGetValue(dict: CFDictionaryRef, key: RawCFTypeRef) -> RawCFTypeRef;
    }

    fn nsstring_to_string(nsstr: *mut Object) -> Option<String> {
        if nsstr.is_null() { return None; }
        unsafe {
            let cstr: *const i8 = msg_send![nsstr, UTF8String];
            if cstr.is_null() { return None; }
            Some(CStr::from_ptr(cstr).to_string_lossy().into_owned())
        }
    }

    fn shared_workspace() -> *mut Object {
        unsafe {
            let cls = Class::get("NSWorkspace").unwrap();
            msg_send![cls, sharedWorkspace]
        }
    }

    fn pid_for_bundle(bundle_id: &str) -> Option<i32> {
        unsafe {
            let ws = shared_workspace();
            let apps: *mut Object = msg_send![ws, runningApplications];
            let count: usize = msg_send![apps, count];
            for i in 0..count {
                let app: *mut Object = msg_send![apps, objectAtIndex: i];
                let bid: *mut Object = msg_send![app, bundleIdentifier];
                if nsstring_to_string(bid).as_deref() == Some(bundle_id) {
                    let pid: i32 = msg_send![app, processIdentifier];
                    return Some(pid);
                }
            }
        }
        None
    }

    unsafe fn dict_get_i64(dict: CFDictionaryRef, key: &str) -> Option<i64> {
        let cf_key = CFString::new(key);
        let val = CFDictionaryGetValue(dict, cf_key.as_concrete_TypeRef() as RawCFTypeRef);
        if val.is_null() { return None; }
        let cf_num: CFNumber = TCFType::wrap_under_get_rule(val as *const _);
        cf_num.to_i64()
    }

    fn window_id_for_bundle(bundle_id: &str) -> Option<u32> {
        let pid = pid_for_bundle(bundle_id)? as i64;
        unsafe {
            let array_ref = CGWindowListCopyWindowInfo(1 << 0, 0);
            if array_ref.is_null() { return None; }
            let count = CFArrayGetCount(array_ref) as usize;
            for i in 0..count {
                let dict = CFArrayGetValueAtIndex(array_ref, i as isize) as CFDictionaryRef;
                if dict_get_i64(dict, "kCGWindowLayer") != Some(0) { continue; }
                if dict_get_i64(dict, "kCGWindowOwnerPID") != Some(pid) { continue; }
                if let Some(wid) = dict_get_i64(dict, "kCGWindowNumber") {
                    CFRelease(array_ref as *const _);
                    return Some(wid as u32);
                }
            }
            CFRelease(array_ref as *const _);
        }
        None
    }

    #[napi]
    pub fn take_screenshot(
        width: Option<u32>,
        target_app: Option<String>,
        quality: Option<u32>,
        previous_hash: Option<String>,
        window_id: Option<u32>,
    ) -> napi::Result<serde_json::Value> {
        let seq = SHOT_SEQ.fetch_add(1, Ordering::Relaxed);
        let tmp = format!("/tmp/cu-{}-{}.jpg", std::process::id(), seq);
        OpenOptions::new().write(true).create_new(true).open(&tmp)
            .map_err(|e| napi::Error::from_reason(format!("temp file: {e}")))?;

        let mut args: Vec<String> = vec!["-x".into(), "-t".into(), "jpg".into()];
        if let Some(wid) = window_id {
            args.push("-l".into()); args.push(wid.to_string());
        } else if let Some(bundle_id) = target_app {
            let wid = window_id_for_bundle(&bundle_id).ok_or_else(|| {
                let _ = std::fs::remove_file(&tmp);
                napi::Error::from_reason(format!("No on-screen window found for target_app: {bundle_id}"))
            })?;
            args.push("-l".into()); args.push(wid.to_string());
        }
        args.push(tmp.clone());

        let status = Command::new("screencapture").args(&args).status()
            .map_err(|e| { let _ = std::fs::remove_file(&tmp); napi::Error::from_reason(format!("screencapture: {e}")) })?;
        if !status.success() {
            let _ = std::fs::remove_file(&tmp);
            return Err(napi::Error::from_reason("screencapture failed"));
        }

        if let Some(w) = width {
            let _ = Command::new("sips").args(["--resampleWidth", &w.to_string(), &tmp]).output();
        }
        let q = quality.unwrap_or(80).clamp(1, 100);
        if q != 85 {
            let _ = Command::new("sips").args(["--setProperty", "formatOptions", &q.to_string(), &tmp]).output();
        }

        let data = std::fs::read(&tmp).map_err(|e| napi::Error::from_reason(format!("read: {e}")))?;
        let _ = std::fs::remove_file(&tmp);

        let (w, h) = jpeg_dimensions(&data).unwrap_or((0, 0));
        let mut hasher = DefaultHasher::new();
        data.hash(&mut hasher);
        let hash = format!("{:016x}", hasher.finish());

        if previous_hash.as_deref() == Some(hash.as_str()) {
            return Ok(serde_json::json!({ "width": w, "height": h, "mimeType": "image/jpeg", "hash": hash, "unchanged": true }));
        }

        let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
        Ok(serde_json::json!({ "base64": b64, "width": w, "height": h, "mimeType": "image/jpeg", "hash": hash, "unchanged": false }))
    }

    fn jpeg_dimensions(data: &[u8]) -> Option<(u32, u32)> {
        let mut i = 0;
        while i + 1 < data.len() {
            if data[i] != 0xFF { i += 1; continue; }
            let marker = data[i + 1];
            if marker == 0xC0 || marker == 0xC2 {
                if i + 9 < data.len() {
                    let h = ((data[i + 5] as u32) << 8) | data[i + 6] as u32;
                    let w = ((data[i + 7] as u32) << 8) | data[i + 8] as u32;
                    return Some((w, h));
                }
            }
            if marker == 0xD8 || marker == 0xD9 || marker == 0x00 { i += 2; }
            else if i + 3 < data.len() {
                let len = ((data[i + 2] as usize) << 8) | data[i + 3] as usize;
                i += 2 + len;
            } else { break; }
        }
        None
    }

    fn encode_png_mac(rgb: &[u8], w: u32, h: u32) -> napi::Result<Vec<u8>> {
        use image::codecs::png::PngEncoder;
        use image::ImageEncoder;
        use std::io::Cursor;
        let estimated = (w * h * 3 / 2) as usize;
        let mut buf = Cursor::new(Vec::with_capacity(estimated));
        let enc = PngEncoder::new(&mut buf);
        enc.write_image(rgb, w, h, image::ExtendedColorType::Rgb8)
            .map_err(|e| napi::Error::from_reason(format!("PNG encode: {e}")))?;
        Ok(buf.into_inner())
    }

    fn encode_jpeg_mac(rgb: &[u8], w: u32, h: u32, quality: u8) -> napi::Result<Vec<u8>> {
        use image::codecs::jpeg::JpegEncoder;
        use std::io::Cursor;
        let estimated = (w * h * 3 / 10) as usize;
        let mut buf = Cursor::new(Vec::with_capacity(estimated));
        let mut enc = JpegEncoder::new_with_quality(&mut buf, quality);
        enc.encode(rgb, w, h, image::ExtendedColorType::Rgb8)
            .map_err(|e| napi::Error::from_reason(format!("JPEG encode: {e}")))?;
        Ok(buf.into_inner())
    }

    /// Draw colored rectangles and grid lines on an image, then re-encode as JPEG.
    #[napi]
    pub fn annotate_image(
        base64_jpeg: String,
        annotations: Option<String>,
        grid_cols: Option<u32>,
        grid_rows: Option<u32>,
        quality: Option<u32>,
    ) -> napi::Result<serde_json::Value> {
        let jpeg_bytes = base64::engine::general_purpose::STANDARD
            .decode(&base64_jpeg)
            .map_err(|e| napi::Error::from_reason(format!("base64 decode: {e}")))?;

        use image::io::Reader as ImageReader;
        use std::io::Cursor;
        let img = ImageReader::new(Cursor::new(&jpeg_bytes))
            .with_guessed_format()
            .map_err(|e| napi::Error::from_reason(format!("image format: {e}")))?
            .decode()
            .map_err(|e| napi::Error::from_reason(format!("image decode: {e}")))?;
        let mut rgb_img = img.to_rgb8();
        let w = rgb_img.width();
        let h = rgb_img.height();

        let colors: [(u8, u8, u8); 8] = [
            (255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0),
            (255, 0, 255), (0, 255, 255), (255, 128, 0), (128, 0, 255),
        ];

        if let Some(ref ann_json) = annotations {
            if let Ok(anns) = serde_json::from_str::<Vec<serde_json::Value>>(ann_json) {
                for (i, ann) in anns.iter().enumerate() {
                    let ax = ann.get("x").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                    let ay = ann.get("y").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                    let aw = ann.get("width").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                    let ah = ann.get("height").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                    let (cr, cg, cb) = colors[i % colors.len()];
                    let thickness = 2i32;
                    for t in 0..thickness {
                        for x in ax.max(0)..(ax + aw).min(w as i32) {
                            for dy in [ay + t, ay + ah - 1 - t] {
                                if dy >= 0 && dy < h as i32 && x >= 0 && x < w as i32 {
                                    rgb_img.put_pixel(x as u32, dy as u32, image::Rgb([cr, cg, cb]));
                                }
                            }
                        }
                        for y in ay.max(0)..(ay + ah).min(h as i32) {
                            for dx in [ax + t, ax + aw - 1 - t] {
                                if dx >= 0 && dx < w as i32 && y >= 0 && y < h as i32 {
                                    rgb_img.put_pixel(dx as u32, y as u32, image::Rgb([cr, cg, cb]));
                                }
                            }
                        }
                    }
                }
            }
        }

        if let (Some(cols), Some(rows)) = (grid_cols, grid_rows) {
            let gray = image::Rgb([128u8, 128, 128]);
            if cols > 0 {
                for i in 1..cols {
                    let x = (w as u64 * i as u64 / cols as u64) as u32;
                    if x < w { for y in 0..h { rgb_img.put_pixel(x, y, gray); } }
                }
            }
            if rows > 0 {
                for i in 1..rows {
                    let y = (h as u64 * i as u64 / rows as u64) as u32;
                    if y < h { for x in 0..w { rgb_img.put_pixel(x, y, gray); } }
                }
            }
        }

        let q = quality.unwrap_or(80).clamp(1, 100) as u8;
        let rgb_raw = rgb_img.into_raw();
        let jpeg = encode_jpeg_mac(&rgb_raw, w, h, q)?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&jpeg);

        Ok(serde_json::json!({
            "base64": b64,
            "width": w, "height": h,
            "mimeType": "image/jpeg",
        }))
    }

    /// Crop a region from a base64-encoded image at full resolution.
    #[napi]
    pub fn crop_image(
        base64_image: String,
        x1: u32, y1: u32, x2: u32, y2: u32,
        quality: Option<u32>,
    ) -> napi::Result<serde_json::Value> {
        let img_bytes = base64::engine::general_purpose::STANDARD
            .decode(&base64_image)
            .map_err(|e| napi::Error::from_reason(format!("base64 decode: {e}")))?;

        use image::io::Reader as ImageReader;
        use std::io::Cursor;
        let img = ImageReader::new(Cursor::new(&img_bytes))
            .with_guessed_format()
            .map_err(|e| napi::Error::from_reason(format!("image format: {e}")))?
            .decode()
            .map_err(|e| napi::Error::from_reason(format!("image decode: {e}")))?;

        let iw = img.width();
        let ih = img.height();
        let cx1 = x1.min(iw.saturating_sub(1));
        let cy1 = y1.min(ih.saturating_sub(1));
        let cx2 = x2.min(iw).max(cx1 + 1);
        let cy2 = y2.min(ih).max(cy1 + 1);

        let cropped = img.crop_imm(cx1, cy1, cx2 - cx1, cy2 - cy1);
        let rgb = cropped.to_rgb8();
        let cw = rgb.width();
        let ch = rgb.height();
        let raw = rgb.into_raw();

        let q = quality.unwrap_or(0);
        let (encoded, mime) = if q == 0 {
            (encode_png_mac(&raw, cw, ch)?, "image/png")
        } else {
            (encode_jpeg_mac(&raw, cw, ch, q.clamp(1, 100) as u8)?, "image/jpeg")
        };

        let b64 = base64::engine::general_purpose::STANDARD.encode(&encoded);
        Ok(serde_json::json!({
            "base64": b64,
            "width": cw, "height": ch,
            "mimeType": mime,
        }))
    }
}


// ── Windows implementation ───────────────────────────────────────────────────
#[cfg(target_os = "windows")]
mod win {
    use base64::Engine;
    use napi_derive::napi;
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::sync::Mutex;
    use windows::core::Interface;
    use windows::Win32::Foundation::*;
    use windows::Win32::Graphics::Direct3D::*;
    use windows::Win32::Graphics::Direct3D11::*;
    use windows::Win32::Graphics::Dxgi::Common::*;
    use windows::Win32::Graphics::Dxgi::*;
    use windows::Win32::Graphics::Gdi::*;
    use windows::Win32::UI::WindowsAndMessaging::*;

    // ── Cached DXGI resources ────────────────────────────────────────────

    struct DxgiCapture {
        context: ID3D11DeviceContext,
        duplication: IDXGIOutputDuplication,
        staging: ID3D11Texture2D,
        staging_res: ID3D11Resource,
        width: u32,
        height: u32,
    }

    // Safety: COM pointers are thread-safe when used from the creating thread.
    // NAPI calls always come from the main JS thread.
    unsafe impl Send for DxgiCapture {}

    static DXGI_CACHE: Mutex<Option<DxgiCapture>> = Mutex::new(None);

    fn init_dxgi() -> Result<DxgiCapture, String> {
        unsafe {
            let mut device: Option<ID3D11Device> = None;
            let mut context: Option<ID3D11DeviceContext> = None;
            D3D11CreateDevice(
                None, D3D_DRIVER_TYPE_HARDWARE, None,
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                Some(&[D3D_FEATURE_LEVEL_11_0]),
                D3D11_SDK_VERSION,
                Some(&mut device), None, Some(&mut context),
            ).map_err(|e| format!("D3D11CreateDevice: {e}"))?;
            let device = device.ok_or("No D3D11 device")?;
            let context = context.ok_or("No D3D11 context")?;

            let dxgi_device: IDXGIDevice = device.cast()
                .map_err(|e| format!("IDXGIDevice: {e}"))?;
            let adapter: IDXGIAdapter = dxgi_device.GetParent()
                .map_err(|e| format!("adapter: {e}"))?;
            let output: IDXGIOutput = adapter.EnumOutputs(0)
                .map_err(|e| format!("EnumOutputs: {e}"))?;
            let output1: IDXGIOutput1 = output.cast()
                .map_err(|e| format!("IDXGIOutput1: {e}"))?;
            let duplication = output1.DuplicateOutput(&device)
                .map_err(|e| format!("DuplicateOutput: {e}"))?;

            let desc = duplication.GetDesc();
            let w = desc.ModeDesc.Width;
            let h = desc.ModeDesc.Height;

            // Pre-create staging texture
            let tex_desc = D3D11_TEXTURE2D_DESC {
                Width: w, Height: h, MipLevels: 1, ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_STAGING, BindFlags: 0,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                MiscFlags: 0,
            };
            let mut staging: Option<ID3D11Texture2D> = None;
            device.CreateTexture2D(&tex_desc, None, Some(&mut staging))
                .map_err(|e| format!("staging texture: {e}"))?;
            let staging = staging.ok_or("staging None")?;
            let staging_res: ID3D11Resource = staging.cast()
                .map_err(|e| format!("staging resource: {e}"))?;

            // Warm up: acquire+release one frame so subsequent calls are fast
            let mut fi = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut res: Option<IDXGIResource> = None;
            for _ in 0..5 {
                match duplication.AcquireNextFrame(200, &mut fi, &mut res) {
                    Ok(()) => { let _ = duplication.ReleaseFrame(); break; }
                    Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => continue,
                    Err(_) => break,
                }
            }

            Ok(DxgiCapture { context, duplication, staging, staging_res, width: w, height: h })
        }
    }

    fn capture_screen_dxgi() -> Result<(Vec<u8>, u32, u32), String> {
        let mut cache = DXGI_CACHE.lock().map_err(|e| format!("lock: {e}"))?;

        // Init on first call
        if cache.is_none() {
            *cache = Some(init_dxgi()?);
        }
        let cap = cache.as_ref().unwrap();

        unsafe {
            let mut fi = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut resource: Option<IDXGIResource> = None;

            // Always acquire a fresh frame. Use 100ms timeout to ensure we get
            // a real frame, not a stale warmup. DXGI delivers frames at vsync
            // (~16ms at 60Hz), so 100ms is plenty.
            let mut got_new_frame = false;
            for _ in 0..3 {
                match cap.duplication.AcquireNextFrame(100, &mut fi, &mut resource) {
                    Ok(()) => { got_new_frame = true; break; }
                    Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => continue,
                    Err(e) => {
                        *cache = None;
                        return Err(format!("AcquireNextFrame: {e}"));
                    }
                }
            }

            if got_new_frame {
                if let Some(ref res) = resource {
                    let texture: ID3D11Texture2D = res.cast()
                        .map_err(|e| format!("Texture2D: {e}"))?;
                    let tex_res: ID3D11Resource = texture.cast()
                        .map_err(|e| format!("tex resource: {e}"))?;
                    cap.context.CopyResource(&cap.staging_res, &tex_res);
                }
                let _ = cap.duplication.ReleaseFrame();
            }

            // Map the staging texture (always has the latest frame)
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            cap.context.Map(&cap.staging_res, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                .map_err(|e| format!("Map: {e}"))?;

            let row_pitch = mapped.RowPitch as usize;
            let w = cap.width;
            let h = cap.height;
            let mut pixels = Vec::with_capacity((w * h * 4) as usize);
            let src = mapped.pData as *const u8;
            for y in 0..h as usize {
                let row = std::slice::from_raw_parts(src.add(y * row_pitch), w as usize * 4);
                pixels.extend_from_slice(row);
            }

            cap.context.Unmap(&cap.staging_res, 0);

            Ok((pixels, w, h))
        }
    }

    // ── GDI BitBlt (fallback) ────────────────────────────────────────────

    fn capture_screen_gdi() -> napi::Result<(Vec<u8>, u32, u32)> {
        unsafe {
            let hdc_screen = GetDC(None);
            if hdc_screen.is_invalid() {
                return Err(napi::Error::from_reason("GetDC failed"));
            }
            let w = GetSystemMetrics(SM_CXSCREEN) as u32;
            let h = GetSystemMetrics(SM_CYSCREEN) as u32;

            let hdc_mem = CreateCompatibleDC(hdc_screen);
            let hbm = CreateCompatibleBitmap(hdc_screen, w as i32, h as i32);
            let old = SelectObject(hdc_mem, hbm);

            let _ = BitBlt(hdc_mem, 0, 0, w as i32, h as i32, hdc_screen, 0, 0, SRCCOPY);

            let mut bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w as i32,
                    biHeight: -(h as i32),
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: 0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut pixels = vec![0u8; (w * h * 4) as usize];
            GetDIBits(hdc_mem, hbm, 0, h, Some(pixels.as_mut_ptr() as *mut _), &mut bmi, DIB_RGB_COLORS);

            SelectObject(hdc_mem, old);
            let _ = DeleteObject(hbm);
            let _ = DeleteDC(hdc_mem);
            ReleaseDC(None, hdc_screen);

            Ok((pixels, w, h))
        }
    }

    /// Capture screen: try DXGI first, fall back to GDI.
    fn capture_screen() -> napi::Result<(Vec<u8>, u32, u32)> {
        match capture_screen_dxgi() {
            Ok(result) => Ok(result),
            Err(_) => capture_screen_gdi(),
        }
    }

    /// Capture a specific window via GDI BitBlt.
    fn capture_window(hwnd_val: u32) -> napi::Result<(Vec<u8>, u32, u32)> {
        unsafe {
            let hwnd = HWND(hwnd_val as *mut _);
            let mut rect = RECT::default();
            let _ = GetWindowRect(hwnd, &mut rect);
            let w = (rect.right - rect.left).max(1) as u32;
            let h = (rect.bottom - rect.top).max(1) as u32;

            let hdc_win = GetDC(hwnd);
            if hdc_win.is_invalid() {
                return Err(napi::Error::from_reason("GetDC for window failed"));
            }
            let hdc_mem = CreateCompatibleDC(hdc_win);
            let hbm = CreateCompatibleBitmap(hdc_win, w as i32, h as i32);
            let old = SelectObject(hdc_mem, hbm);

            let _ = BitBlt(hdc_mem, 0, 0, w as i32, h as i32, hdc_win, 0, 0, SRCCOPY);

            let mut bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w as i32,
                    biHeight: -(h as i32),
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: 0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut pixels = vec![0u8; (w * h * 4) as usize];
            GetDIBits(hdc_mem, hbm, 0, h, Some(pixels.as_mut_ptr() as *mut _), &mut bmi, DIB_RGB_COLORS);

            SelectObject(hdc_mem, old);
            let _ = DeleteObject(hbm);
            let _ = DeleteDC(hdc_mem);
            ReleaseDC(hwnd, hdc_win);

            Ok((pixels, w, h))
        }
    }

    /// Resize BGRA pixels using area averaging (box filter) — better quality than
    /// nearest-neighbor and faster for large downscale ratios because it reads
    /// source pixels sequentially. Returns BGRA.
    fn resize_bgra_box(src: &[u8], sw: u32, sh: u32, dw: u32, dh: u32) -> Vec<u8> {
        let mut dst = vec![0u8; (dw * dh * 4) as usize];
        let x_ratio = sw as f64 / dw as f64;
        let y_ratio = sh as f64 / dh as f64;

        for dy in 0..dh {
            let sy_start = (dy as f64 * y_ratio) as u32;
            let sy_end = (((dy + 1) as f64 * y_ratio) as u32).min(sh);
            let y_count = (sy_end - sy_start).max(1) as u32;

            for dx in 0..dw {
                let sx_start = (dx as f64 * x_ratio) as u32;
                let sx_end = (((dx + 1) as f64 * x_ratio) as u32).min(sw);
                let x_count = (sx_end - sx_start).max(1) as u32;
                let area = (x_count * y_count) as u32;

                let mut r_sum = 0u32;
                let mut g_sum = 0u32;
                let mut b_sum = 0u32;

                for sy in sy_start..sy_end {
                    let row_off = (sy * sw * 4) as usize;
                    for sx in sx_start..sx_end {
                        let si = row_off + (sx * 4) as usize;
                        b_sum += src[si] as u32;
                        g_sum += src[si + 1] as u32;
                        r_sum += src[si + 2] as u32;
                    }
                }

                let di = ((dy * dw + dx) * 4) as usize;
                dst[di] = (b_sum / area) as u8;
                dst[di + 1] = (g_sum / area) as u8;
                dst[di + 2] = (r_sum / area) as u8;
                dst[di + 3] = 255;
            }
        }
        dst
    }

    /// Convert BGRA to RGB in a single pass. When no resize is needed, this is
    /// the only conversion step.
    fn bgra_to_rgb(bgra: &[u8], _w: u32, _h: u32) -> Vec<u8> {
        let pixel_count = bgra.len() / 4;
        let mut rgb = Vec::with_capacity(pixel_count * 3);
        // Process 4 pixels at a time for better throughput
        let chunks = bgra.chunks_exact(16); // 4 pixels × 4 bytes
        let remainder = chunks.remainder();
        for chunk in chunks {
            rgb.extend_from_slice(&[chunk[2], chunk[1], chunk[0]]);   // pixel 0
            rgb.extend_from_slice(&[chunk[6], chunk[5], chunk[4]]);   // pixel 1
            rgb.extend_from_slice(&[chunk[10], chunk[9], chunk[8]]);  // pixel 2
            rgb.extend_from_slice(&[chunk[14], chunk[13], chunk[12]]); // pixel 3
        }
        for pixel in remainder.chunks_exact(4) {
            rgb.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
        }
        rgb
    }

    /// Encode RGB pixels as PNG (lossless).
    fn encode_png(rgb: &[u8], w: u32, h: u32) -> napi::Result<Vec<u8>> {
        use image::codecs::png::PngEncoder;
        use image::ImageEncoder;
        use std::io::Cursor;
        let estimated = (w * h * 3 / 2) as usize;
        let mut buf = Cursor::new(Vec::with_capacity(estimated));
        let enc = PngEncoder::new(&mut buf);
        enc.write_image(rgb, w, h, image::ExtendedColorType::Rgb8)
            .map_err(|e| napi::Error::from_reason(format!("PNG encode: {e}")))?;
        Ok(buf.into_inner())
    }

    /// Encode RGB pixels as JPEG using the `image` crate.
    fn encode_jpeg(rgb: &[u8], w: u32, h: u32, quality: u8) -> napi::Result<Vec<u8>> {
        use image::codecs::jpeg::JpegEncoder;
        use std::io::Cursor;
        let estimated = (w * h * 3 / 10) as usize;
        let mut buf = Cursor::new(Vec::with_capacity(estimated));
        let mut enc = JpegEncoder::new_with_quality(&mut buf, quality);
        enc.encode(rgb, w, h, image::ExtendedColorType::Rgb8)
            .map_err(|e| napi::Error::from_reason(format!("JPEG encode: {e}")))?;
        Ok(buf.into_inner())
    }

    #[napi]
    pub fn take_screenshot(
        width: Option<u32>,
        target_app: Option<String>,
        quality: Option<u32>,
        previous_hash: Option<String>,
        window_id: Option<u32>,
    ) -> napi::Result<serde_json::Value> {
        let (pixels, mut w, mut h) = if let Some(wid) = window_id {
            capture_window(wid)?
        } else if target_app.is_some() {
            capture_screen()?
        } else {
            capture_screen()?
        };

        // Optimization: resize on BGRA (4-byte aligned) THEN convert to RGB.
        // Box-filter downscale produces better quality than nearest-neighbor.
        let rgb = if let Some(target_w) = width {
            if target_w < w && target_w > 0 {
                let target_h = (h as u64 * target_w as u64 / w as u64) as u32;
                let resized = resize_bgra_box(&pixels, w, h, target_w, target_h);
                w = target_w;
                h = target_h;
                bgra_to_rgb(&resized, w, h)
            } else {
                bgra_to_rgb(&pixels, w, h)
            }
        } else {
            bgra_to_rgb(&pixels, w, h)
        };

        // quality=0 means PNG (lossless), quality 1-100 means JPEG
        let q = quality.unwrap_or(80);
        let (encoded, mime_type) = if q == 0 {
            (encode_png(&rgb, w, h)?, "image/png")
        } else {
            (encode_jpeg(&rgb, w, h, q.clamp(1, 100) as u8)?, "image/jpeg")
        };

        let mut hasher = DefaultHasher::new();
        encoded.hash(&mut hasher);
        let hash = format!("{:016x}", hasher.finish());

        if previous_hash.as_deref() == Some(hash.as_str()) {
            return Ok(serde_json::json!({
                "width": w, "height": h,
                "mimeType": mime_type,
                "hash": hash,
                "unchanged": true,
            }));
        }

        let b64 = base64::engine::general_purpose::STANDARD.encode(&encoded);
        Ok(serde_json::json!({
            "base64": b64,
            "width": w, "height": h,
            "mimeType": mime_type,
            "hash": hash,
            "unchanged": false,
        }))
    }

    /// Draw colored rectangles and grid lines on an RGB buffer, then JPEG encode.
    /// `annotations` is a JSON array of {x, y, width, height, color_index}.
    /// `grid_cols` and `grid_rows` draw evenly spaced reference lines.
    #[napi]
    pub fn annotate_image(
        base64_jpeg: String,
        annotations: Option<String>,
        grid_cols: Option<u32>,
        grid_rows: Option<u32>,
        quality: Option<u32>,
    ) -> napi::Result<serde_json::Value> {
        // Decode base64 JPEG
        let jpeg_bytes = base64::engine::general_purpose::STANDARD
            .decode(&base64_jpeg)
            .map_err(|e| napi::Error::from_reason(format!("base64 decode: {e}")))?;

        // Decode JPEG to RGB using image crate
        use image::io::Reader as ImageReader;
        use std::io::Cursor;
        let img = ImageReader::new(Cursor::new(&jpeg_bytes))
            .with_guessed_format()
            .map_err(|e| napi::Error::from_reason(format!("image format: {e}")))?
            .decode()
            .map_err(|e| napi::Error::from_reason(format!("image decode: {e}")))?;
        let mut rgb_img = img.to_rgb8();
        let w = rgb_img.width();
        let h = rgb_img.height();

        // Color palette for annotations (matching Windows-MCP style)
        let colors: [(u8, u8, u8); 8] = [
            (255, 0, 0),     // red
            (0, 255, 0),     // green
            (0, 0, 255),     // blue
            (255, 255, 0),   // yellow
            (255, 0, 255),   // magenta
            (0, 255, 255),   // cyan
            (255, 128, 0),   // orange
            (128, 0, 255),   // purple
        ];

        // Draw annotation rectangles
        if let Some(ref ann_json) = annotations {
            if let Ok(anns) = serde_json::from_str::<Vec<serde_json::Value>>(ann_json) {
                for (i, ann) in anns.iter().enumerate() {
                    let ax = ann.get("x").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                    let ay = ann.get("y").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                    let aw = ann.get("width").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                    let ah = ann.get("height").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                    let (cr, cg, cb) = colors[i % colors.len()];
                    let thickness = 2i32;

                    // Draw rectangle border
                    for t in 0..thickness {
                        // Top and bottom edges
                        for x in ax.max(0)..(ax + aw).min(w as i32) {
                            for dy in [ay + t, ay + ah - 1 - t] {
                                if dy >= 0 && dy < h as i32 && x >= 0 && x < w as i32 {
                                    rgb_img.put_pixel(x as u32, dy as u32, image::Rgb([cr, cg, cb]));
                                }
                            }
                        }
                        // Left and right edges
                        for y in ay.max(0)..(ay + ah).min(h as i32) {
                            for dx in [ax + t, ax + aw - 1 - t] {
                                if dx >= 0 && dx < w as i32 && y >= 0 && y < h as i32 {
                                    rgb_img.put_pixel(dx as u32, y as u32, image::Rgb([cr, cg, cb]));
                                }
                            }
                        }
                    }
                }
            }
        }

        // Draw grid lines
        if let (Some(cols), Some(rows)) = (grid_cols, grid_rows) {
            let gray = image::Rgb([128u8, 128, 128]);
            if cols > 0 {
                for i in 1..cols {
                    let x = (w as u64 * i as u64 / cols as u64) as u32;
                    if x < w {
                        for y in 0..h { rgb_img.put_pixel(x, y, gray); }
                    }
                }
            }
            if rows > 0 {
                for i in 1..rows {
                    let y = (h as u64 * i as u64 / rows as u64) as u32;
                    if y < h {
                        for x in 0..w { rgb_img.put_pixel(x, y, gray); }
                    }
                }
            }
        }

        // Re-encode as JPEG
        let q = quality.unwrap_or(80).clamp(1, 100) as u8;
        let rgb_raw = rgb_img.into_raw();
        let jpeg = encode_jpeg(&rgb_raw, w, h, q)?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&jpeg);

        Ok(serde_json::json!({
            "base64": b64,
            "width": w, "height": h,
            "mimeType": "image/jpeg",
        }))
    }

    /// Crop a region from a base64-encoded image and return at full resolution.
    /// quality=0 for PNG, 1-100 for JPEG.
    #[napi]
    pub fn crop_image(
        base64_image: String,
        x1: u32, y1: u32, x2: u32, y2: u32,
        quality: Option<u32>,
    ) -> napi::Result<serde_json::Value> {
        let img_bytes = base64::engine::general_purpose::STANDARD
            .decode(&base64_image)
            .map_err(|e| napi::Error::from_reason(format!("base64 decode: {e}")))?;

        use image::io::Reader as ImageReader;
        use std::io::Cursor;
        let img = ImageReader::new(Cursor::new(&img_bytes))
            .with_guessed_format()
            .map_err(|e| napi::Error::from_reason(format!("image format: {e}")))?
            .decode()
            .map_err(|e| napi::Error::from_reason(format!("image decode: {e}")))?;

        let iw = img.width();
        let ih = img.height();
        let cx1 = x1.min(iw.saturating_sub(1));
        let cy1 = y1.min(ih.saturating_sub(1));
        let cx2 = x2.min(iw).max(cx1 + 1);
        let cy2 = y2.min(ih).max(cy1 + 1);

        let cropped = img.crop_imm(cx1, cy1, cx2 - cx1, cy2 - cy1);
        let rgb = cropped.to_rgb8();
        let cw = rgb.width();
        let ch = rgb.height();
        let raw = rgb.into_raw();

        let q = quality.unwrap_or(0);
        let (encoded, mime) = if q == 0 {
            (encode_png(&raw, cw, ch)?, "image/png")
        } else {
            (encode_jpeg(&raw, cw, ch, q.clamp(1, 100) as u8)?, "image/jpeg")
        };

        let b64 = base64::engine::general_purpose::STANDARD.encode(&encoded);
        Ok(serde_json::json!({
            "base64": b64,
            "width": cw, "height": ch,
            "mimeType": mime,
        }))
    }
}
