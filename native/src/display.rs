// ── Linux implementation ──────────────────────────────────────────────────────
#[cfg(target_os = "linux")]
mod linux {
    use napi_derive::napi;
    use std::ptr;
    use x11::xlib::*;

    /// The X screen's size, or None when there is no X display (a Wayland session without XWayland).
    fn x_screens() -> Option<Vec<(u64, u64)>> {
        unsafe {
            let dpy = XOpenDisplay(ptr::null());
            if dpy.is_null() {
                return None;
            }
            let screens = (0..XScreenCount(dpy))
                .map(|i| (XDisplayWidth(dpy, i) as u64, XDisplayHeight(dpy, i) as u64))
                .collect();
            XCloseDisplay(dpy);
            Some(screens)
        }
    }

    fn size_json(width: i64, height: i64, scale: f64, id: usize) -> serde_json::Value {
        serde_json::json!({
            "width": width, "height": height,
            "pixelWidth": (width as f64 * scale).round() as i64, "pixelHeight": (height as f64 * scale).round() as i64,
            "scaleFactor": scale,
            "displayId": id,
        })
    }

    #[napi]
    pub fn get_display_size(display_id: Option<u32>) -> napi::Result<serde_json::Value> {
        if let Some(screens) = x_screens() {
            let index = display_id.map(|id| id as usize).filter(|id| *id < screens.len()).unwrap_or(0);
            let (w, h) = screens.get(index).copied().unwrap_or((0, 0));
            return Ok(size_json(w as i64, h as i64, 1.0, index));
        }
        // 7.7.x: no X display (sway or Hyprland without XWayland): the compositor's outputs, as one desktop like X11's.
        let outputs = crate::linux_desktop::outputs()?;
        if let Some(output) = display_id.and_then(|id| outputs.get(id as usize)) {
            return Ok(size_json(output.width, output.height, output.scale, display_id.unwrap_or(0) as usize));
        }
        let (width, height, scale) = crate::linux_desktop::desktop_bounds(&outputs).unwrap_or((0, 0, 1.0));
        Ok(size_json(width, height, scale, 0))
    }

    #[napi]
    pub fn list_displays() -> napi::Result<serde_json::Value> {
        if let Some(screens) = x_screens() {
            return Ok(serde_json::json!(screens
                .iter()
                .enumerate()
                .map(|(i, (w, h))| size_json(*w as i64, *h as i64, 1.0, i))
                .collect::<Vec<_>>()));
        }
        let outputs = crate::linux_desktop::outputs()?;
        Ok(serde_json::json!(outputs
            .iter()
            .enumerate()
            .map(|(i, output)| {
                let mut entry = size_json(output.width, output.height, output.scale, i);
                entry["x"] = output.x.into();
                entry["y"] = output.y.into();
                entry["name"] = output.name.clone().into();
                entry
            })
            .collect::<Vec<_>>()))
    }
}

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
        let bounds = display.bounds();
        let w = bounds.size.width as u64;
        let h = bounds.size.height as u64;
        let (pw, ph, scale) = match display.display_mode() {
            Some(mode) => {
                let pw = mode.pixel_width();
                let ph = mode.pixel_height();
                (pw, ph, if w > 0 { pw as f64 / w as f64 } else { 1.0 })
            }
            None => (w as u64, h as u64, 1.0),
        };
        Ok(serde_json::json!({
            "width": w, "height": h, "x": bounds.origin.x, "y": bounds.origin.y,
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
            let bounds = display.bounds();
        let w = bounds.size.width as u64;
            let h = bounds.size.height as u64;
            let (pw, ph, scale) = match display.display_mode() {
                Some(mode) => {
                    let pw = mode.pixel_width();
                    let ph = mode.pixel_height();
                    (pw, ph, if w > 0 { pw as f64 / w as f64 } else { 1.0 })
                }
                None => (w as u64, h as u64, 1.0),
            };
            result.push(serde_json::json!({
                "width": w, "height": h, "x": bounds.origin.x, "y": bounds.origin.y,
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
    use windows::Win32::Foundation::{BOOL, LPARAM, POINT, RECT, TRUE};
    use windows::Win32::Graphics::Gdi::*;

    pub(crate) struct MonitorInfo {
        pub handle: isize,
        pub rect: RECT,
        pub dpi_x: u32,
        pub primary: bool,
    }

    pub(crate) fn enumerate_monitors() -> Vec<MonitorInfo> {
        use windows::Win32::UI::HiDpi::*;
        crate::dpi::ensure();
        let mut monitors: Vec<MonitorInfo> = Vec::new();
        let ptr = LPARAM(&mut monitors as *mut Vec<MonitorInfo> as isize);
        unsafe {
            let _ = EnumDisplayMonitors(None, None, Some(enum_cb), ptr);
        }
        let primary = unsafe { MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY) };
        for m in &mut monitors {
            let hmon = HMONITOR(m.handle as *mut _);
            let mut dx: u32 = 96;
            let mut dy: u32 = 96;
            unsafe {
                let _ = GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dx, &mut dy);
            }
            m.dpi_x = dx;
            m.primary = hmon == primary;
        }
        // The primary first, so callers that take the first monitor take the one at (0, 0) (7.7.0: EnumDisplayMonitors
        // gives no order, and the first one was not always the primary).
        monitors.sort_by_key(|m| !m.primary);
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
            primary: false,
        });
        TRUE
    }

    /// 7.7.0 (K6): with per-monitor DPI awareness the rectangle is in physical pixels, which is also the space input,
    /// window bounds, captures and UI Automation use, so width and pixelWidth agree and scaleFactor is informational.
    /// Without it (the opt-out) the rectangle is virtualised to 96 DPI, as before.
    fn describe(m: &MonitorInfo) -> serde_json::Value {
        let w = (m.rect.right - m.rect.left) as u64;
        let h = (m.rect.bottom - m.rect.top) as u64;
        let scale = m.dpi_x as f64 / 96.0;
        let physical = crate::dpi::per_monitor_aware();
        let (pw, ph) = if physical { (w, h) } else { ((w as f64 * scale) as u64, (h as f64 * scale) as u64) };
        serde_json::json!({
            "width": w, "height": h, "x": m.rect.left, "y": m.rect.top,
            "pixelWidth": pw, "pixelHeight": ph,
            "scaleFactor": scale,
            "displayId": m.handle,
            "primary": m.primary,
            "coordinateSpace": if physical { "physical_pixels" } else { "virtualized_96dpi" },
        })
    }

    #[napi]
    pub fn get_display_size(display_id: Option<u32>) -> napi::Result<serde_json::Value> {
        let monitors = enumerate_monitors();
        let m = match display_id {
            Some(id) => monitors.iter().find(|m| m.handle as u32 == id).or(monitors.first()),
            None => monitors.first(),
        };
        let m = m.ok_or_else(|| napi::Error::from_reason("No display found"))?;
        Ok(describe(m))
    }

    #[napi]
    pub fn list_displays() -> napi::Result<serde_json::Value> {
        Ok(serde_json::json!(enumerate_monitors().iter().map(describe).collect::<Vec<_>>()))
    }
}
