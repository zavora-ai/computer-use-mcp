// ── macOS implementation ──────────────────────────────────────────────────────
#[cfg(target_os = "macos")]
mod macos {
    use core_graphics::display::CGShieldingWindowLevel;
    use napi_derive::napi;
    use objc::runtime::{Class, Object, BOOL, NO, YES};
    use objc::{msg_send, sel, sel_impl};
    use std::sync::Mutex;

    const POINTER_SIZE: f64 = 24.0;
    const COLLECTION_BEHAVIOR_ALL_SPACES: u64 = 1;
    const COLLECTION_BEHAVIOR_STATIONARY: u64 = 16;
    const COLLECTION_BEHAVIOR_IGNORES_CYCLE: u64 = 64;
    const COLLECTION_BEHAVIOR_FULL_SCREEN_AUXILIARY: u64 = 256;
    const NS_BACKING_STORE_BUFFERED: u64 = 2;
    const NS_NONACTIVATING_PANEL_MASK: u64 = 1 << 7;
    const NS_APPLICATION_ACTIVATION_POLICY_ACCESSORY: i64 = 1;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NSPoint {
        x: f64,
        y: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NSSize {
        width: f64,
        height: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NSRect {
        origin: NSPoint,
        size: NSSize,
    }

    #[derive(Clone, Copy)]
    struct OverlayState {
        panel: usize,
        x: f64,
        y: f64,
        visible: bool,
    }

    static OVERLAY: Mutex<Option<OverlayState>> = Mutex::new(None);

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRunLoopRunInMode(
            mode: *const std::ffi::c_void,
            seconds: f64,
            return_after_source_handled: bool,
        ) -> i32;
        static kCFRunLoopDefaultMode: *const std::ffi::c_void;
    }

    fn drain_runloop() {
        unsafe {
            for _ in 0..4 {
                let result = CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.0, true);
                if result != 1 {
                    break;
                }
            }
        }
    }

    fn panel_origin_for_pointer(x: f64, y: f64) -> NSPoint {
        unsafe {
            let screen_cls = Class::get("NSScreen").unwrap();
            let screen: *mut Object = msg_send![screen_cls, mainScreen];
            let frame: NSRect = msg_send![screen, frame];
            NSPoint {
                x: x - POINTER_SIZE / 2.0,
                y: frame.size.height - y - POINTER_SIZE / 2.0,
            }
        }
    }

