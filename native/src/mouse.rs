// ── Linux implementation ──────────────────────────────────────────────────────
#[cfg(target_os = "linux")]
mod linux {
    use napi_derive::napi;
    use std::process::Command;
    use std::sync::OnceLock;

    static IS_WAYLAND: OnceLock<bool> = OnceLock::new();

    fn is_wayland() -> bool {
        *IS_WAYLAND.get_or_init(|| {
            std::env::var("XDG_SESSION_TYPE")
                .map(|v| v == "wayland")
                .unwrap_or(false)
        })
    }

    fn ydotool_available() -> bool {
        Command::new("ydotool").arg("--help").output().is_ok()
    }

    mod x11_impl {
        use std::ptr;
        use x11::xlib::*;
        use x11::xtest::*;

        pub unsafe fn open_display() -> *mut Display {
            XOpenDisplay(ptr::null())
        }

        pub fn mouse_move(x: i32, y: i32) {
            unsafe {
                let dpy = open_display();
                if dpy.is_null() {
                    return;
                }
                XWarpPointer(dpy, 0, XDefaultRootWindow(dpy), 0, 0, 0, 0, x, y);
                XFlush(dpy);
                XCloseDisplay(dpy);
            }
        }

        pub fn mouse_click(x: i32, y: i32, btn: u32, count: i32) {
            unsafe {
                let dpy = open_display();
                if dpy.is_null() {
                    return;
                }
                XWarpPointer(dpy, 0, XDefaultRootWindow(dpy), 0, 0, 0, 0, x, y);
                XFlush(dpy);
                std::thread::sleep(std::time::Duration::from_millis(10));
                for i in 0..count {
                    XTestFakeButtonEvent(dpy, btn, 1, 0);
                    XTestFakeButtonEvent(dpy, btn, 0, 0);
                    if i < count - 1 {
                        XFlush(dpy);
                        std::thread::sleep(std::time::Duration::from_millis(30));
                    }
                }
                XFlush(dpy);
                XCloseDisplay(dpy);
            }
        }

        pub fn mouse_button(press: bool, x: i32, y: i32) {
            unsafe {
                let dpy = open_display();
                if dpy.is_null() {
                    return;
                }
                XWarpPointer(dpy, 0, XDefaultRootWindow(dpy), 0, 0, 0, 0, x, y);
                XTestFakeButtonEvent(dpy, 1, if press { 1 } else { 0 }, 0);
                XFlush(dpy);
                XCloseDisplay(dpy);
            }
        }

        pub fn mouse_scroll(dy: i32, dx: i32) {
            unsafe {
                let dpy = open_display();
                if dpy.is_null() {
                    return;
                }
                if dy != 0 {
                    let btn = if dy > 0 { 5u32 } else { 4 };
                    for _ in 0..dy.unsigned_abs() {
                        XTestFakeButtonEvent(dpy, btn, 1, 0);
                        XTestFakeButtonEvent(dpy, btn, 0, 0);
                    }
                }
                if dx != 0 {
                    let btn = if dx > 0 { 7u32 } else { 6 };
                    for _ in 0..dx.unsigned_abs() {
                        XTestFakeButtonEvent(dpy, btn, 1, 0);
                        XTestFakeButtonEvent(dpy, btn, 0, 0);
                    }
                }
                XFlush(dpy);
                XCloseDisplay(dpy);
            }
        }

        pub fn cursor_position() -> (i32, i32) {
            unsafe {
                let dpy = open_display();
                if dpy.is_null() {
                    return (0, 0);
                }
                let root = XDefaultRootWindow(dpy);
                let mut root_ret = 0u64;
                let mut child_ret = 0u64;
                let mut rx = 0i32;
                let mut ry = 0i32;
                let mut wx = 0i32;
                let mut wy = 0i32;
                let mut mask = 0u32;
                XQueryPointer(
                    dpy,
                    root,
                    &mut root_ret,
                    &mut child_ret,
                    &mut rx,
                    &mut ry,
                    &mut wx,
                    &mut wy,
                    &mut mask,
                );
                XCloseDisplay(dpy);
                (rx, ry)
            }
        }
    }

    mod wayland_impl {
        use std::process::Command;

        pub fn mouse_move(x: i32, y: i32) {
            let _ = Command::new("ydotool")
                .args([
                    "mousemove",
                    "--absolute",
                    "-x",
                    &x.to_string(),
                    "-y",
                    &y.to_string(),
                ])
                .status();
        }

