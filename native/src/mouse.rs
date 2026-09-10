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

        pub fn mouse_click(x: i32, y: i32, btn: u32, count: i32, additive: bool) {
            unsafe {
                let dpy = open_display();
                if dpy.is_null() {
                    return;
                }
                XWarpPointer(dpy, 0, XDefaultRootWindow(dpy), 0, 0, 0, 0, x, y);
                XFlush(dpy);
                std::thread::sleep(std::time::Duration::from_millis(10));
                let ctrl = XKeysymToKeycode(dpy, 0xffe3);
                // c_char is signed on x86_64 Linux and unsigned on aarch64, so the
                // element type has to come from the platform rather than be assumed.
                let mut keymap = [0 as std::os::raw::c_char; 32];
                XQueryKeymap(dpy, keymap.as_mut_ptr());
                let already_held = (keymap[(ctrl / 8) as usize] as u8 & (1 << (ctrl % 8))) != 0;
                if additive && !already_held { XTestFakeKeyEvent(dpy, ctrl as u32, 1, 0); }
                for i in 0..count {
                    XTestFakeButtonEvent(dpy, btn, 1, 0);
                    XTestFakeButtonEvent(dpy, btn, 0, 0);
                    if i < count - 1 {
                        XFlush(dpy);
                        std::thread::sleep(std::time::Duration::from_millis(30));
                    }
                }
                if additive && !already_held { XTestFakeKeyEvent(dpy, ctrl as u32, 0, 0); }
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

        /// Press, drag or release a chosen button, optionally holding modifiers.
        ///
        /// `which` is 0 press, 1 drag, 2 release. Modifiers are pressed before the
        /// button event and released after it; a caller holding them across a whole
        /// path passes them on every call, which X11 coalesces harmlessly.
        pub fn pointer_event(x: i32, y: i32, btn: u32, keysyms: &[u64], which: u8) {
            unsafe {
                let dpy = open_display();
                if dpy.is_null() {
                    return;
                }
                let codes: Vec<u32> = keysyms
                    .iter()
                    .map(|sym| XKeysymToKeycode(dpy, *sym) as u32)
                    .filter(|code| *code != 0)
                    .collect();
                XWarpPointer(dpy, 0, XDefaultRootWindow(dpy), 0, 0, 0, 0, x, y);
                if which != 1 {
                    for code in &codes {
                        XTestFakeKeyEvent(dpy, *code, 1, 0);
                    }
                }
                match which {
                    0 => { XTestFakeButtonEvent(dpy, btn, 1, 0); }
                    2 => { XTestFakeButtonEvent(dpy, btn, 0, 0); }
                    // A drag is motion only: the button is already held.
                    _ => {}
                }
                if which != 1 {
                    for code in codes.iter().rev() {
                        XTestFakeKeyEvent(dpy, *code, 0, 0);
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
        mouse_click_impl(x, y, button, count, false)
    }

    #[napi]
    pub fn mouse_click_additive(x: f64, y: f64, button: String, count: i32) -> napi::Result<()> {
        mouse_click_impl(x, y, button, count, true)
    }


    #[napi]
    pub fn mouse_press(x: f64, y: f64, button: String, modifiers: Vec<String>) -> napi::Result<()> {
        pointer_event(x, y, &button, &modifiers, 0)
    }

    #[napi]
    pub fn mouse_drag_to(x: f64, y: f64, button: String, modifiers: Vec<String>) -> napi::Result<()> {
        pointer_event(x, y, &button, &modifiers, 1)
    }

    #[napi]
    pub fn mouse_release(x: f64, y: f64, button: String, modifiers: Vec<String>) -> napi::Result<()> {
        pointer_event(x, y, &button, &modifiers, 2)
    }

    fn x11_button(button: &str) -> napi::Result<u32> {
        match button {
            "left" => Ok(1),
            "middle" => Ok(2),
            "right" => Ok(3),
            other => Err(napi::Error::from_reason(format!(
                "Invalid button: {other}, expected 'left', 'middle' or 'right'"
            ))),
        }
    }

    /// X11 keysyms for the modifiers a pointer gesture can hold.
    fn x11_modifier_keysym(modifier: &str) -> napi::Result<u64> {
        match modifier {
            "shift" => Ok(0xffe1),
            "ctrl" | "control" => Ok(0xffe3),
            "alt" | "option" => Ok(0xffe9),
            "cmd" | "command" | "meta" => Ok(0xffeb),
            other => Err(napi::Error::from_reason(format!(
                "Invalid modifier: {other}, expected shift, ctrl, alt or cmd"
            ))),
        }
    }

    fn pointer_event(
        x: f64,
        y: f64,
        button: &str,
        modifiers: &[String],
        which: u8,
    ) -> napi::Result<()> {
        crate::activity::ensure_not_emergency_stopped()?;
        let btn = x11_button(button)?;
        let keysyms = modifiers
            .iter()
            .map(|modifier| x11_modifier_keysym(modifier))
            .collect::<napi::Result<Vec<_>>>()?;
        if is_wayland() {
            // ydotool cannot express a held-button path, so say so rather than
            // emitting a gesture that silently does the wrong thing.
            return Err(napi::Error::from_reason(
                "Button-aware drags are unavailable on Wayland; use X11 or the accessibility tools",
            ));
        }
        x11_impl::pointer_event(x as i32, y as i32, btn, &keysyms, which);
        Ok(())
    }

    fn mouse_click_impl(x: f64, y: f64, button: String, count: i32, additive: bool) -> napi::Result<()> {
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
        if is_wayland() {
            if additive { return Err(napi::Error::from_reason("Additive selection is unavailable on Wayland; use accessibility selection")); }
            if !ydotool_available() { return Err(napi::Error::from_reason("ydotool is unavailable")); }
            wayland_impl::mouse_click(x as i32, y as i32, btn, count);
        } else {
            x11_impl::mouse_click(x as i32, y as i32, btn, count, additive);
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
        CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton, EventField, ScrollEventUnit,
    };
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    use core_graphics::geometry::CGPoint;
    use napi_derive::napi;
    use std::sync::atomic::{AtomicBool, Ordering};

    static AGENT_LEFT_HELD: AtomicBool = AtomicBool::new(false);

    fn source() -> CGEventSource {
        // Keep synthetic state out of the HID-only physical-user activity
        // clock used by host-side input attribution.
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

    /// Resolve a button name to its CGEvent down/up/dragged triple.
    fn button_events(
        button: &str,
    ) -> napi::Result<(CGMouseButton, CGEventType, CGEventType, CGEventType)> {
        match button {
            "left" => Ok((
                CGMouseButton::Left,
                CGEventType::LeftMouseDown,
                CGEventType::LeftMouseUp,
                CGEventType::LeftMouseDragged,
            )),
            "right" => Ok((
                CGMouseButton::Right,
                CGEventType::RightMouseDown,
                CGEventType::RightMouseUp,
                CGEventType::RightMouseDragged,
            )),
            "middle" => Ok((
                CGMouseButton::Center,
                CGEventType::OtherMouseDown,
                CGEventType::OtherMouseUp,
                CGEventType::OtherMouseDragged,
            )),
            other => Err(napi::Error::from_reason(format!(
                "Invalid button: {other}, expected 'left', 'middle' or 'right'"
            ))),
        }
    }

    /// Translate modifier names into CGEvent flags.
    ///
    /// macOS carries modifiers on the mouse event itself, so a modifier-held drag
    /// needs no synthetic key events at all — unlike Windows and X11, which have
    /// to press and release the real keys around the sequence.
    fn modifier_flags(modifiers: &[String]) -> napi::Result<CGEventFlags> {
        let mut flags = CGEventFlags::CGEventFlagNull;
        for modifier in modifiers {
            flags |= match modifier.as_str() {
                "shift" => CGEventFlags::CGEventFlagShift,
                "ctrl" | "control" => CGEventFlags::CGEventFlagControl,
                "alt" | "option" => CGEventFlags::CGEventFlagAlternate,
                "cmd" | "command" | "meta" => CGEventFlags::CGEventFlagCommand,
                other => {
                    return Err(napi::Error::from_reason(format!(
                        "Invalid modifier: {other}, expected shift, ctrl, alt or cmd"
                    )))
                }
            };
        }
        Ok(flags)
    }

    fn post_button_event(
        x: f64,
        y: f64,
        button: &str,
        modifiers: &[String],
        which: u8,
    ) -> napi::Result<()> {
        crate::activity::ensure_not_emergency_stopped()?;
        let (mouse_button, down, up, dragged) = button_events(button)?;
        let flags = modifier_flags(modifiers)?;
        let event_type = match which {
            0 => down,
            1 => dragged,
            _ => up,
        };
        let event = CGEvent::new_mouse_event(source(), event_type, CGPoint::new(x, y), mouse_button)
            .map_err(|_| napi::Error::from_reason("Could not create mouse event"))?;
        if flags != CGEventFlags::CGEventFlagNull {
            event.set_flags(flags);
        }
        post(event);
        if button == "left" {
            AGENT_LEFT_HELD.store(which == 0, Ordering::Release);
        }
        Ok(())
    }

    /// Press a mouse button, with optional modifiers held for the event.
    #[napi]
    pub fn mouse_press(
        x: f64,
        y: f64,
        button: String,
        modifiers: Vec<String>,
    ) -> napi::Result<()> {
        post_button_event(x, y, &button, &modifiers, 0)
    }

    /// Move while a button is held. Emit these between press and release.
    #[napi]
    pub fn mouse_drag_to(
        x: f64,
        y: f64,
        button: String,
        modifiers: Vec<String>,
    ) -> napi::Result<()> {
        post_button_event(x, y, &button, &modifiers, 1)
    }

    /// Release a mouse button.
    #[napi]
    pub fn mouse_release(
        x: f64,
        y: f64,
        button: String,
        modifiers: Vec<String>,
    ) -> napi::Result<()> {
        post_button_event(x, y, &button, &modifiers, 2)
    }

    #[napi]
    pub fn mouse_click(x: f64, y: f64, button: String, count: i32) -> napi::Result<()> {
        mouse_click_impl(x, y, button, count, false)
    }

    #[napi]
    pub fn mouse_click_additive(x: f64, y: f64, button: String, count: i32) -> napi::Result<()> {
        mouse_click_impl(x, y, button, count, true)
    }

    fn mouse_click_impl(x: f64, y: f64, button: String, count: i32, additive: bool) -> napi::Result<()> {
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
            if additive { down.set_flags(CGEventFlags::CGEventFlagCommand); }
            down.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, i as i64);
            post(down);
            let up = CGEvent::new_mouse_event(source(), up_type, point, btn).unwrap();
            if additive { up.set_flags(CGEventFlags::CGEventFlagCommand); }
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

    struct ControlGuard(bool);
    fn control_event(up: bool) {
        let input = INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT {
            wVk: VK_CONTROL, wScan: 0, dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
            time: 0, dwExtraInfo: 0,
        } } };
        unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32); }
    }
    impl Drop for ControlGuard {
        fn drop(&mut self) { if self.0 { control_event(true); } }
    }

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

    fn button_flags(button: &str) -> napi::Result<(MOUSE_EVENT_FLAGS, MOUSE_EVENT_FLAGS)> {
        match button {
            "left" => Ok((MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)),
            "right" => Ok((MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)),
            "middle" => Ok((MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP)),
            other => Err(napi::Error::from_reason(format!(
                "Invalid button: {other}, expected 'left', 'middle' or 'right'"
            ))),
        }
    }

    fn modifier_key(modifier: &str) -> napi::Result<VIRTUAL_KEY> {
        match modifier {
            "shift" => Ok(VK_SHIFT),
            "ctrl" | "control" => Ok(VK_CONTROL),
            "alt" | "option" => Ok(VK_MENU),
            "cmd" | "command" | "meta" => Ok(VK_LWIN),
            other => Err(napi::Error::from_reason(format!(
                "Invalid modifier: {other}, expected shift, ctrl, alt or cmd"
            ))),
        }
    }

    /// Windows mouse events carry no modifier state, so the real keys have to be
    /// held around the sequence. This guard releases them even on an early return.
    struct ModifierGuard(Vec<VIRTUAL_KEY>);
    fn modifier_event(key: VIRTUAL_KEY, up: bool) {
        let input = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: key,
                    wScan: 0,
                    dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        unsafe {
            SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
        }
    }
    impl ModifierGuard {
        fn hold(modifiers: &[String]) -> napi::Result<Self> {
            let keys = modifiers
                .iter()
                .map(|modifier| modifier_key(modifier))
                .collect::<napi::Result<Vec<_>>>()?;
            for key in &keys {
                modifier_event(*key, false);
            }
            Ok(Self(keys))
        }
    }
    impl Drop for ModifierGuard {
        fn drop(&mut self) {
            for key in self.0.iter().rev() {
                modifier_event(*key, true);
            }
        }
    }

    fn post_button_event(
        x: f64,
        y: f64,
        button: &str,
        modifiers: &[String],
        which: u8,
    ) -> napi::Result<()> {
        crate::activity::ensure_not_emergency_stopped()?;
        let (down, up) = button_flags(button)?;
        let (ax, ay) = to_absolute(x, y);
        match which {
            // Press and release hold the modifiers only for their own event; a
            // drag holds them across the whole path from the caller's side.
            0 => {
                let _guard = ModifierGuard::hold(modifiers)?;
                send_mouse(ax, ay, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, 0);
                send_mouse(ax, ay, down | MOUSEEVENTF_ABSOLUTE, 0);
            }
            1 => send_mouse(ax, ay, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, 0),
            _ => {
                let _guard = ModifierGuard::hold(modifiers)?;
                send_mouse(ax, ay, up | MOUSEEVENTF_ABSOLUTE, 0);
            }
        }
        if button == "left" {
            AGENT_LEFT_HELD.store(which == 0, Ordering::Release);
        }
        Ok(())
    }

    /// Press a mouse button, with optional modifiers held for the event.
    #[napi]
    pub fn mouse_press(x: f64, y: f64, button: String, modifiers: Vec<String>) -> napi::Result<()> {
        post_button_event(x, y, &button, &modifiers, 0)
    }

    /// Move while a button is held. Emit these between press and release.
    #[napi]
    pub fn mouse_drag_to(x: f64, y: f64, button: String, modifiers: Vec<String>) -> napi::Result<()> {
        post_button_event(x, y, &button, &modifiers, 1)
    }

    /// Release a mouse button.
    #[napi]
    pub fn mouse_release(x: f64, y: f64, button: String, modifiers: Vec<String>) -> napi::Result<()> {
        post_button_event(x, y, &button, &modifiers, 2)
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
        mouse_click_impl(x, y, button, count, false)
    }

    #[napi]
    pub fn mouse_click_additive(x: f64, y: f64, button: String, count: i32) -> napi::Result<()> {
        mouse_click_impl(x, y, button, count, true)
    }

    fn mouse_click_impl(x: f64, y: f64, button: String, count: i32, additive: bool) -> napi::Result<()> {
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

        let inject_ctrl = additive && unsafe { GetAsyncKeyState(VK_CONTROL.0 as i32) } >= 0;
        let _guard = ControlGuard(inject_ctrl);
        if inject_ctrl { control_event(false); }
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
