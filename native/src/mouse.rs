// ── Linux implementation ──────────────────────────────────────────────────────
#[cfg(target_os = "linux")]
mod linux {
    use napi_derive::napi;
    use std::sync::atomic::{AtomicU8, Ordering};
    use crate::linux_ei::Route;

    /// Buttons this process pressed and has not released (bits: 1 left, 2 right, 4 middle); released by the latch.
    static AGENT_BUTTONS_HELD: AtomicU8 = AtomicU8::new(0);

    mod x11_impl {
        use std::ptr;
        use x11::xlib::*;
        use x11::xtest::*;

        /// Open the X display or say why not (7.7.0: before, every call returned silently when DISPLAY was unset).
        pub unsafe fn open_display() -> napi::Result<*mut Display> {
            let dpy = XOpenDisplay(ptr::null());
            if dpy.is_null() {
                Err(napi::Error::from_reason(
                    "Cannot open the X display (is DISPLAY set? On Wayland, install ydotool)",
                ))
            } else {
                Ok(dpy)
            }
        }

        pub fn mouse_move(x: i32, y: i32) -> napi::Result<()> {
            unsafe {
                let dpy = open_display()?;
                XWarpPointer(dpy, 0, XDefaultRootWindow(dpy), 0, 0, 0, 0, x, y);
                XFlush(dpy);
                XCloseDisplay(dpy);
            }
            Ok(())
        }