        pub fn mouse_click(x: i32, y: i32, btn: u32, count: i32) {
            // Move first
            mouse_move(x, y);
            std::thread::sleep(std::time::Duration::from_millis(10));
            // ydotool button codes: 0x00=left, 0x01=right, 0x02=middle
            let ydotool_btn = match btn {
                1 => "0x00",
                2 => "0x02",
                3 => "0x01",
                _ => "0x00",
            };
            for i in 0..count {
                let _ = Command::new("ydotool")
                    .args(["click", ydotool_btn])
                    .status();
                if i < count - 1 {
                    std::thread::sleep(std::time::Duration::from_millis(30));
                }
            }
        }

        pub fn mouse_button(press: bool, x: i32, y: i32) {
            mouse_move(x, y);
            // ydotool click with --down or --up
            if press {
                let _ = Command::new("ydotool")
                    .args(["click", "--down", "0x00"])
                    .status();
            } else {
                let _ = Command::new("ydotool")
                    .args(["click", "--up", "0x00"])
                    .status();
            }
        }

        pub fn mouse_scroll(dy: i32, dx: i32) {
            if dy != 0 {
                // Negative = scroll up in ydotool
                let _ = Command::new("ydotool")
                    .args([
                        "mousemove",
                        "--wheel",
                        "--",
                        "-x",
                        "0",
                        "-y",
                        &(-dy * 15).to_string(),
                    ])
                    .status();
            }
            if dx != 0 {
                let _ = Command::new("ydotool")
                    .args([
                        "mousemove",
                        "--wheel",
                        "--",
                        "-x",
                        &(dx * 15).to_string(),
                        "-y",
                        "0",
                    ])
                    .status();
            }
        }

        pub fn cursor_position() -> (i32, i32) {
            // Wayland doesn't expose cursor position easily; fall back to X11 via XWayland
            super::x11_impl::cursor_position()
        }
    }

    #[napi]
    pub fn mouse_move(x: f64, y: f64) {
        if crate::activity::emergency_stop_active() {
            return;
        }
        if is_wayland() && ydotool_available() {
            wayland_impl::mouse_move(x as i32, y as i32);
        } else {
            x11_impl::mouse_move(x as i32, y as i32);
        }
    }

    #[napi]
    pub fn mouse_click(x: f64, y: f64, button: String, count: i32) -> napi::Result<()> {
        crate::activity::ensure_not_emergency_stopped()?;
        let btn = match button.as_str() {
            "left" => 1u32,
            "middle" => 2,
            "right" => 3,
            _ => {
                return Err(napi::Error::from_reason(format!(
                    "Invalid button: {button}"
                )))
            }
        };
        if is_wayland() && ydotool_available() {
            wayland_impl::mouse_click(x as i32, y as i32, btn, count);
        } else {
            x11_impl::mouse_click(x as i32, y as i32, btn, count);
        }
        Ok(())
    }

    #[napi]
    pub fn mouse_button(action: String, x: f64, y: f64) -> napi::Result<()> {
        crate::activity::ensure_not_emergency_stopped()?;
        let press = match action.as_str() {
            "press" => true,
            "release" => false,
            _ => {
                return Err(napi::Error::from_reason(format!(
                    "Invalid action: {action}"
                )))
            }
        };
        if is_wayland() && ydotool_available() {
            wayland_impl::mouse_button(press, x as i32, y as i32);
        } else {
            x11_impl::mouse_button(press, x as i32, y as i32);
        }
        Ok(())
    }

    #[napi]
    pub fn mouse_scroll(dy: i32, dx: i32) {
        if crate::activity::emergency_stop_active() {
            return;
        }
        if is_wayland() && ydotool_available() {
            wayland_impl::mouse_scroll(dy, dx);
        } else {
            x11_impl::mouse_scroll(dy, dx);
        }
    }

    #[napi]
    pub fn mouse_drag(x: f64, y: f64) {
        if crate::activity::emergency_stop_active() {
            return;
        }
        if is_wayland() && ydotool_available() {
            wayland_impl::mouse_move(x as i32, y as i32);
        } else {
            x11_impl::mouse_move(x as i32, y as i32);
        }
    }

    #[napi]
    pub fn cursor_position() -> napi::Result<serde_json::Value> {
        let (rx, ry) = if is_wayland() && ydotool_available() {
            wayland_impl::cursor_position()
        } else {
            x11_impl::cursor_position()
        };
        Ok(serde_json::json!({"x": rx, "y": ry}))
    }
}

// ── macOS implementation ──────────────────────────────────────────────────────
#[cfg(target_os = "macos")]
mod macos {
    use core_graphics::event::{
        CGEvent, CGEventTapLocation, CGEventType, CGMouseButton, EventField, ScrollEventUnit,
    };
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    use core_graphics::geometry::CGPoint;
    use napi_derive::napi;
    use std::sync::atomic::{AtomicBool, Ordering};

