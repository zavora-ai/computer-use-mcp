// ── macOS implementation ──────────────────────────────────────────────────────
#[cfg(target_os = "macos")]
mod macos {
    use core_graphics::display::CGDisplay;
    use napi_derive::napi;

    extern "C" {
        fn CGMainDisplayID() -> u32;
        fn CGGetActiveDisplayList(max: u32, displays: *mut u32, count: *mut u32) -> i32;
    }

    #[napi]
    pub fn get_display_size(display_id: Option<u32>) -> napi::Result<serde_json::Value> {
        let did = display_id.unwrap_or_else(|| unsafe { CGMainDisplayID() });
        let display = CGDisplay::new(did);
        let w = display.pixels_wide();
        let h = display.pixels_high();
        let (pw, ph, scale) = match display.display_mode() {
            Some(mode) => {
                let pw = mode.pixel_width();
                let ph = mode.pixel_height();
                (pw, ph, if w > 0 { pw as f64 / w as f64 } else { 1.0 })
            }
            None => (w as u64, h as u64, 1.0),
        };
        Ok(serde_json::json!({
            "width": w, "height": h,
            "pixelWidth": pw, "pixelHeight": ph,
            "scaleFactor": scale,
            "displayId": did,
        }))
    }

    #[napi]
    pub fn list_displays() -> napi::Result<serde_json::Value> {
        let mut displays = [0u32; 16];
        let mut count = 0u32;
        let err = unsafe { CGGetActiveDisplayList(16, displays.as_mut_ptr(), &mut count) };
        if err != 0 {
            return Err(napi::Error::from_reason(format!(
                "CGGetActiveDisplayList error: {err}"
            )));
        }
        let mut result = Vec::new();
        for i in 0..count as usize {
            let did = displays[i];
            let display = CGDisplay::new(did);
            let w = display.pixels_wide();
            let h = display.pixels_high();
            let (pw, ph, scale) = match display.display_mode() {
                Some(mode) => {
                    let pw = mode.pixel_width();
                    let ph = mode.pixel_height();
                    (pw, ph, if w > 0 { pw as f64 / w as f64 } else { 1.0 })
                }
                None => (w as u64, h as u64, 1.0),
            };
            result.push(serde_json::json!({
                "width": w, "height": h,
                "pixelWidth": pw, "pixelHeight": ph,
                "scaleFactor": scale,
                "displayId": did,
            }));
        }
        Ok(serde_json::json!(result))
    }
}


// ── Windows implementation ───────────────────────────────────────────────────
#[cfg(target_os = "windows")]
mod win {
    use napi_derive::napi;
    use windows::Win32::Foundation::{BOOL, LPARAM, RECT, TRUE};
    use windows::Win32::Graphics::Gdi::*;

    struct MonitorInfo {
        handle: isize,
        rect: RECT,
        dpi_x: u32,
        dpi_y: u32,
    }

    fn enumerate_monitors() -> Vec<MonitorInfo> {
        use windows::Win32::UI::HiDpi::*;
        let mut monitors: Vec<MonitorInfo> = Vec::new();
        let ptr = LPARAM(&mut monitors as *mut Vec<MonitorInfo> as isize);
        unsafe {
            let _ = EnumDisplayMonitors(None, None, Some(enum_cb), ptr);
        }
        // Fill DPI
        for m in &mut monitors {
            let hmon = HMONITOR(m.handle as *mut _);
            let mut dx: u32 = 96;
            let mut dy: u32 = 96;
            unsafe {
                let _ = GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dx, &mut dy);
            }
            m.dpi_x = dx;
            m.dpi_y = dy;
        }
        monitors
    }

    unsafe extern "system" fn enum_cb(
        hmon: HMONITOR,
        _hdc: HDC,
        rect: *mut RECT,
        data: LPARAM,
    ) -> BOOL {
        let monitors = &mut *(data.0 as *mut Vec<MonitorInfo>);
        monitors.push(MonitorInfo {
            handle: hmon.0 as isize,
            rect: *rect,
            dpi_x: 96,
            dpi_y: 96,
        });
        TRUE
    }

    #[napi]
    pub fn get_display_size(display_id: Option<u32>) -> napi::Result<serde_json::Value> {
        let monitors = enumerate_monitors();
        let m = if let Some(id) = display_id {
            monitors
                .iter()
                .find(|m| m.handle as u32 == id)
                .or(monitors.first())
        } else {
            monitors.first()
        };
        let m = m.ok_or_else(|| napi::Error::from_reason("No display found"))?;
        let w = (m.rect.right - m.rect.left) as u64;
        let h = (m.rect.bottom - m.rect.top) as u64;
        let scale = m.dpi_x as f64 / 96.0;
        let pw = (w as f64 * scale) as u64;
        let ph = (h as f64 * scale) as u64;
        Ok(serde_json::json!({
            "width": w, "height": h,
            "pixelWidth": pw, "pixelHeight": ph,
            "scaleFactor": scale,
            "displayId": m.handle,
        }))
    }

    #[napi]
    pub fn list_displays() -> napi::Result<serde_json::Value> {
        let monitors = enumerate_monitors();
        let mut result = Vec::new();
        for m in &monitors {
            let w = (m.rect.right - m.rect.left) as u64;
            let h = (m.rect.bottom - m.rect.top) as u64;
            let scale = m.dpi_x as f64 / 96.0;
            let pw = (w as f64 * scale) as u64;
            let ph = (h as f64 * scale) as u64;
            result.push(serde_json::json!({
                "width": w, "height": h,
                "pixelWidth": pw, "pixelHeight": ph,
                "scaleFactor": scale,
                "displayId": m.handle,
            }));
        }
        Ok(serde_json::json!(result))
    }
}