        pub fn mouse_click(x: i32, y: i32, btn: u32, count: i32, additive: bool) -> napi::Result<()> {
            unsafe {
                let dpy = open_display()?;
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
            Ok(())
        }

        pub fn button_event(btn: u32, press: bool, at: Option<(i32, i32)>) -> napi::Result<()> {
            unsafe {
                let dpy = open_display()?;
                if let Some((x, y)) = at {
                    XWarpPointer(dpy, 0, XDefaultRootWindow(dpy), 0, 0, 0, 0, x, y);
                }
                XTestFakeButtonEvent(dpy, btn, if press { 1 } else { 0 }, 0);
                XFlush(dpy);
                XCloseDisplay(dpy);
            }
            Ok(())
        }

        pub fn mouse_scroll(dy: i32, dx: i32) -> napi::Result<()> {
            unsafe {
                let dpy = open_display()?;
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
            Ok(())
        }

        /// Press, drag or release a chosen button, optionally holding modifiers.
        ///
        /// `which` is 0 press, 1 drag, 2 release. Modifiers are pressed before the
        /// button event and released after it; a caller holding them across a whole
        /// path passes them on every call, which X11 coalesces harmlessly.
        pub fn pointer_event(x: i32, y: i32, btn: u32, keysyms: &[u64], which: u8) -> napi::Result<()> {
            unsafe {
                let dpy = open_display()?;
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
            Ok(())
        }

        pub fn cursor_position() -> napi::Result<(i32, i32)> {
            unsafe {
                let dpy = open_display()?;
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
                Ok((rx, ry))
            }
        }
    }

    mod wayland_impl {
        use crate::linux_tools::run;

        pub fn mouse_move(x: i32, y: i32) -> napi::Result<()> {
            run("ydotool", &["mousemove", "--absolute", "-x", &x.to_string(), "-y", &y.to_string()])?;
            Ok(())
        }

        /// ydotool button codes: 0x00 left, 0x01 right, 0x02 middle; 0x40 adds "down", 0x80 "up", 0xC0 a click.
        fn ydotool_button(btn: u32) -> u32 {
            match btn {
                2 => 0x02,
                3 => 0x01,
                _ => 0x00,
            }
        }

        pub fn mouse_click(x: i32, y: i32, btn: u32, count: i32) -> napi::Result<()> {
            mouse_move(x, y)?;
            std::thread::sleep(std::time::Duration::from_millis(10));
            let code = format!("0x{:02X}", 0xC0 | ydotool_button(btn));
            for i in 0..count {
                run("ydotool", &["click", &code])?;
                if i < count - 1 {
                    std::thread::sleep(std::time::Duration::from_millis(30));
                }
            }
            Ok(())
        }

        pub fn button_event(btn: u32, press: bool) -> napi::Result<()> {
            let code = format!("0x{:02X}", if press { 0x40 } else { 0x80 } | ydotool_button(btn));
            run("ydotool", &["click", &code])?;
            Ok(())
        }

        pub fn mouse_scroll(dy: i32, dx: i32) -> napi::Result<()> {
            if dy != 0 {
                // Negative = scroll up in ydotool
                run("ydotool", &["mousemove", "--wheel", "--", "-x", "0", "-y", &(-dy * 15).to_string()])?;
            }
            if dx != 0 {
                run("ydotool", &["mousemove", "--wheel", "--", "-x", &(dx * 15).to_string(), "-y", "0"])?;
            }
            Ok(())
        }

        pub fn cursor_position() -> napi::Result<(i32, i32)> {
            // Wayland doesn't expose cursor position easily; fall back to X11 via XWayland
            super::x11_impl::cursor_position()
        }
    }

    /// libei input (7.7.x): the RemoteDesktop portal on GNOME 46+ and KDE Plasma 6.1+, so a Wayland session needs
    /// neither a root daemon nor `/dev/uinput`. Same refusals and held-button tracking as every other route.
    mod ei_impl {
        use crate::linux_ei::{evdev_button, send, Action, KEY_LEFTCTRL};

        pub fn mouse_move(x: f64, y: f64) -> napi::Result<()> {
            send(vec![Action::Move { x, y }])
        }

        pub fn mouse_click(x: f64, y: f64, btn: u32, count: i32, additive: bool) -> napi::Result<()> {
            let code = evdev_button(btn);
            let mut first = vec![Action::Move { x, y }];
            if additive {
                first.push(Action::Key { code: KEY_LEFTCTRL, press: true });
            }
            let mut result = Ok(());
            for i in 0..count {
                let mut batch = if i == 0 { std::mem::take(&mut first) } else { Vec::new() };
                batch.push(Action::Button { code, press: true });
                batch.push(Action::Button { code, press: false });
                result = send(batch);
                if result.is_err() {
                    break;
                }
                if i < count - 1 {
                    std::thread::sleep(std::time::Duration::from_millis(30));
                }
            }
            if additive {
                // Released even when a click failed, so Control is never left down.
                let _ = send(vec![Action::Key { code: KEY_LEFTCTRL, press: false }]);
            }
            result
        }

        pub fn button_event(btn: u32, press: bool, at: Option<(f64, f64)>) -> napi::Result<()> {
            let mut batch = Vec::new();
            if let Some((x, y)) = at {
                batch.push(Action::Move { x, y });
            }
            batch.push(Action::Button { code: evdev_button(btn), press });
            send(batch)
        }

        pub fn mouse_scroll(dy: i32, dx: i32) -> napi::Result<()> {
            send(vec![Action::Scroll { dx, dy }])
        }

        /// The same press / drag / release contract as the X11 path: modifiers go down before the button event and up
        /// after it, and a drag is motion only.
        pub fn pointer_event(x: f64, y: f64, btn: u32, modifiers: &[u32], which: u8) -> napi::Result<()> {
            let mut batch = Vec::new();
            if which != 1 {
                batch.extend(modifiers.iter().map(|&code| Action::Key { code, press: true }));
            }
            batch.push(Action::Move { x, y });
            match which {
                0 => batch.push(Action::Button { code: evdev_button(btn), press: true }),
                2 => batch.push(Action::Button { code: evdev_button(btn), press: false }),
                _ => {}
            }
            if which != 1 {
                batch.extend(modifiers.iter().rev().map(|&code| Action::Key { code, press: false }));
            }
            send(batch)
        }
    }

    /// The input route for this process; a Wayland session with no usable route is an error that names the fix.
    fn route() -> napi::Result<Route> {
        match crate::linux_ei::route() {
            Route::Unavailable(reason) => Err(napi::Error::from_reason(reason)),
            route => Ok(route),
        }
    }

    /// evdev codes for the modifiers a pointer gesture can hold (libei sends key codes).
    fn evdev_modifier(modifier: &str) -> u32 {
        match modifier {
            "shift" => 42,
            "ctrl" | "control" => 29,
            "alt" | "option" => 56,
            _ => 125,
        }
    }

    #[napi]
    pub fn mouse_move(x: f64, y: f64) -> napi::Result<()> {
        crate::activity::ensure_not_emergency_stopped()?;
        match route()? {
            Route::Ei => ei_impl::mouse_move(x, y),
            Route::Ydotool => wayland_impl::mouse_move(x as i32, y as i32),
            _ => x11_impl::mouse_move(x as i32, y as i32),
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
        // A release always goes out, even after Stop (7.7.0).
        if which != 2 {
            crate::activity::ensure_not_emergency_stopped()?;
        }
        let btn = x11_button(button)?;
        let keysyms = modifiers
            .iter()
            .map(|modifier| x11_modifier_keysym(modifier))
            .collect::<napi::Result<Vec<_>>>()?;
        let route = route()?;
        if route == Route::Ydotool {
            // ydotool cannot express a held-button path, so say so rather than
            // emitting a gesture that silently does the wrong thing.
            return Err(napi::Error::from_reason(
                "Button-aware drags are unavailable through ydotool; use libei (GNOME 46+, KDE Plasma 6.1+), X11 or the accessibility tools",
            ));
        }
        let bit = super::button_bit(button);
        if which == 2 {
            AGENT_BUTTONS_HELD.fetch_and(!bit, Ordering::AcqRel);
        }
        if route == Route::Ei {
            let codes: Vec<u32> = modifiers.iter().map(|modifier| evdev_modifier(modifier)).collect();
            ei_impl::pointer_event(x, y, btn, &codes, which)?;
        } else {
            x11_impl::pointer_event(x as i32, y as i32, btn, &keysyms, which)?;
        }
        if which == 0 {
            AGENT_BUTTONS_HELD.fetch_or(bit, Ordering::AcqRel);
        }
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
        match route()? {
            Route::Ei => ei_impl::mouse_click(x, y, btn, count, additive),
            Route::Ydotool => {
                if additive { return Err(napi::Error::from_reason("Additive selection is unavailable through ydotool; use accessibility selection")); }
                wayland_impl::mouse_click(x as i32, y as i32, btn, count)
            }
            _ => x11_impl::mouse_click(x as i32, y as i32, btn, count, additive),
        }
    }

    #[napi]
    pub fn mouse_button(action: String, x: f64, y: f64) -> napi::Result<()> {
        let press = match action.as_str() {
            "press" => true,
            "release" => false,
            _ => {
                return Err(napi::Error::from_reason(format!(
                    "Invalid action: {action}"
                )))
            }
        };
        if press {
            crate::activity::ensure_not_emergency_stopped()?;
        } else {
            AGENT_BUTTONS_HELD.fetch_and(!1, Ordering::AcqRel);
        }
        match route()? {
            Route::Ei => ei_impl::button_event(1, press, Some((x, y)))?,
            Route::Ydotool => {
                wayland_impl::mouse_move(x as i32, y as i32)?;
                wayland_impl::button_event(1, press)?;
            }
            _ => x11_impl::button_event(1, press, Some((x as i32, y as i32)))?,
        }
        if press {
            AGENT_BUTTONS_HELD.fetch_or(1, Ordering::AcqRel);
        }
        Ok(())
    }

    /// Release every button this process holds (7.7.0: before, Linux released nothing on Stop).
    pub(crate) fn release_agent_held_buttons() {
        let held = AGENT_BUTTONS_HELD.swap(0, Ordering::AcqRel);
        for (bit, btn) in [(1u8, 1u32), (2, 3), (4, 2)] {
            if held & bit == 0 {
                continue;
            }
            let _ = match crate::linux_ei::route() {
                Route::Ei => ei_impl::button_event(btn, false, None),
                Route::Ydotool => wayland_impl::button_event(btn, false),
                _ => x11_impl::button_event(btn, false, None),
            };
        }
    }

    #[napi]
    pub fn mouse_scroll(dy: i32, dx: i32) -> napi::Result<()> {
        crate::activity::ensure_not_emergency_stopped()?;
        match route()? {
            Route::Ei => ei_impl::mouse_scroll(dy, dx),
            Route::Ydotool => wayland_impl::mouse_scroll(dy, dx),
            _ => x11_impl::mouse_scroll(dy, dx),
        }
    }

    #[napi]
    pub fn mouse_drag(x: f64, y: f64) -> napi::Result<()> {
        crate::activity::ensure_not_emergency_stopped()?;
        match route()? {
            Route::Ei => ei_impl::mouse_move(x, y),
            Route::Ydotool => wayland_impl::mouse_move(x as i32, y as i32),
            _ => x11_impl::mouse_move(x as i32, y as i32),
        }
    }

    #[napi]
    pub fn cursor_position() -> napi::Result<serde_json::Value> {
        // Wayland gives no program the pointer position; XWayland's is the best there is on every route.
        let (rx, ry) = if crate::linux_ei::route() == Route::Ydotool {
            wayland_impl::cursor_position()?
        } else {
            x11_impl::cursor_position()?
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
    use std::sync::atomic::{AtomicU8, Ordering};

    /// Buttons this process pressed and has not released (bits: 1 left, 2 right, 4 middle). The emergency latch
    /// releases every one of them (7.7.0; before, only the left button was tracked).
    static AGENT_BUTTONS_HELD: AtomicU8 = AtomicU8::new(0);

    fn source() -> CGEventSource {
        // Keep synthetic state out of the HID-only physical-user activity
        // clock used by host-side input attribution.
        CGEventSource::new(CGEventSourceStateID::Private).unwrap()
    }

    fn post(event: CGEvent) {
        event.post(CGEventTapLocation::HID);
    }

    #[napi]
    pub fn mouse_move(x: f64, y: f64) -> napi::Result<()> {
        // 7.7.0: a latched move is an error, not a silent success, so a gesture stopped by the chord does not report done.
        crate::activity::ensure_not_emergency_stopped()?;
        crate::permissions::ensure_input_trusted()?;
        let point = CGPoint::new(x, y);
        let event = CGEvent::new_mouse_event(
            source(),
            CGEventType::MouseMoved,
            point,
            CGMouseButton::Left,
        )
        .unwrap();
        post(event);
        Ok(())
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
        // A release always goes out, even after Stop: refusing it is what used to leave a button held (7.7.0).
        if which != 2 {
            crate::activity::ensure_not_emergency_stopped()?;
        }
        crate::permissions::ensure_input_trusted()?;
        let (mouse_button, down, up, dragged) = button_events(button)?;
        let flags = modifier_flags(modifiers)?;
        let event_type = match which {
            0 => down,
            1 => dragged,
            _ => up,
        };
        let event = CGEvent::new_mouse_event(source(), event_type, CGPoint::new(x, y), mouse_button)
            .map_err(|_| napi::Error::from_reason("Could not create mouse event"))?;
        // The release carries no modifier flags: a flagged final event can leave the modifier latched in the window
        // server's state (the class Peekaboo #797 measured).
        if flags != CGEventFlags::CGEventFlagNull && which != 2 {
            event.set_flags(flags);
        } else if which == 2 {
            event.set_flags(CGEventFlags::CGEventFlagNull);
        }
        post(event);
        let bit = super::button_bit(button);
        match which {
            0 => { AGENT_BUTTONS_HELD.fetch_or(bit, Ordering::AcqRel); }
            2 => { AGENT_BUTTONS_HELD.fetch_and(!bit, Ordering::AcqRel); }
            _ => {}
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
        crate::permissions::ensure_input_trusted()?;
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
            // The last up carries no flags, so an additive click never leaves Command latched (7.7.0).
            if additive && i < count { up.set_flags(CGEventFlags::CGEventFlagCommand); } else { up.set_flags(CGEventFlags::CGEventFlagNull); }
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
        let evt_type = match action.as_str() {
            "press" => CGEventType::LeftMouseDown,
            "release" => CGEventType::LeftMouseUp,
            _ => {
                return Err(napi::Error::from_reason(format!(
                    "Invalid action: {action}, expected 'press' or 'release'"
                )))
            }
        };
        if action == "press" {
            crate::activity::ensure_not_emergency_stopped()?;
        }
        crate::permissions::ensure_input_trusted()?;
        let point = CGPoint::new(x, y);
        let event =
            CGEvent::new_mouse_event(source(), evt_type, point, CGMouseButton::Left).unwrap();
        event.set_flags(CGEventFlags::CGEventFlagNull);
        post(event);
        if action == "press" {
            AGENT_BUTTONS_HELD.fetch_or(1, Ordering::AcqRel);
        } else {
            AGENT_BUTTONS_HELD.fetch_and(!1, Ordering::AcqRel);
        }
        Ok(())
    }

    /// Release every button this process holds, at the cursor, with no modifier flags. Runs on the emergency latch's
    /// own thread; posting is not subject to the latch.
    pub(crate) fn release_agent_held_buttons() {
        let held = AGENT_BUTTONS_HELD.swap(0, Ordering::AcqRel);
        if held == 0 {
            return;
        }
        let location = CGEvent::new(source())
            .map(|event| event.location())
            .unwrap_or_default();
        for (bit, button, up) in [
            (1u8, CGMouseButton::Left, CGEventType::LeftMouseUp),
            (2, CGMouseButton::Right, CGEventType::RightMouseUp),
            (4, CGMouseButton::Center, CGEventType::OtherMouseUp),
        ] {
            if held & bit == 0 {
                continue;
            }
            if let Ok(event) = CGEvent::new_mouse_event(source(), up, location, button) {
                event.set_flags(CGEventFlags::CGEventFlagNull);
                post(event);
            }
        }
    }

    #[napi]
    pub fn mouse_scroll(dy: i32, dx: i32) -> napi::Result<()> {
        crate::activity::ensure_not_emergency_stopped()?;
        crate::permissions::ensure_input_trusted()?;
        if let Ok(event) = CGEvent::new_scroll_event(source(), ScrollEventUnit::LINE, 2, dy, dx, 0)
        {
            post(event);
        }
        Ok(())
    }

    #[napi]
    pub fn mouse_drag(x: f64, y: f64) -> napi::Result<()> {
        crate::activity::ensure_not_emergency_stopped()?;
        crate::permissions::ensure_input_trusted()?;
        let point = CGPoint::new(x, y);
        let event = CGEvent::new_mouse_event(
            source(),
            CGEventType::LeftMouseDragged,
            point,
            CGMouseButton::Left,
        )
        .unwrap();
        post(event);
        Ok(())
    }

    // ── Pid delivery (v7.5): post to one process, never move the real cursor ──

    /// kCGMouseEventWindowUnderMousePointer and ...ThatCanHandleThisEvent. Cocoa
    /// routes a mouse event by these fields, so a pid-posted click lands in the
    /// intended window even when another app's window covers that point.
    const FIELD_WINDOW_UNDER_POINTER: u32 = 91;
    const FIELD_WINDOW_THAT_CAN_HANDLE: u32 = 92;

    fn tag_window(event: &CGEvent, window_id: Option<u32>) {
        if let Some(window_id) = window_id {
            event.set_integer_value_field(FIELD_WINDOW_UNDER_POINTER, window_id as i64);
            event.set_integer_value_field(FIELD_WINDOW_THAT_CAN_HANDLE, window_id as i64);
        }
    }

    /// Click at screen point (x, y) by posting the events to `pid` only.
    #[napi]
    pub fn mouse_click_to_pid(
        pid: i32,
        x: f64,
        y: f64,
        button: String,
        count: i32,
        window_id: Option<u32>,
    ) -> napi::Result<()> {
        crate::activity::ensure_not_emergency_stopped()?;
        crate::permissions::ensure_input_trusted()?;
        let point = CGPoint::new(x, y);
        let (btn, down_type, up_type, _) = button_events(&button)?;
        let moved = CGEvent::new_mouse_event(
            source(),
            CGEventType::MouseMoved,
            point,
            CGMouseButton::Left,
        )
        .map_err(|_| napi::Error::from_reason("Could not create mouse event"))?;
        tag_window(&moved, window_id);
        moved.post_to_pid(pid);
        std::thread::sleep(std::time::Duration::from_millis(15));
        for i in 1..=count.max(1) {
            crate::activity::ensure_not_emergency_stopped()?;
            let down = CGEvent::new_mouse_event(source(), down_type, point, btn)
                .map_err(|_| napi::Error::from_reason("Could not create mouse event"))?;
            down.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, i as i64);
            tag_window(&down, window_id);
            down.post_to_pid(pid);
            let up = CGEvent::new_mouse_event(source(), up_type, point, btn)
                .map_err(|_| napi::Error::from_reason("Could not create mouse event"))?;
            up.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, i as i64);
            tag_window(&up, window_id);
            up.post_to_pid(pid);
            if i < count {
                std::thread::sleep(std::time::Duration::from_millis(30));
            }
        }
        Ok(())
    }

    /// Scroll at screen point (x, y) by posting the event to `pid` only.
    #[napi]
    pub fn mouse_scroll_to_pid(
        pid: i32,
        x: f64,
        y: f64,
        dy: i32,
        dx: i32,
        window_id: Option<u32>,
    ) -> napi::Result<()> {
        crate::activity::ensure_not_emergency_stopped()?;
        crate::permissions::ensure_input_trusted()?;
        let event = CGEvent::new_scroll_event(source(), ScrollEventUnit::LINE, 2, dy, dx, 0)
            .map_err(|_| napi::Error::from_reason("Could not create scroll event"))?;
        {
            use foreign_types::ForeignType;
            extern "C" {
                fn CGEventSetLocation(event: *mut std::ffi::c_void, location: CGPoint);
            }
            unsafe {
                CGEventSetLocation(event.as_ptr() as *mut std::ffi::c_void, CGPoint::new(x, y))
            };
        }
        tag_window(&event, window_id);
        event.post_to_pid(pid);
        Ok(())
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
    use std::sync::atomic::{AtomicU8, Ordering};
    use std::time::Duration;
    use windows::Win32::UI::Input::KeyboardAndMouse::*;

    /// Buttons this process pressed and has not released (bits: 1 left, 2 right, 4 middle). 7.7.0: all three, and
    /// the latch releases every one (before, only the left button was tracked).
    static AGENT_BUTTONS_HELD: AtomicU8 = AtomicU8::new(0);
    use windows::Win32::UI::WindowsAndMessaging::*;

    struct ControlGuard(bool);
    fn control_event(up: bool) {
        let input = INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT {
            wVk: VK_CONTROL, wScan: 0, dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
            time: 0, dwExtraInfo: 0,
        } } };
        let _ = crate::keyboard::send_inputs(&[input]);
    }
    impl Drop for ControlGuard {
        fn drop(&mut self) { if self.0 { control_event(true); } }
    }

    /// The virtual desktop (every monitor), in the coordinates input uses.
    fn virtual_desktop() -> (i32, i32, i32, i32) {
        crate::dpi::ensure();
        unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            )
        }
    }

    /// 7.7.0 (W1): absolute coordinates normalised over the whole virtual desktop and sent with
    /// `MOUSEEVENTF_VIRTUALDESK`, so a point on a second monitor is reached (before, every point was normalised over
    /// the primary monitor and clamped to it, one pixel short).
    fn to_absolute(x: f64, y: f64) -> (i32, i32) {
        let (left, top, width, height) = virtual_desktop();
        (super::normalize_absolute(x, left, width), super::normalize_absolute(y, top, height))
    }

    const ABSOLUTE: MOUSE_EVENT_FLAGS = MOUSE_EVENT_FLAGS(MOUSEEVENTF_ABSOLUTE.0 | MOUSEEVENTF_VIRTUALDESK.0);

    fn mouse_input(dx: i32, dy: i32, flags: MOUSE_EVENT_FLAGS, data: i32) -> INPUT {
        INPUT {
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
        }
    }

    /// Send one mouse event. 7.7.0 (W2): `SendInput` reports how many events it inserted; zero means the input was
    /// blocked (UIPI: the foreground window belongs to a higher-integrity process, or the secure desktop is up), which
    /// is now an error instead of a success.
    fn send_mouse(dx: i32, dy: i32, flags: MOUSE_EVENT_FLAGS, data: i32) -> napi::Result<()> {
        crate::keyboard::send_inputs(&[mouse_input(dx, dy, flags, data)])
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
        let _ = crate::keyboard::send_inputs(&[input]);
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
        // A release always goes out, even after Stop (7.7.0).
        if which != 2 {
            crate::activity::ensure_not_emergency_stopped()?;
        }
        let (down, up) = button_flags(button)?;
        let (ax, ay) = to_absolute(x, y);
        let bit = super::button_bit(button);
        match which {
            // Press and release hold the modifiers only for their own event; a
            // drag holds them across the whole path from the caller's side.
            0 => {
                let _guard = ModifierGuard::hold(modifiers)?;
                send_mouse(ax, ay, MOUSEEVENTF_MOVE | ABSOLUTE, 0)?;
                send_mouse(ax, ay, down | ABSOLUTE, 0)?;
                AGENT_BUTTONS_HELD.fetch_or(bit, Ordering::AcqRel);
            }
            1 => send_mouse(ax, ay, MOUSEEVENTF_MOVE | ABSOLUTE, 0)?,
            _ => {
                AGENT_BUTTONS_HELD.fetch_and(!bit, Ordering::AcqRel);
                let _guard = ModifierGuard::hold(modifiers)?;
                send_mouse(ax, ay, up | ABSOLUTE, 0)?;
            }
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
    pub fn mouse_move(x: f64, y: f64) -> napi::Result<()> {
        crate::activity::ensure_not_emergency_stopped()?;
        let (ax, ay) = to_absolute(x, y);
        send_mouse(ax, ay, MOUSEEVENTF_MOVE | ABSOLUTE, 0)
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
        send_mouse(ax, ay, MOUSEEVENTF_MOVE | ABSOLUTE, 0)?;
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
            // Down and up in one SendInput call: atomic, so nothing can interleave a click in half.
            crate::keyboard::send_inputs(&[mouse_input(ax, ay, down | ABSOLUTE, 0), mouse_input(ax, ay, up | ABSOLUTE, 0)])?;
            if i < count - 1 {
                std::thread::sleep(Duration::from_millis(30));
            }
        }
        Ok(())
    }

    #[napi]
    pub fn mouse_button(action: String, x: f64, y: f64) -> napi::Result<()> {
        let flag = match action.as_str() {
            "press" => MOUSEEVENTF_LEFTDOWN,
            "release" => MOUSEEVENTF_LEFTUP,
            _ => {
                return Err(napi::Error::from_reason(format!(
                    "Invalid action: {action}, expected 'press' or 'release'"
                )))
            }
        };
        if action == "press" {
            crate::activity::ensure_not_emergency_stopped()?;
        }
        let (ax, ay) = to_absolute(x, y);
        if action == "press" {
            send_mouse(ax, ay, flag | ABSOLUTE, 0)?;
            AGENT_BUTTONS_HELD.fetch_or(1, Ordering::AcqRel);
        } else {
            AGENT_BUTTONS_HELD.fetch_and(!1, Ordering::AcqRel);
            send_mouse(ax, ay, flag | ABSOLUTE, 0)?;
        }
        Ok(())
    }

    /// Release every button this process holds, where the cursor is. Runs on the emergency latch's own thread.
    pub(crate) fn release_agent_held_buttons() {
        let held = AGENT_BUTTONS_HELD.swap(0, Ordering::AcqRel);
        for (bit, up) in [(1u8, MOUSEEVENTF_LEFTUP), (2, MOUSEEVENTF_RIGHTUP), (4, MOUSEEVENTF_MIDDLEUP)] {
            if held & bit != 0 {
                let _ = send_mouse(0, 0, up, 0);
            }
        }
    }

    #[napi]
    pub fn mouse_scroll(dy: i32, dx: i32) -> napi::Result<()> {
        crate::activity::ensure_not_emergency_stopped()?;
        // Vertical scroll
        if dy != 0 {
            send_mouse(0, 0, MOUSEEVENTF_WHEEL, -dy * 120)?;
        }
        // Horizontal scroll
        if dx != 0 {
            send_mouse(0, 0, MOUSEEVENTF_HWHEEL, dx * 120)?;
        }
        Ok(())
    }

    #[napi]
    pub fn mouse_drag(x: f64, y: f64) -> napi::Result<()> {
        crate::activity::ensure_not_emergency_stopped()?;
        let (ax, ay) = to_absolute(x, y);
        send_mouse(ax, ay, MOUSEEVENTF_MOVE | ABSOLUTE, 0)
    }

    #[napi]
    pub fn cursor_position() -> napi::Result<serde_json::Value> {
        use windows::Win32::Foundation::POINT;
        crate::dpi::ensure();
        let mut pt = POINT { x: 0, y: 0 };
        unsafe {
            let _ = GetCursorPos(&mut pt);
        }
        Ok(serde_json::json!({ "x": pt.x, "y": pt.y }))
    }
}

/// The held-button bit for a button name (1 left, 2 right, 4 middle); 0 for anything else.
#[cfg_attr(not(any(target_os = "macos", target_os = "windows", target_os = "linux")), allow(dead_code))]
pub(crate) fn button_bit(button: &str) -> u8 {
    match button {
        "left" => 1,
        "right" => 2,
        "middle" => 4,
        _ => 0,
    }
}

/// Map a coordinate onto the 0..=65535 range `SendInput` uses for absolute input over a span of `size` pixels that
/// starts at `origin` (7.7.0, W1). Rounded, not truncated: the old truncation landed one pixel short (Windows-MCP
/// #441), and the far edge maps to 65535 exactly.
#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
pub(crate) fn normalize_absolute(value: f64, origin: i32, size: i32) -> i32 {
    if size <= 1 {
        return 0;
    }
    let relative = (value - origin as f64).clamp(0.0, (size - 1) as f64);
    ((relative * 65535.0) / (size - 1) as f64).round() as i32
}

#[cfg(test)]
mod tests {
    use super::{button_bit, normalize_absolute};

    #[test]
    fn absolute_input_spans_the_virtual_desktop() {
        // A single 1920-wide monitor: the edges map to 0 and 65535 exactly, the centre to the middle.
        assert_eq!(normalize_absolute(0.0, 0, 1920), 0);
        assert_eq!(normalize_absolute(1919.0, 0, 1920), 65535);
        assert_eq!(normalize_absolute(959.5, 0, 1920), 32768);
        // Two monitors, the second to the left of the primary (virtual desktop starts at -1920).
        assert_eq!(normalize_absolute(-1920.0, -1920, 3840), 0);
        assert_eq!(normalize_absolute(0.0, -1920, 3840), normalize_absolute(1920.0, 0, 3840));
        assert_eq!(normalize_absolute(1919.0, -1920, 3840), 65535);
        // Out of range clamps rather than wrapping.
        assert_eq!(normalize_absolute(-5000.0, 0, 1920), 0);
        assert_eq!(normalize_absolute(99_999.0, 0, 1920), 65535);
        assert_eq!(normalize_absolute(10.0, 0, 1), 0);
    }

    #[test]
    fn rounding_lands_on_the_pixel_asked_for() {
        // Windows maps an absolute value v back to pixel floor(v * (size - 1) / 65535 + 0.5) for each pixel.
        for size in [800, 1366, 1920, 2560, 3840] {
            for pixel in [0, 1, 2, size / 3, size / 2, size - 2, size - 1] {
                let v = normalize_absolute(pixel as f64, 0, size) as f64;
                let back = (v * (size - 1) as f64 / 65535.0).round() as i32;
                assert_eq!(back, pixel, "size {size} pixel {pixel}");
            }
        }
    }

    #[test]
    fn button_bits() {
        assert_eq!(button_bit("left") | button_bit("right") | button_bit("middle"), 7);
        assert_eq!(button_bit("other"), 0);
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
pub(crate) fn release_agent_held_buttons() {
    linux::release_agent_held_buttons();
}