    unsafe fn ensure_panel(x: f64, y: f64) -> napi::Result<*mut Object> {
        if let Some(state) = *OVERLAY.lock().unwrap() {
            return Ok(state.panel as *mut Object);
        }

        let app_cls = Class::get("NSApplication")
            .ok_or_else(|| napi::Error::from_reason("NSApplication class not found"))?;
        let app: *mut Object = msg_send![app_cls, sharedApplication];
        let _: BOOL = msg_send![
            app,
            setActivationPolicy: NS_APPLICATION_ACTIVATION_POLICY_ACCESSORY
        ];

        let origin = panel_origin_for_pointer(x, y);
        let rect = NSRect {
            origin,
            size: NSSize {
                width: POINTER_SIZE,
                height: POINTER_SIZE,
            },
        };

        let panel_cls = Class::get("NSPanel")
            .ok_or_else(|| napi::Error::from_reason("NSPanel class not found"))?;
        let panel: *mut Object = msg_send![panel_cls, alloc];
        let panel: *mut Object = msg_send![
            panel,
            initWithContentRect: rect
            styleMask: NS_NONACTIVATING_PANEL_MASK
            backing: NS_BACKING_STORE_BUFFERED
            defer: NO
        ];
        if panel.is_null() {
            return Err(napi::Error::from_reason("failed to create NSPanel overlay"));
        }

        let clear_color: *mut Object = msg_send![Class::get("NSColor").unwrap(), clearColor];
        let _: () = msg_send![panel, setOpaque: NO];
        let _: () = msg_send![panel, setBackgroundColor: clear_color];
        let _: () = msg_send![panel, setIgnoresMouseEvents: YES];
        let _: () = msg_send![panel, setReleasedWhenClosed: NO];
        let _: () = msg_send![panel, setHidesOnDeactivate: NO];
        let _: () = msg_send![panel, setCanHide: NO];
        let behavior = COLLECTION_BEHAVIOR_ALL_SPACES
            | COLLECTION_BEHAVIOR_STATIONARY
            | COLLECTION_BEHAVIOR_IGNORES_CYCLE
            | COLLECTION_BEHAVIOR_FULL_SCREEN_AUXILIARY;
        let _: () = msg_send![panel, setCollectionBehavior: behavior];
        let level = CGShieldingWindowLevel() as i64;
        let _: () = msg_send![panel, setLevel: level];

        let view_cls = Class::get("NSView").unwrap();
        let view: *mut Object = msg_send![view_cls, alloc];
        let view: *mut Object = msg_send![
            view,
            initWithFrame: NSRect {
                origin: NSPoint { x: 0.0, y: 0.0 },
                size: NSSize {
                    width: POINTER_SIZE,
                    height: POINTER_SIZE,
                },
            }
        ];
        let _: () = msg_send![view, setWantsLayer: YES];
        let layer: *mut Object = msg_send![view, layer];
        let pointer_color: *mut Object = msg_send![
            Class::get("NSColor").unwrap(),
            colorWithCalibratedRed: 0.0f64
            green: 0.72f64
            blue: 1.0f64
            alpha: 0.92f64
        ];
        let border_color: *mut Object = msg_send![Class::get("NSColor").unwrap(), whiteColor];
        let pointer_cg_color: *mut std::ffi::c_void = msg_send![pointer_color, CGColor];
        let border_cg_color: *mut std::ffi::c_void = msg_send![border_color, CGColor];
        let _: () = msg_send![layer, setBackgroundColor: pointer_cg_color];
        let _: () = msg_send![layer, setCornerRadius: POINTER_SIZE / 2.0];
        let _: () = msg_send![layer, setBorderWidth: 2.0f64];
        let _: () = msg_send![layer, setBorderColor: border_cg_color];
        let _: () = msg_send![panel, setContentView: view];

        *OVERLAY.lock().unwrap() = Some(OverlayState {
            panel: panel as usize,
            x,
            y,
            visible: false,
        });
        Ok(panel)
    }

    unsafe fn set_panel_position(panel: *mut Object, x: f64, y: f64) {
        let origin = panel_origin_for_pointer(x, y);
        let _: () = msg_send![panel, setFrameOrigin: origin];
    }

    fn status_json() -> serde_json::Value {
        let state = *OVERLAY.lock().unwrap();
        match state {
            Some(s) => serde_json::json!({
                "supported": true,
                "native": true,
                "visible": s.visible,
                "x": s.x,
                "y": s.y,
                "shape": "dot",
                "nonActivating": true,
                "alwaysOnTop": true,
                "clickThrough": true
            }),
            None => serde_json::json!({
                "supported": true,
                "native": true,
                "visible": false,
                "shape": "dot",
                "nonActivating": true,
                "alwaysOnTop": true,
                "clickThrough": true
            }),
        }
    }

    #[napi]
    pub fn agent_pointer_overlay_show(x: f64, y: f64) -> napi::Result<serde_json::Value> {
        unsafe {
            let panel = ensure_panel(x, y)?;
            set_panel_position(panel, x, y);
            let _: () = msg_send![panel, orderFrontRegardless];
            drain_runloop();
        }
        {
            let mut guard = OVERLAY.lock().unwrap();
            if let Some(mut state) = *guard {
                state.x = x;
                state.y = y;
                state.visible = true;
                *guard = Some(state);
            }
        }
        Ok(status_json())
    }