    static AGENT_LEFT_HELD: AtomicBool = AtomicBool::new(false);

    fn source() -> CGEventSource {
        // Keep synthetic state out of the HID-only physical-user activity
        // clock used by the v8 lease monitor.
        CGEventSource::new(CGEventSourceStateID::Private).unwrap()
    }

    fn post(event: CGEvent) {
        event.post(CGEventTapLocation::HID);
    }

    #[napi]
    pub fn mouse_move(x: f64, y: f64) {
        if crate::activity::emergency_stop_active() {
            return;
        }
        let point = CGPoint::new(x, y);
        let event = CGEvent::new_mouse_event(
            source(),
            CGEventType::MouseMoved,
            point,
            CGMouseButton::Left,
        )
        .unwrap();
        post(event);
    }

    #[napi]
    pub fn mouse_click(x: f64, y: f64, button: String, count: i32) -> napi::Result<()> {
        crate::activity::ensure_not_emergency_stopped()?;
        let point = CGPoint::new(x, y);
        let (btn, down_type, up_type) = match button.as_str() {
            "left" => (
                CGMouseButton::Left,
                CGEventType::LeftMouseDown,
                CGEventType::LeftMouseUp,
            ),
            "right" => (
                CGMouseButton::Right,
                CGEventType::RightMouseDown,
                CGEventType::RightMouseUp,
            ),
            "middle" => (
                CGMouseButton::Center,
                CGEventType::OtherMouseDown,
                CGEventType::OtherMouseUp,
            ),
            _ => {
                return Err(napi::Error::from_reason(format!(
                    "Invalid button: {button}, expected left/right/middle"
                )))
            }
        };

        let move_evt = CGEvent::new_mouse_event(
            source(),
            CGEventType::MouseMoved,
            point,
            CGMouseButton::Left,
        )
        .unwrap();
        post(move_evt);
        std::thread::sleep(std::time::Duration::from_millis(15));

        for i in 1..=count {
            crate::activity::ensure_not_emergency_stopped()?;
            let down = CGEvent::new_mouse_event(source(), down_type, point, btn).unwrap();
            down.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, i as i64);
            post(down);
            let up = CGEvent::new_mouse_event(source(), up_type, point, btn).unwrap();
            up.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, i as i64);
            post(up);
            if i < count {
                std::thread::sleep(std::time::Duration::from_millis(30));
            }
        }
        Ok(())
    }

    #[napi]
    pub fn mouse_button(action: String, x: f64, y: f64) -> napi::Result<()> {
        crate::activity::ensure_not_emergency_stopped()?;
        let point = CGPoint::new(x, y);
        let evt_type = match action.as_str() {
            "press" => CGEventType::LeftMouseDown,
            "release" => CGEventType::LeftMouseUp,
            _ => {
                return Err(napi::Error::from_reason(format!(
                    "Invalid action: {action}, expected 'press' or 'release'"
                )))
            }
        };
        let event =
            CGEvent::new_mouse_event(source(), evt_type, point, CGMouseButton::Left).unwrap();
        post(event);
        AGENT_LEFT_HELD.store(action == "press", Ordering::Release);
        Ok(())
    }

    pub(crate) fn release_agent_held_buttons() {
        if !AGENT_LEFT_HELD.swap(false, Ordering::AcqRel) {
            return;
        }
        let location = CGEvent::new(source())
            .map(|event| event.location())
            .unwrap_or_default();
        if let Ok(event) = CGEvent::new_mouse_event(
            source(),
            CGEventType::LeftMouseUp,
            location,
            CGMouseButton::Left,
        ) {
            post(event);
        }
    }

    #[napi]
    pub fn mouse_scroll(dy: i32, dx: i32) {
        if crate::activity::emergency_stop_active() {
            return;
        }
        if let Ok(event) = CGEvent::new_scroll_event(source(), ScrollEventUnit::LINE, 2, dy, dx, 0)
        {
            post(event);
        }
    }

    #[napi]
    pub fn mouse_drag(x: f64, y: f64) {
        if crate::activity::emergency_stop_active() {
            return;
        }
        let point = CGPoint::new(x, y);
        let event = CGEvent::new_mouse_event(
            source(),
            CGEventType::LeftMouseDragged,
            point,
            CGMouseButton::Left,
        )
        .unwrap();
        post(event);
    }

    #[napi]
    pub fn cursor_position() -> napi::Result<serde_json::Value> {
        let event = CGEvent::new(source()).unwrap();
        let loc = event.location();
        Ok(serde_json::json!({ "x": loc.x as i32, "y": loc.y as i32 }))
    }
}

