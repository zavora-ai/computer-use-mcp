// ── Linux implementation ──────────────────────────────────────────────────────
#[cfg(target_os = "linux")]
mod linux {
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
        if text.starts_with("(true,") {
            let start = text.find('\'')?;
            let end = text.rfind('\'')?;
            if start < end {
                return Some(text[start+1..end].replace("\\'", "'"));
            }
        }
        None
    }

    #[napi(js_name = "drainRunloop")]
    pub fn drain_runloop_pub() {}

    #[napi]
    pub fn get_frontmost_app() -> napi::Result<serde_json::Value> {
        if is_wayland() {
            let js = r#"let w=global.get_window_actors().map(a=>a.meta_window).find(w=>w.has_focus());w?JSON.stringify({bundleId:w.get_wm_class()||'',displayName:w.get_title()||'',pid:w.get_pid()}):'null'"#;
            if let Some(json_str) = gdbus_eval(js) {
                if json_str != "null" {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&json_str) {
                        return Ok(val);
                    }
                }
            }
        }
        // X11/fallback
        let output = Command::new("xdotool").args(["getactivewindow", "getwindowpid"]).output();
        let pid = output.ok()
            .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<i32>().ok())
            .unwrap_or(0);
        let name_output = Command::new("xdotool").args(["getactivewindow", "getwindowname"]).output();
        let title = name_output.ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        let proc_name = std::fs::read_to_string(format!("/proc/{pid}/comm"))
            .unwrap_or_default().trim().to_string();
        Ok(serde_json::json!({ "bundleId": proc_name, "displayName": title, "pid": pid }))
    }

    #[napi]
    pub fn activate_app(bundle_id: String, _timeout_ms: Option<i32>) -> napi::Result<serde_json::Value> {
        if is_wayland() {
            let js = format!(
                r#"let w=global.get_window_actors().map(a=>a.meta_window).find(w=>(w.get_wm_class()||'').toLowerCase()==='{cls}'.toLowerCase());if(w){{w.activate(global.get_current_time());'true'}}else{{'false'}}"#,
                cls = bundle_id.replace('\'', "\\'")
            );
            let activated = gdbus_eval(&js).map(|s| s == "true").unwrap_or(false);
            if activated {
                return Ok(serde_json::json!({ "bundleId": bundle_id, "activated": true, "displayName": bundle_id }));
            }
        }
        // Try wmctrl
        let status = Command::new("wmctrl").args(["-x", "-a", &bundle_id]).status();
        let activated = status.map(|s| s.success()).unwrap_or(false);
        Ok(serde_json::json!({ "bundleId": bundle_id, "activated": activated, "displayName": bundle_id }))
    }

    #[napi]
    pub fn list_running_apps() -> napi::Result<serde_json::Value> {
        if is_wayland() {
            let js = r#"JSON.stringify([...new Set(global.get_window_actors().map(a=>{let w=a.meta_window;return JSON.stringify({bundleId:w.get_wm_class()||'',displayName:w.get_wm_class()||'',pid:w.get_pid(),isHidden:w.minimized})}))].map(s=>JSON.parse(s)))"#;
            if let Some(json_str) = gdbus_eval(js) {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&json_str) {
                    return Ok(val);
                }
            }
        }
        // X11 fallback: list unique processes with windows
        let output = Command::new("wmctrl").args(["-l", "-p"]).output().unwrap_or_else(|_| {
            Command::new("true").output().unwrap()
        });
        let text = String::from_utf8_lossy(&output.stdout);
        let mut seen = std::collections::HashMap::new();
        for line in text.lines() {
            let parts: Vec<&str> = line.splitn(5, char::is_whitespace).filter(|s| !s.is_empty()).collect();
            if parts.len() >= 3 {
                let pid = parts[2].parse::<i32>().unwrap_or(0);
                let proc_name = std::fs::read_to_string(format!("/proc/{pid}/comm"))
                    .unwrap_or_default().trim().to_string();
                if !proc_name.is_empty() && !seen.contains_key(&proc_name) {
                    seen.insert(proc_name.clone(), serde_json::json!({
                        "bundleId": proc_name, "displayName": proc_name, "pid": pid, "isHidden": false,
                    }));
                }
            }
        }
        Ok(serde_json::json!(seen.into_values().collect::<Vec<_>>()))
    }

    #[napi]
    pub fn hide_app(bundle_id: String) -> bool {
        if is_wayland() {
            let js = format!(
                r#"global.get_window_actors().map(a=>a.meta_window).filter(w=>(w.get_wm_class()||'').toLowerCase()==='{cls}'.toLowerCase()).forEach(w=>w.minimize());'ok'"#,
                cls = bundle_id.replace('\'', "\\'")
            );
            return gdbus_eval(&js).is_some();
        }
        let _ = Command::new("xdotool").args(["search", "--class", &bundle_id, "windowminimize"]).status();
        true
    }

    #[napi]
    pub fn unhide_app(bundle_id: String) -> bool {
        if is_wayland() {
            let js = format!(
                r#"let w=global.get_window_actors().map(a=>a.meta_window).find(w=>(w.get_wm_class()||'').toLowerCase()==='{cls}'.toLowerCase());if(w){{w.unminimize();w.activate(global.get_current_time());'true'}}else{{'false'}}"#,
                cls = bundle_id.replace('\'', "\\'")
            );
            return gdbus_eval(&js).map(|s| s == "true").unwrap_or(false);
        }
        let status = Command::new("wmctrl").args(["-x", "-a", &bundle_id]).status();
        status.map(|s| s.success()).unwrap_or(false)
    }
}