    #[napi]
    pub fn agent_pointer_overlay_move(x: f64, y: f64) -> napi::Result<serde_json::Value> {
        unsafe {
            let panel = ensure_panel(x, y)?;
            set_panel_position(panel, x, y);
            let visible = OVERLAY.lock().unwrap().map(|s| s.visible).unwrap_or(false);
            if visible {
                let _: () = msg_send![panel, orderFrontRegardless];
            }
            drain_runloop();
        }
        {
            let mut guard = OVERLAY.lock().unwrap();
            if let Some(mut state) = *guard {
                state.x = x;
                state.y = y;
                *guard = Some(state);
            }
        }
        Ok(status_json())
    }

    #[napi]
    pub fn agent_pointer_overlay_hide() -> napi::Result<serde_json::Value> {
        let panel = OVERLAY.lock().unwrap().map(|s| s.panel as *mut Object);
        if let Some(panel) = panel {
            unsafe {
                let _: () = msg_send![panel, orderOut: std::ptr::null::<Object>()];
                drain_runloop();
            }
        }
        {
            let mut guard = OVERLAY.lock().unwrap();
            if let Some(mut state) = *guard {
                state.visible = false;
                *guard = Some(state);
            }
        }
        Ok(status_json())
    }

    #[napi]
    pub fn agent_pointer_overlay_status() -> napi::Result<serde_json::Value> {
        Ok(status_json())
    }
}

// ── Windows implementation ───────────────────────────────────────────────────
#[cfg(target_os = "windows")]
mod win {
    use napi_derive::napi;
    use std::sync::{Mutex, Once};
    use std::time::{Duration, Instant};
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::*;
    use windows::Win32::Graphics::Gdi::*;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::*;

    const POINTER_SIZE: i32 = 24;
    const COLOR_KEY: COLORREF = COLORREF(0x00ff00ff);
    static START: Once = Once::new();
    static OVERLAY: Mutex<OverlayState> = Mutex::new(OverlayState {
        hwnd: 0,
        x: 0,
        y: 0,
        visible: false,
    });

    #[derive(Clone, Copy)]
    struct OverlayState {
        hwnd: isize,
        x: i32,
        y: i32,
        visible: bool,
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe extern "system" fn overlay_wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            WM_NCHITTEST => LRESULT(HTTRANSPARENT as isize),
            WM_MOUSEACTIVATE => LRESULT(MA_NOACTIVATE as isize),
            WM_ERASEBKGND => LRESULT(1),
            WM_PAINT => {
                let mut ps = PAINTSTRUCT::default();
                let hdc = BeginPaint(hwnd, &mut ps);
                let bg = CreateSolidBrush(COLOR_KEY);
                let rect = RECT {
                    left: 0,
                    top: 0,
                    right: POINTER_SIZE,
                    bottom: POINTER_SIZE,
                };
                FillRect(hdc, &rect, bg);
                let _ = DeleteObject(bg);

                let brush = CreateSolidBrush(COLORREF(0x00ffd700));
                let pen = CreatePen(PS_SOLID, 2, COLORREF(0x00ffffff));
                let old_brush = SelectObject(hdc, brush);
                let old_pen = SelectObject(hdc, pen);
                Ellipse(hdc, 2, 2, POINTER_SIZE - 2, POINTER_SIZE - 2);
                SelectObject(hdc, old_pen);
                SelectObject(hdc, old_brush);
                let _ = DeleteObject(pen);
                let _ = DeleteObject(brush);
                EndPaint(hwnd, &ps);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }

