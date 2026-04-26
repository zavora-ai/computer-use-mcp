// ── macOS implementation ──────────────────────────────────────────────────────
#[cfg(target_os = "macos")]
#[path = "windows_macos.rs"]
mod platform;

// ── Windows implementation ───────────────────────────────────────────────────
#[cfg(target_os = "windows")]
mod platform {
    use napi_derive::napi;
    use windows::Win32::Foundation::*;
    use windows::Win32::Graphics::Gdi::*;
    use windows::Win32::System::Threading::*;
    use windows::Win32::UI::WindowsAndMessaging::*;

    fn process_name_for_pid(pid: u32) -> Option<String> {
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = [0u16; 260];
            let mut size = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_FORMAT(0),
                windows::core::PWSTR(buf.as_mut_ptr()),
                &mut size,
            );
            let _ = CloseHandle(handle);
            if ok.is_err() { return None; }
            let path = String::from_utf16_lossy(&buf[..size as usize]);
            path.rsplit('\\').next().map(|s| s.to_string())
        }
    }

    fn monitor_for_rect(rect: &RECT) -> isize {
        unsafe {
            let pt = POINT {
                x: (rect.left + rect.right) / 2,
                y: (rect.top + rect.bottom) / 2,
            };
            let hmon = MonitorFromPoint(pt, MONITOR_DEFAULTTOPRIMARY);
            hmon.0 as isize
        }
    }

    fn window_record(hwnd: HWND, fg_hwnd: HWND) -> Option<serde_json::Value> {
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() { return None; }
            let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
            if ex_style & WS_EX_TOOLWINDOW.0 != 0 { return None; }

            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            let name = process_name_for_pid(pid).unwrap_or_default();

            let mut title_buf = [0u16; 512];
            let len = GetWindowTextW(hwnd, &mut title_buf);
            let title = if len > 0 {
                Some(String::from_utf16_lossy(&title_buf[..len as usize]))
            } else {
                None
            };

            let mut rect = RECT::default();
            let _ = GetWindowRect(hwnd, &mut rect);
            let display_id = monitor_for_rect(&rect);

            Some(serde_json::json!({
                "windowId": hwnd.0 as usize,
                "bundleId": name,
                "displayName": name,
                "pid": pid,
                "title": title,
                "bounds": {
                    "x": rect.left,
                    "y": rect.top,
                    "width": rect.right - rect.left,
                    "height": rect.bottom - rect.top,
                },
                "isOnScreen": !IsIconic(hwnd).as_bool(),
                "isFocused": hwnd == fg_hwnd,
                "displayId": display_id,
            }))
        }
    }

    #[napi]
    pub fn list_windows(bundle_id: Option<String>) -> napi::Result<serde_json::Value> {
        let filter = bundle_id.map(|s| s.to_lowercase());
        let mut result: Vec<serde_json::Value> = Vec::new();

        unsafe {
            let fg = GetForegroundWindow();
            struct Data<'a> {
                filter: &'a Option<String>,
                fg: HWND,
                result: Vec<serde_json::Value>,
            }
            let mut data = Data { filter: &filter, fg, result: Vec::new() };
            let ptr = LPARAM(&mut data as *mut Data as isize);

            unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
                let data = &mut *(lparam.0 as *mut Data);
                if let Some(rec) = window_record(hwnd, data.fg) {
                    if let Some(ref f) = data.filter {
                        let bid = rec.get("bundleId").and_then(|v| v.as_str()).unwrap_or("");
                        if bid.to_lowercase() != *f && bid.to_lowercase().trim_end_matches(".exe") != f.trim_end_matches(".exe") {
                            return TRUE;
                        }
                    }
                    data.result.push(rec);
                }
                TRUE
            }

            let _ = EnumWindows(Some(cb), ptr);
            result = data.result;
        }

        Ok(serde_json::json!(result))
    }

    #[napi]
    pub fn get_window(window_id: u32) -> napi::Result<serde_json::Value> {
        unsafe {
            let hwnd = HWND(window_id as *mut _);
            if !IsWindow(hwnd).as_bool() {
                return Ok(serde_json::json!(null));
            }
            let fg = GetForegroundWindow();
            match window_record(hwnd, fg) {
                Some(rec) => Ok(rec),
                None => Ok(serde_json::json!(null)),
            }
        }
    }

    #[napi]
    pub fn get_cursor_window() -> napi::Result<serde_json::Value> {
        unsafe {
            let mut pt = POINT::default();
            let _ = GetCursorPos(&mut pt);
            let hwnd = WindowFromPoint(pt);
            if hwnd.0.is_null() { return Ok(serde_json::json!(null)); }
            // Walk up to the top-level window
            let mut top = hwnd;
            loop {
                let parent = GetParent(top);
                match parent {
                    Ok(p) if !p.0.is_null() => top = p,
                    _ => break,
                }
            }
            let fg = GetForegroundWindow();
            match window_record(top, fg) {
                Some(rec) => Ok(rec),
                None => Ok(serde_json::json!(null)),
            }
        }
    }

    #[napi]
    pub fn activate_window(window_id: u32, timeout_ms: Option<i32>) -> napi::Result<serde_json::Value> {
        let timeout = timeout_ms.unwrap_or(3000) as u64;
        unsafe {
            let hwnd = HWND(window_id as *mut _);
            if !IsWindow(hwnd).as_bool() {
                return Ok(serde_json::json!({
                    "windowId": window_id, "activated": false,
                    "reason": "window_not_found",
                }));
            }

            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
                std::thread::sleep(std::time::Duration::from_millis(100));
            }

            let fg_thread = GetWindowThreadProcessId(GetForegroundWindow(), None);
            let target_thread = GetWindowThreadProcessId(hwnd, None);
            if fg_thread != target_thread {
                AttachThreadInput(fg_thread, target_thread, true);
            }
            let _ = SetForegroundWindow(hwnd);
            let _ = BringWindowToTop(hwnd);
            if fg_thread != target_thread {
                AttachThreadInput(fg_thread, target_thread, false);
            }

            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout);
            let mut activated = false;
            while std::time::Instant::now() < deadline {
                if GetForegroundWindow() == hwnd { activated = true; break; }
                std::thread::sleep(std::time::Duration::from_millis(30));
            }

            let mut fg_pid: u32 = 0;
            GetWindowThreadProcessId(GetForegroundWindow(), Some(&mut fg_pid));
            let fg_name = process_name_for_pid(fg_pid);

            Ok(serde_json::json!({
                "windowId": window_id,
                "activated": activated,
                "frontmostAfter": fg_name,
                "reason": if activated { serde_json::Value::Null } else { serde_json::json!("raise_failed") },
            }))
        }
    }
}