// ── macOS implementation ──────────────────────────────────────────────────────
#[cfg(target_os = "macos")]
mod macos {
    use napi_derive::napi;
    use objc::runtime::{Class, Object, BOOL, YES};
    use objc::{msg_send, sel, sel_impl};
    use std::ffi::{CStr, CString};

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

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRunLoopRunInMode(mode: *const std::ffi::c_void, seconds: f64, returnAfterSourceHandled: bool) -> i32;
        static kCFRunLoopDefaultMode: *const std::ffi::c_void;
    }

    fn drain_runloop() {
        unsafe {
            for _ in 0..4 {
                let result = CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.0, true);
                if result != 1 { break; }
            }
        }
    }

    #[napi(js_name = "drainRunloop")]
    pub fn drain_runloop_pub() { drain_runloop(); }

    #[napi]
    pub fn get_frontmost_app() -> napi::Result<serde_json::Value> {
        drain_runloop();
        unsafe {
            let ws = shared_workspace();
            let app: *mut Object = msg_send![ws, frontmostApplication];
            if app.is_null() { return Ok(serde_json::json!(null)); }
            let bid: *mut Object = msg_send![app, bundleIdentifier];
            let name: *mut Object = msg_send![app, localizedName];
            let pid: i32 = msg_send![app, processIdentifier];
            Ok(serde_json::json!({ "bundleId": nsstring_to_string(bid), "displayName": nsstring_to_string(name), "pid": pid }))
        }
    }

    #[napi]
    pub fn activate_app(bundle_id: String, timeout_ms: Option<i32>) -> napi::Result<serde_json::Value> {
        let timeout = timeout_ms.unwrap_or(2000) as u64;
        drain_runloop();
        unsafe {
            let ws = shared_workspace();
            let apps: *mut Object = msg_send![ws, runningApplications];
            let count: usize = msg_send![apps, count];
            let mut target: *mut Object = std::ptr::null_mut();
            for i in 0..count {
                let app: *mut Object = msg_send![apps, objectAtIndex: i];
                let bid: *mut Object = msg_send![app, bundleIdentifier];
                if let Some(b) = nsstring_to_string(bid) {
                    if b == bundle_id { target = app; break; }
                }
            }
            if target.is_null() {
                let bid_nsstr = nsstring_from_str(&bundle_id);
                if bid_nsstr.is_null() { return Err(napi::Error::from_reason("Invalid bundle_id")); }
                let url: *mut Object = msg_send![ws, URLForApplicationWithBundleIdentifier: bid_nsstr];
                if !url.is_null() {
                    let config_cls = Class::get("NSWorkspaceOpenConfiguration").unwrap();
                    let config: *mut Object = msg_send![config_cls, configuration];
                    let _: () = msg_send![ws, openApplicationAtURL: url configuration: config completionHandler: std::ptr::null::<Object>()];
                    std::thread::sleep(std::time::Duration::from_millis(timeout.min(2000)));
                }
                return Ok(serde_json::json!({ "activated": false, "reason": "not_running" }));
            }
            let _: BOOL = msg_send![target, activateWithOptions: 1u64];
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout);
            let mut activated = false;
            while std::time::Instant::now() < deadline {
                let front: *mut Object = msg_send![ws, frontmostApplication];
                let front_bid: *mut Object = msg_send![front, bundleIdentifier];
                if let Some(b) = nsstring_to_string(front_bid) {
                    if b == bundle_id { activated = true; break; }
                }
                std::thread::sleep(std::time::Duration::from_millis(30));
            }
            let name: *mut Object = msg_send![target, localizedName];
            Ok(serde_json::json!({ "bundleId": bundle_id, "displayName": nsstring_to_string(name), "activated": activated }))
        }
    }

    #[napi]
    pub fn list_running_apps() -> napi::Result<serde_json::Value> {
        drain_runloop();
        unsafe {
            let ws = shared_workspace();
            let apps: *mut Object = msg_send![ws, runningApplications];
            let count: usize = msg_send![apps, count];
            let mut result = Vec::new();
            for i in 0..count {
                let app: *mut Object = msg_send![apps, objectAtIndex: i];
                let policy: i64 = msg_send![app, activationPolicy];
                if policy != 0 { continue; }
                let bid: *mut Object = msg_send![app, bundleIdentifier];
                let name: *mut Object = msg_send![app, localizedName];
                let pid: i32 = msg_send![app, processIdentifier];
                let hidden: BOOL = msg_send![app, isHidden];
                result.push(serde_json::json!({ "bundleId": nsstring_to_string(bid), "displayName": nsstring_to_string(name), "pid": pid, "isHidden": hidden == YES }));
            }
            Ok(serde_json::json!(result))
        }
    }

    #[napi]
    pub fn prepare_display(target_bundle_id: String, keep_visible: Vec<String>) -> napi::Result<serde_json::Value> {
        drain_runloop();
        let mut hidden: Vec<String> = Vec::new();
        unsafe {
            let ws = shared_workspace();
            let apps: *mut Object = msg_send![ws, runningApplications];
            let count: usize = msg_send![apps, count];
            for i in 0..count {
                let app: *mut Object = msg_send![apps, objectAtIndex: i];
                let policy: i64 = msg_send![app, activationPolicy];
                if policy != 0 { continue; }
                let bid: *mut Object = msg_send![app, bundleIdentifier];
                let bid_str = match nsstring_to_string(bid) { Some(s) => s, None => continue };
                if bid_str == target_bundle_id { continue; }
                if keep_visible.iter().any(|k| k == &bid_str) { continue; }
                let already_hidden: BOOL = msg_send![app, isHidden];
                if already_hidden == YES { continue; }
                let _: BOOL = msg_send![app, hide];
                hidden.push(bid_str);
            }
        }
        Ok(serde_json::json!({ "targetBundleId": target_bundle_id, "hiddenBundleIds": hidden }))
    }

    #[napi]
    pub fn hide_app(bundle_id: String) -> napi::Result<bool> {
        unsafe {
            let ws = shared_workspace();
            let apps: *mut Object = msg_send![ws, runningApplications];
            let count: usize = msg_send![apps, count];
            let mut found = false;
            for i in 0..count {
                let app: *mut Object = msg_send![apps, objectAtIndex: i];
                let bid: *mut Object = msg_send![app, bundleIdentifier];
                if nsstring_to_string(bid).as_deref() == Some(&bundle_id) {
                    let _: BOOL = msg_send![app, hide];
                    found = true;
                }
            }
            Ok(found)
        }
    }

    #[napi]
    pub fn unhide_app(bundle_id: String) -> napi::Result<bool> {
        unsafe {
            let ws = shared_workspace();
            let apps: *mut Object = msg_send![ws, runningApplications];
            let count: usize = msg_send![apps, count];
            let mut found = false;
            for i in 0..count {
                let app: *mut Object = msg_send![apps, objectAtIndex: i];
                let bid: *mut Object = msg_send![app, bundleIdentifier];
                if nsstring_to_string(bid).as_deref() == Some(&bundle_id) {
                    let _: BOOL = msg_send![app, unhide];
                    found = true;
                }
            }
            Ok(found)
        }
    }

    fn nsstring_from_str(s: &str) -> *mut Object {
        unsafe {
            let cls = Class::get("NSString").unwrap();
            let Ok(cstr) = CString::new(s) else { return std::ptr::null_mut(); };
            msg_send![cls, stringWithUTF8String: cstr.as_ptr()]
        }
    }
}