    fn start_overlay_thread() {
        START.call_once(|| {
            std::thread::spawn(|| unsafe {
                let class_name = wide("ComputerUseMcpAgentPointerOverlay");
                let title = wide("Agent Pointer Overlay");
                let module = GetModuleHandleW(None).unwrap_or_default();
                let hinstance = HINSTANCE(module.0);
                let cursor = LoadCursorW(None, IDC_ARROW).unwrap_or_default();
                let wc = WNDCLASSW {
                    hCursor: cursor,
                    hInstance: hinstance,
                    lpszClassName: PCWSTR(class_name.as_ptr()),
                    lpfnWndProc: Some(overlay_wnd_proc),
                    ..Default::default()
                };
                RegisterClassW(&wc);
                let hwnd = CreateWindowExW(
                    WS_EX_TOPMOST
                        | WS_EX_LAYERED
                        | WS_EX_TRANSPARENT
                        | WS_EX_TOOLWINDOW
                        | WS_EX_NOACTIVATE,
                    PCWSTR(class_name.as_ptr()),
                    PCWSTR(title.as_ptr()),
                    WS_POPUP,
                    0,
                    0,
                    POINTER_SIZE,
                    POINTER_SIZE,
                    None,
                    None,
                    hinstance,
                    None,
                );
                if hwnd.0 != 0 {
                    SetLayeredWindowAttributes(hwnd, COLOR_KEY, 0, LWA_COLORKEY);
                    ShowWindow(hwnd, SW_HIDE);
                    OVERLAY.lock().unwrap().hwnd = hwnd.0 as isize;
                }

                let mut msg = MSG::default();
                while GetMessageW(&mut msg, None, 0, 0).into() {
                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            });
        });
    }

    fn hwnd() -> napi::Result<HWND> {
        start_overlay_thread();
        let deadline = Instant::now() + Duration::from_millis(750);
        loop {
            let value = OVERLAY.lock().unwrap().hwnd;
            if value != 0 {
                return Ok(HWND(value as *mut _));
            }
            if Instant::now() >= deadline {
                return Err(napi::Error::from_reason("overlay HWND was not created"));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn status_json() -> serde_json::Value {
        let state = *OVERLAY.lock().unwrap();
        serde_json::json!({
            "supported": true,
            "native": true,
            "visible": state.visible,
            "x": state.x,
            "y": state.y,
            "shape": "dot",
            "nonActivating": true,
            "alwaysOnTop": true,
            "clickThrough": true
        })
    }

    fn set_overlay_pos(x: f64, y: f64, visible: bool) -> napi::Result<serde_json::Value> {
        let hwnd = hwnd()?;
        let xi = x.round() as i32;
        let yi = y.round() as i32;
        unsafe {
            SetWindowPos(
                hwnd,
                HWND_TOPMOST,
                xi - POINTER_SIZE / 2,
                yi - POINTER_SIZE / 2,
                POINTER_SIZE,
                POINTER_SIZE,
                SWP_NOACTIVATE
                    | if visible {
                        SWP_SHOWWINDOW
                    } else {
                        SWP_NOZORDER
                    },
            );
            InvalidateRect(hwnd, None, BOOL(1));
            if visible {
                ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            }
        }
        let mut state = OVERLAY.lock().unwrap();
        state.x = xi;
        state.y = yi;
        state.visible = visible || state.visible;
        Ok(status_json())
    }

    #[napi]
    pub fn agent_pointer_overlay_show(x: f64, y: f64) -> napi::Result<serde_json::Value> {
        set_overlay_pos(x, y, true)
    }

    #[napi]
    pub fn agent_pointer_overlay_move(x: f64, y: f64) -> napi::Result<serde_json::Value> {
        let visible = OVERLAY.lock().unwrap().visible;
        set_overlay_pos(x, y, visible)
    }

    #[napi]
    pub fn agent_pointer_overlay_hide() -> napi::Result<serde_json::Value> {
        let hwnd = hwnd()?;
        unsafe {
            ShowWindow(hwnd, SW_HIDE);
        }
        OVERLAY.lock().unwrap().visible = false;
        Ok(status_json())
    }

    #[napi]
    pub fn agent_pointer_overlay_status() -> napi::Result<serde_json::Value> {
        start_overlay_thread();
        Ok(status_json())
    }
}
