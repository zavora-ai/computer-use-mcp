// ── Linux implementation ──────────────────────────────────────────────────────
#[cfg(target_os = "linux")]
mod platform {
    use napi_derive::napi;
    use std::process::Command;
    use std::sync::OnceLock;

    static IS_WAYLAND: OnceLock<bool> = OnceLock::new();

    fn is_wayland() -> bool {
        *IS_WAYLAND.get_or_init(|| {
            std::env::var("XDG_SESSION_TYPE").map(|v| v == "wayland").unwrap_or(false)
        })
    }

    fn gdbus_eval(js: &str) -> Option<String> {
        let output = Command::new("gdbus").args([
            "call", "--session",
            "--dest", "org.gnome.Shell",
            "--object-path", "/org/gnome/Shell",
            "--method", "org.gnome.Shell.Eval",
            js,
        ]).output().ok()?;
        let text = String::from_utf8_lossy(&output.stdout).to_string();
        // Format: (true, 'json_string')
        if text.starts_with("(true,") {
            let start = text.find('\'')?;
            let end = text.rfind('\'')?;
            if start < end {
                return Some(text[start+1..end].replace("\\'", "'"));
            }
        }
        None
    }

    fn list_windows_wayland(bundle_id: &Option<String>) -> Vec<serde_json::Value> {
        let js = r#"JSON.stringify(global.get_window_actors().map(a=>{let w=a.meta_window;let r=w.get_frame_rect();return{windowId:w.get_id(),bundleId:w.get_wm_class()||'',displayName:w.get_wm_class()||'',pid:w.get_pid(),title:w.get_title()||'',bounds:{x:r.x,y:r.y,width:r.width,height:r.height},isOnScreen:!w.minimized,isFocused:w.has_focus(),displayId:0}}))"#;
        let json_str = match gdbus_eval(js) {
            Some(s) => s,
            None => return Vec::new(),
        };
        let windows: Vec<serde_json::Value> = serde_json::from_str(&json_str).unwrap_or_default();
        if let Some(ref filter) = bundle_id {
            windows.into_iter().filter(|w| {
                let bid = w.get("bundleId").and_then(|v| v.as_str()).unwrap_or("");
                bid.to_lowercase() == filter.to_lowercase()
            }).collect()
        } else {
            windows
        }
    }

    fn list_windows_x11(bundle_id: &Option<String>) -> Vec<serde_json::Value> {
        let output = Command::new("wmctrl").args(["-l", "-p"]).output().unwrap_or_else(|_| {
            Command::new("true").output().unwrap()
        });
        let text = String::from_utf8_lossy(&output.stdout);
        let active = Command::new("xdotool").args(["getactivewindow"]).output().ok()
            .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<u32>().ok())
            .unwrap_or(0);