// ── Windows implementation ───────────────────────────────────────────────────
#[cfg(target_os = "windows")]
mod win {
    use napi_derive::napi;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;
    use windows::Win32::UI::Input::KeyboardAndMouse::*;

    static AGENT_LEFT_HELD: AtomicBool = AtomicBool::new(false);
    use windows::Win32::UI::WindowsAndMessaging::*;

    fn screen_size() -> (i32, i32) {
        unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) }
    }

    fn to_absolute(x: f64, y: f64) -> (i32, i32) {
        let (sw, sh) = screen_size();
        let ax = ((x * 65535.0) / sw as f64) as i32;
        let ay = ((y * 65535.0) / sh as f64) as i32;
        (ax, ay)
    }

    fn send_mouse(dx: i32, dy: i32, flags: MOUSE_EVENT_FLAGS, data: i32) {
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx,
                    dy,
                    mouseData: data as u32,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        unsafe {
            SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
        }
    }

    #[napi]
    pub fn mouse_move(x: f64, y: f64) {
        if crate::activity::emergency_stop_active() {
            return;
        }
        let (ax, ay) = to_absolute(x, y);
        send_mouse(ax, ay, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, 0);
    }

    #[napi]
    pub fn mouse_click(x: f64, y: f64, button: String, count: i32) -> napi::Result<()> {
        crate::activity::ensure_not_emergency_stopped()?;
        let (ax, ay) = to_absolute(x, y);
        // Move first, settle
        send_mouse(ax, ay, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, 0);
        std::thread::sleep(Duration::from_millis(10));

        let (down, up) = match button.as_str() {
            "left" => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
            "right" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
            "middle" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
            _ => {
                return Err(napi::Error::from_reason(format!(
                    "Invalid button: {button}, expected left/right/middle"
                )))
            }
        };

        for i in 0..count {
            crate::activity::ensure_not_emergency_stopped()?;
            send_mouse(ax, ay, down | MOUSEEVENTF_ABSOLUTE, 0);
            send_mouse(ax, ay, up | MOUSEEVENTF_ABSOLUTE, 0);
            if i < count - 1 {
                std::thread::sleep(Duration::from_millis(30));
            }
        }
        Ok(())
    }

    #[napi]
    pub fn mouse_button(action: String, x: f64, y: f64) -> napi::Result<()> {
        crate::activity::ensure_not_emergency_stopped()?;
        let (ax, ay) = to_absolute(x, y);
        let flag = match action.as_str() {
            "press" => MOUSEEVENTF_LEFTDOWN,
            "release" => MOUSEEVENTF_LEFTUP,
            _ => {
                return Err(napi::Error::from_reason(format!(
                    "Invalid action: {action}, expected 'press' or 'release'"
                )))
            }
        };
        send_mouse(ax, ay, flag | MOUSEEVENTF_ABSOLUTE, 0);
        AGENT_LEFT_HELD.store(action == "press", Ordering::Release);
        Ok(())
    }

    pub(crate) fn release_agent_held_buttons() {
        if AGENT_LEFT_HELD.swap(false, Ordering::AcqRel) {
            send_mouse(0, 0, MOUSEEVENTF_LEFTUP, 0);
        }
    }

    #[napi]
    pub fn mouse_scroll(dy: i32, dx: i32) {
        if crate::activity::emergency_stop_active() {
            return;
        }
        // Vertical scroll
        if dy != 0 {
            send_mouse(0, 0, MOUSEEVENTF_WHEEL, -dy * 120);
        }
        // Horizontal scroll
        if dx != 0 {
            send_mouse(0, 0, MOUSEEVENTF_HWHEEL, dx * 120);
        }
    }

    #[napi]
    pub fn mouse_drag(x: f64, y: f64) {
        if crate::activity::emergency_stop_active() {
            return;
        }
        let (ax, ay) = to_absolute(x, y);
        send_mouse(ax, ay, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, 0);
    }

    #[napi]
    pub fn cursor_position() -> napi::Result<serde_json::Value> {
        use windows::Win32::Foundation::POINT;
        let mut pt = POINT { x: 0, y: 0 };
        unsafe {
            let _ = GetCursorPos(&mut pt);
        }
        Ok(serde_json::json!({ "x": pt.x, "y": pt.y }))
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn release_agent_held_buttons() {
    macos::release_agent_held_buttons();
}

#[cfg(target_os = "windows")]
pub(crate) fn release_agent_held_buttons() {
    win::release_agent_held_buttons();
}

#[cfg(target_os = "linux")]
pub(crate) fn release_agent_held_buttons() {}