// ── Windows implementation ───────────────────────────────────────────────────
#[cfg(target_os = "windows")]
mod win {
    use napi_derive::napi;
    use windows::Win32::Foundation::*;
    use windows::Win32::System::Diagnostics::ToolHelp::*;
    use windows::Win32::System::Threading::*;
    use windows::Win32::UI::WindowsAndMessaging::*;
    use std::collections::HashMap;

    /// drainRunloop is a no-op on Windows (no CFRunLoop).
    #[napi(js_name = "drainRunloop")]
    pub fn drain_runloop_pub() {}

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

    #[napi]
    pub fn get_frontmost_app() -> napi::Result<serde_json::Value> {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.0.is_null() { return Ok(serde_json::json!(null)); }
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            let name = process_name_for_pid(pid).unwrap_or_default();
            let mut title_buf = [0u16; 512];
            let len = GetWindowTextW(hwnd, &mut title_buf);
            let title = String::from_utf16_lossy(&title_buf[..len as usize]);
            Ok(serde_json::json!({
                "bundleId": name,
                "displayName": title,
                "pid": pid,
            }))
        }
    }

    #[napi]
    pub fn activate_app(bundle_id: String, timeout_ms: Option<i32>) -> napi::Result<serde_json::Value> {
        let timeout = timeout_ms.unwrap_or(2000) as u64;
        // bundle_id on Windows is a process name like "notepad.exe"
        let target_name = bundle_id.to_lowercase();

        unsafe {
            // Find a window belonging to this process
            let mut found_hwnd: HWND = HWND::default();
            let mut found_pid: u32 = 0;

            struct EnumData { target: String, hwnd: HWND, pid: u32 }
            let mut data = EnumData { target: target_name.clone(), hwnd: HWND::default(), pid: 0 };
            let ptr = LPARAM(&mut data as *mut EnumData as isize);

            unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
                let data = &mut *(lparam.0 as *mut EnumData);
                if !IsWindowVisible(hwnd).as_bool() { return TRUE; }
                let mut pid: u32 = 0;
                GetWindowThreadProcessId(hwnd, Some(&mut pid));
                if let Some(name) = super::win::process_name_for_pid(pid) {
                    if name.to_lowercase() == data.target || name.to_lowercase().trim_end_matches(".exe") == data.target.trim_end_matches(".exe") {
                        data.hwnd = hwnd;
                        data.pid = pid;
                        return FALSE; // stop
                    }
                }
                TRUE
            }

            let _ = EnumWindows(Some(cb), ptr);
            found_hwnd = data.hwnd;
            found_pid = data.pid;

            if found_hwnd.0.is_null() {
                return Ok(serde_json::json!({ "bundleId": bundle_id, "activated": false, "reason": "not_running" }));
            }

            // Restore if minimized
            if IsIconic(found_hwnd).as_bool() {
                let _ = ShowWindow(found_hwnd, SW_RESTORE);
                std::thread::sleep(std::time::Duration::from_millis(100));
            }

            // AttachThreadInput + SetForegroundWindow
            let fg_thread = GetWindowThreadProcessId(GetForegroundWindow(), None);
            let target_thread = GetWindowThreadProcessId(found_hwnd, None);
            if fg_thread != target_thread {
                AttachThreadInput(fg_thread, target_thread, true);
            }
            let _ = SetForegroundWindow(found_hwnd);
            let _ = BringWindowToTop(found_hwnd);
            if fg_thread != target_thread {
                AttachThreadInput(fg_thread, target_thread, false);
            }

            // Poll
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout);
            let mut activated = false;
            while std::time::Instant::now() < deadline {
                let fg = GetForegroundWindow();
                if fg == found_hwnd { activated = true; break; }
                let mut fg_pid: u32 = 0;
                GetWindowThreadProcessId(fg, Some(&mut fg_pid));
                if fg_pid == found_pid { activated = true; break; }
                std::thread::sleep(std::time::Duration::from_millis(30));
            }

            let mut title_buf = [0u16; 512];
            let len = GetWindowTextW(found_hwnd, &mut title_buf);
            let title = String::from_utf16_lossy(&title_buf[..len as usize]);

            Ok(serde_json::json!({ "bundleId": bundle_id, "displayName": title, "activated": activated }))
        }
    }

    #[napi]
    pub fn list_running_apps() -> napi::Result<serde_json::Value> {
        // Collect processes that have visible windows
        let mut apps: HashMap<u32, (String, bool)> = HashMap::new(); // pid -> (name, has_visible)

        unsafe {
            // First pass: find all visible windows and their PIDs
            struct WinData { pids: HashMap<u32, bool> }
            let mut wd = WinData { pids: HashMap::new() };
            let ptr = LPARAM(&mut wd as *mut WinData as isize);

            unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
                let data = &mut *(lparam.0 as *mut WinData);
                if !IsWindowVisible(hwnd).as_bool() { return TRUE; }
                // Skip tool windows
                let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
                if ex_style & WS_EX_TOOLWINDOW.0 != 0 { return TRUE; }
                let mut pid: u32 = 0;
                GetWindowThreadProcessId(hwnd, Some(&mut pid));
                let minimized = IsIconic(hwnd).as_bool();
                let entry = data.pids.entry(pid).or_insert(true);
                if !minimized { *entry = false; } // has at least one non-minimized
                TRUE
            }

            let _ = EnumWindows(Some(cb), ptr);

            let mut result = Vec::new();
            for (pid, all_minimized) in &wd.pids {
                if let Some(name) = process_name_for_pid(*pid) {
                    result.push(serde_json::json!({
                        "bundleId": name,
                        "displayName": name,
                        "pid": pid,
                        "isHidden": all_minimized,
                    }));
                }
            }
            Ok(serde_json::json!(result))
        }
    }

    #[napi]
    pub fn prepare_display(target_bundle_id: String, keep_visible: Vec<String>) -> napi::Result<serde_json::Value> {
        let target = target_bundle_id.to_lowercase();
        let keep: Vec<String> = keep_visible.iter().map(|s| s.to_lowercase()).collect();
        let mut hidden: Vec<String> = Vec::new();

        unsafe {
            struct MinData { target: String, keep: Vec<String>, hidden: Vec<String> }
            let mut data = MinData { target: target.clone(), keep, hidden: Vec::new() };
            let ptr = LPARAM(&mut data as *mut MinData as isize);

            unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
                let data = &mut *(lparam.0 as *mut MinData);
                if !IsWindowVisible(hwnd).as_bool() { return TRUE; }
                if IsIconic(hwnd).as_bool() { return TRUE; }
                let mut pid: u32 = 0;
                GetWindowThreadProcessId(hwnd, Some(&mut pid));
                if let Some(name) = super::win::process_name_for_pid(pid) {
                    let lower = name.to_lowercase();
                    if lower == data.target { return TRUE; }
                    if data.keep.iter().any(|k| k == &lower) { return TRUE; }
                    let _ = ShowWindow(hwnd, SW_MINIMIZE);
                    if !data.hidden.contains(&name) {
                        data.hidden.push(name);
                    }
                }
                TRUE
            }

            let _ = EnumWindows(Some(cb), ptr);
            hidden = data.hidden;
        }

        Ok(serde_json::json!({ "targetBundleId": target_bundle_id, "hiddenBundleIds": hidden }))
    }

    #[napi]
    pub fn hide_app(bundle_id: String) -> napi::Result<bool> {
        let target = bundle_id.to_lowercase();
        let mut found = false;
        unsafe {
            struct Data { target: String, found: bool }
            let mut data = Data { target, found: false };
            let ptr = LPARAM(&mut data as *mut Data as isize);

            unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
                let data = &mut *(lparam.0 as *mut Data);
                if !IsWindowVisible(hwnd).as_bool() { return TRUE; }
                let mut pid: u32 = 0;
                GetWindowThreadProcessId(hwnd, Some(&mut pid));
                if let Some(name) = super::win::process_name_for_pid(pid) {
                    if name.to_lowercase() == data.target || name.to_lowercase().trim_end_matches(".exe") == data.target.trim_end_matches(".exe") {
                        let _ = ShowWindow(hwnd, SW_MINIMIZE);
                        data.found = true;
                    }
                }
                TRUE
            }

            let _ = EnumWindows(Some(cb), ptr);
            found = data.found;
        }
        Ok(found)
    }

    #[napi]
    pub fn unhide_app(bundle_id: String) -> napi::Result<bool> {
        let target = bundle_id.to_lowercase();
        let mut found = false;
        unsafe {
            struct Data { target: String, found: bool }
            let mut data = Data { target, found: false };
            let ptr = LPARAM(&mut data as *mut Data as isize);

            unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
                let data = &mut *(lparam.0 as *mut Data);
                let mut pid: u32 = 0;
                GetWindowThreadProcessId(hwnd, Some(&mut pid));
                if let Some(name) = super::win::process_name_for_pid(pid) {
                    if name.to_lowercase() == data.target || name.to_lowercase().trim_end_matches(".exe") == data.target.trim_end_matches(".exe") {
                        if IsIconic(hwnd).as_bool() {
                            let _ = ShowWindow(hwnd, SW_RESTORE);
                            data.found = true;
                        }
                    }
                }
                TRUE
            }

            let _ = EnumWindows(Some(cb), ptr);
            found = data.found;
        }
        Ok(found)
    }
}