        let mut result = Vec::new();
        for line in text.lines() {
            let parts: Vec<&str> = line.splitn(5, char::is_whitespace).filter(|s| !s.is_empty()).collect();
            if parts.len() < 4 { continue; }
            let wid = u32::from_str_radix(parts[0].trim_start_matches("0x"), 16).unwrap_or(0);
            let pid = parts[2].parse::<i32>().unwrap_or(0);
            let title = if parts.len() >= 5 { parts[4].to_string() } else { String::new() };
            let proc_name = std::fs::read_to_string(format!("/proc/{pid}/comm"))
                .unwrap_or_default().trim().to_string();

            if let Some(ref filter) = bundle_id {
                if proc_name.to_lowercase() != filter.to_lowercase() { continue; }
            }

            result.push(serde_json::json!({
                "windowId": wid,
                "bundleId": proc_name,
                "displayName": proc_name,
                "pid": pid,
                "title": title,
                "bounds": { "x": 0, "y": 0, "width": 0, "height": 0 },
                "isOnScreen": true,
                "isFocused": wid == active,
                "displayId": 0,
            }));
        }
        result
    }

    #[napi]
    pub fn list_windows(bundle_id: Option<String>) -> napi::Result<serde_json::Value> {
        let result = if is_wayland() {
            let mut wins = list_windows_wayland(&bundle_id);
            if wins.is_empty() {
                // Fall back to X11 tools via XWayland
                wins = list_windows_x11(&bundle_id);
            }
            wins
        } else {
            list_windows_x11(&bundle_id)
        };
        Ok(serde_json::json!(result))
    }

    #[napi]
    pub fn get_window(window_id: u32) -> napi::Result<serde_json::Value> {
        if is_wayland() {
            let js = format!(
                r#"let w=global.get_window_actors().map(a=>a.meta_window).find(w=>w.get_id()==={wid});w?JSON.stringify({{windowId:w.get_id(),bundleId:w.get_wm_class()||'',displayName:w.get_wm_class()||'',pid:w.get_pid(),title:w.get_title()||'',bounds:(()=>{{let r=w.get_frame_rect();return{{x:r.x,y:r.y,width:r.width,height:r.height}}}})(),isOnScreen:!w.minimized,isFocused:w.has_focus(),displayId:0}}):'null'"#,
                wid = window_id
            );
            if let Some(json_str) = gdbus_eval(&js) {
                if json_str != "null" {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&json_str) {
                        return Ok(val);
                    }
                }
            }
        }
        // X11 fallback
        let output = Command::new("xdotool").args(["getwindowname", &window_id.to_string()]).output();
        let title = output.ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
        let pid_out = Command::new("xdotool").args(["getwindowpid", &window_id.to_string()]).output();
        let pid = pid_out.ok().and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<i32>().ok()).unwrap_or(0);
        let proc_name = std::fs::read_to_string(format!("/proc/{pid}/comm")).unwrap_or_default().trim().to_string();
        if title.is_empty() && pid == 0 { return Ok(serde_json::json!(null)); }
        Ok(serde_json::json!({
            "windowId": window_id, "bundleId": proc_name, "displayName": proc_name,
            "pid": pid, "title": title,
            "bounds": { "x": 0, "y": 0, "width": 0, "height": 0 },
            "isOnScreen": true, "isFocused": false, "displayId": 0,
        }))
    }

    #[napi]
    pub fn get_cursor_window() -> napi::Result<serde_json::Value> {
        if is_wayland() {
            let js = r#"let w=global.get_window_actors().map(a=>a.meta_window).find(w=>w.has_focus());w?JSON.stringify({windowId:w.get_id(),bundleId:w.get_wm_class()||'',displayName:w.get_wm_class()||'',pid:w.get_pid(),title:w.get_title()||'',bounds:(()=>{let r=w.get_frame_rect();return{x:r.x,y:r.y,width:r.width,height:r.height}})(),isOnScreen:!w.minimized,isFocused:true,displayId:0}):'null'"#;
            if let Some(json_str) = gdbus_eval(js) {
                if json_str != "null" {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&json_str) {
                        return Ok(val);
                    }
                }
            }
        }
        // X11 fallback
        let output = Command::new("xdotool").args(["getmouselocation", "--shell"]).output()
            .map_err(|e| napi::Error::from_reason(format!("xdotool: {e}")))?;
        let text = String::from_utf8_lossy(&output.stdout);
        let wid = text.lines()
            .find(|l| l.starts_with("WINDOW="))
            .and_then(|l| l.strip_prefix("WINDOW="))
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(0);
        if wid == 0 { return Ok(serde_json::json!(null)); }
        get_window(wid)
    }

    #[napi]
    pub fn activate_window(window_id: u32, _timeout_ms: Option<i32>) -> napi::Result<serde_json::Value> {
        if is_wayland() {
            let js = format!(
                r#"let w=global.get_window_actors().map(a=>a.meta_window).find(w=>w.get_id()==={wid});if(w){{w.activate(global.get_current_time());'true'}}else{{'false'}}"#,
                wid = window_id
            );
            let activated = gdbus_eval(&js).map(|s| s == "true").unwrap_or(false);
            return Ok(serde_json::json!({
                "windowId": window_id,
                "activated": activated,
                "reason": if activated { serde_json::Value::Null } else { serde_json::json!("window_not_found") },
            }));
        }
        let status = Command::new("xdotool").args(["windowactivate", "--sync", &window_id.to_string()]).status();
        let activated = status.map(|s| s.success()).unwrap_or(false);
        Ok(serde_json::json!({
            "windowId": window_id,
            "activated": activated,
            "reason": if activated { serde_json::Value::Null } else { serde_json::json!("raise_failed") },
        }))
    }
}

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
