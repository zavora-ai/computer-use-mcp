// ── Linux implementation ──────────────────────────────────────────────────────
#[cfg(target_os = "linux")]
mod linux {
    use crate::linux_ei::{Action, Route};
    use crate::linux_tools::run;
    use napi_derive::napi;
    use std::collections::HashMap;
    use std::sync::OnceLock;

    static LINUX_KEY_MAP: OnceLock<HashMap<&'static str, u32>> = OnceLock::new();

    fn key_map() -> &'static HashMap<&'static str, u32> {
        LINUX_KEY_MAP.get_or_init(|| {
            let mut m = HashMap::new();
            m.insert("return", 36);
            m.insert("enter", 36);
            m.insert("tab", 23);
            m.insert("space", 65);
            m.insert("backspace", 22);
            m.insert("delete", 119);
            m.insert("forwarddelete", 119);
            m.insert("escape", 9);
            m.insert("esc", 9);
            m.insert("shift", 50);
            m.insert("control", 37);
            m.insert("ctrl", 37);
            m.insert("alt", 64);
            m.insert("option", 64);
            m.insert("super", 133);
            m.insert("command", 133);
            m.insert("cmd", 133);
            m.insert("win", 133);
            m.insert("meta", 133);
            m.insert("capslock", 66);
            m.insert("f1", 67);
            m.insert("f2", 68);
            m.insert("f3", 69);
            m.insert("f4", 70);
            m.insert("f5", 71);
            m.insert("f6", 72);
            m.insert("f7", 73);
            m.insert("f8", 74);
            m.insert("f9", 75);
            m.insert("f10", 76);
            m.insert("f11", 95);
            m.insert("f12", 96);
            // F13–F20 (evdev KEY_F13 183 … KEY_F20 190, X keycode = evdev + 8). 7.7.0: accepted by the server, missing here.
            for (i, name) in ["f13", "f14", "f15", "f16", "f17", "f18", "f19", "f20"].into_iter().enumerate() {
                m.insert(name, 191 + i as u32);
            }
            m.insert("home", 110);
            m.insert("end", 115);
            m.insert("pageup", 112);
            m.insert("pagedown", 117);
            m.insert("left", 113);
            m.insert("right", 114);
            m.insert("up", 111);
            m.insert("down", 116);
            m.insert("a", 38);
            m.insert("b", 56);
            m.insert("c", 54);
            m.insert("d", 40);
            m.insert("e", 26);
            m.insert("f", 41);
            m.insert("g", 42);
            m.insert("h", 43);
            m.insert("i", 31);
            m.insert("j", 44);
            m.insert("k", 45);
            m.insert("l", 46);
            m.insert("m", 58);
            m.insert("n", 57);
            m.insert("o", 32);
            m.insert("p", 33);
            m.insert("q", 24);
            m.insert("r", 27);
            m.insert("s", 39);
            m.insert("t", 28);
            m.insert("u", 30);
            m.insert("v", 55);
            m.insert("w", 25);
            m.insert("x", 53);
            m.insert("y", 29);
            m.insert("z", 52);
            m.insert("0", 19);
            m.insert("1", 10);
            m.insert("2", 11);
            m.insert("3", 12);
            m.insert("4", 13);
            m.insert("5", 14);
            m.insert("6", 15);
            m.insert("7", 16);
            m.insert("8", 17);
            m.insert("9", 18);
            m.insert("-", 20);
            m.insert("=", 21);
            m.insert("[", 34);
            m.insert("]", 35);
            m.insert("\\", 51);
            m.insert(";", 47);
            m.insert("'", 48);
            m.insert(",", 59);
            m.insert(".", 60);
            m.insert("/", 61);
            m.insert("`", 49);
            m
        })
    }

    fn is_modifier(keycode: u32) -> bool {
        matches!(keycode, 50 | 37 | 64 | 133 | 66)
    }

    // ydotool uses evdev keycodes (X11 keycode - 8)
    fn x11_to_evdev(x11_keycode: u32) -> u32 {
        x11_keycode.saturating_sub(8)
    }

    fn ydotool_keys(codes: &[(u32, bool)]) -> napi::Result<()> {
        let mut args: Vec<String> = vec!["key".to_string()];
        for (code, down) in codes {
            args.push(format!("{}:{}", x11_to_evdev(*code), if *down { 1 } else { 0 }));
        }
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        run("ydotool", &args)?;
        Ok(())
    }

    fn ydotool_key_combo(combo: &str, repeat: i32) -> napi::Result<()> {
        let map = key_map();
        let combo_lower = combo.to_lowercase();
        let parts: Vec<&str> = combo_lower.split('+').map(|s| s.trim()).collect();

        let mut codes: Vec<u32> = Vec::new();
        for part in &parts {
            let kc = map.get(part).copied().ok_or_else(|| {
                napi::Error::from_reason(format!("Unknown key in combo: {combo}"))
            })?;
            codes.push(kc);
        }

        // One ydotool call per repeat: every key down, then every key up in reverse.
        for _ in 0..repeat {
            let mut sequence: Vec<(u32, bool)> = codes.iter().map(|c| (*c, true)).collect();
            sequence.extend(codes.iter().rev().map(|c| (*c, false)));
            ydotool_keys(&sequence)?;
        }
        Ok(())
    }

    unsafe fn open_display() -> napi::Result<*mut x11::xlib::Display> {
        let dpy = x11::xlib::XOpenDisplay(std::ptr::null());
        if dpy.is_null() {
            Err(napi::Error::from_reason("Cannot open the X display (is DISPLAY set? On Wayland, install ydotool)"))
        } else {
            Ok(dpy)
        }
    }

    /// The input route (7.7.x: libei on GNOME 46+ and KDE Plasma 6.1+); a Wayland session with none is a named error.
    fn route() -> napi::Result<Route> {
        match crate::linux_ei::route() {
            Route::Unavailable(reason) => Err(napi::Error::from_reason(reason)),
            route => Ok(route),
        }
    }

    /// Every key in a combo down, then every key up in reverse, `repeat` times, as libei key events (evdev codes).
    fn ei_key_combo(combo: &str, repeat: i32) -> napi::Result<()> {
        let map = key_map();
        let codes = combo
            .to_lowercase()
            .split('+')
            .map(|part| {
                map.get(part.trim())
                    .map(|code| x11_to_evdev(*code))
                    .ok_or_else(|| napi::Error::from_reason(format!("Unknown key in combo: {combo}")))
            })
            .collect::<napi::Result<Vec<u32>>>()?;
        let mut actions = Vec::new();
        for _ in 0..repeat.max(1) {
            actions.extend(codes.iter().map(|&code| Action::Key { code, press: true }));
            actions.extend(codes.iter().rev().map(|&code| Action::Key { code, press: false }));
        }
        crate::linux_ei::send(actions)
    }

    #[napi]
    pub fn key_press(combo: String, repeat: Option<i32>) -> napi::Result<()> {
        crate::activity::ensure_not_emergency_stopped()?;
        let repeat = repeat.unwrap_or(1);

        match route()? {
            Route::Ei => return ei_key_combo(&combo, repeat),
            Route::Ydotool => return ydotool_key_combo(&combo, repeat),
            _ => {}
        }

        // X11 path
        let map = key_map();
        let combo_lower = combo.to_lowercase();
        let parts: Vec<&str> = combo_lower.split('+').map(|s| s.trim()).collect();

        let mut modifiers: Vec<u32> = Vec::new();
        let mut main_key: Option<u32> = None;

        for part in &parts {
            if let Some(&kc) = map.get(part) {
                if is_modifier(kc) {
                    modifiers.push(kc);
                } else {
                    main_key = Some(kc);
                }
            }
        }

        let key = main_key
            .ok_or_else(|| napi::Error::from_reason(format!("Unknown key in combo: {combo}")))?;

        unsafe {
            use x11::xlib::*;
            use x11::xtest::*;
            let dpy = open_display()?;

            for i in 0..repeat {
                for &m in &modifiers {
                    XTestFakeKeyEvent(dpy, m, 1, 0);
                }
                XTestFakeKeyEvent(dpy, key, 1, 0);
                XTestFakeKeyEvent(dpy, key, 0, 0);
                for m in modifiers.iter().rev() {
                    XTestFakeKeyEvent(dpy, *m, 0, 0);
                }
                XFlush(dpy);
                if i < repeat - 1 {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
            }
            XCloseDisplay(dpy);
        }
        Ok(())
    }

    #[napi]
    pub fn type_text(text: String) -> napi::Result<()> {
        // 7.7.0 (C4): a latched call is an error, not a silent success; (L1, L2) the tool's output is captured and a
        // missing or failing tool is a named error.
        crate::activity::ensure_not_emergency_stopped()?;
        match route()? {
            Route::Ei => {
                // Every character is resolved before any key goes out; the latch is checked between chunks, so a Stop
                // ends typing part-way and says so (C4).
                let actions = crate::linux_ei::type_actions(&text).map_err(napi::Error::from_reason)?;
                let mut sent = 0usize;
                for chunk in actions.chunks(64) {
                    if crate::activity::ensure_not_emergency_stopped().is_err() {
                        return Err(napi::Error::from_reason(format!(
                            "Stopped by the emergency latch after {sent} of {} key events", actions.len()
                        )));
                    }
                    crate::linux_ei::send(chunk.to_vec())?;
                    sent += chunk.len();
                }
            }
            Route::Ydotool => {
                run("ydotool", &["type", "--", &text])?;
            }
            _ => {
                run("xdotool", &["type", "--clearmodifiers", "--", &text])?;
            }
        }
        Ok(())
    }

    // ── Held keys (7.7.0, C1/C2/C6) ─────────────────────────────────────────

    /// X keycodes this process pressed and has not released, in press order.
    static HELD_KEYS: std::sync::Mutex<Vec<u32>> = std::sync::Mutex::new(Vec::new());

    fn held() -> std::sync::MutexGuard<'static, Vec<u32>> {
        HELD_KEYS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Resolve every name before pressing anything, so an unknown key never leaves the earlier ones held.
    fn resolve_keys(keys: &[String]) -> napi::Result<Vec<u32>> {
        let map = key_map();
        let mut resolved = Vec::with_capacity(keys.len());
        let mut unknown = Vec::new();
        for k in keys {
            match map.get(k.to_lowercase().as_str()) {
                Some(&code) => resolved.push(code),
                None => unknown.push(k.clone()),
            }
        }
        if unknown.is_empty() {
            Ok(resolved)
        } else {
            Err(napi::Error::from_reason(format!("Unknown key: {}", unknown.join(", "))))
        }
    }

    fn send(codes: &[u32], down: bool) -> napi::Result<()> {
        if codes.is_empty() {
            return Ok(());
        }
        match crate::linux_ei::route() {
            Route::Ei => {
                return crate::linux_ei::send(
                    codes.iter().map(|&code| Action::Key { code: x11_to_evdev(code), press: down }).collect(),
                )
            }
            Route::Ydotool => {
                let sequence: Vec<(u32, bool)> = codes.iter().map(|c| (*c, down)).collect();
                return ydotool_keys(&sequence);
            }
            Route::Unavailable(reason) => return Err(napi::Error::from_reason(reason)),
            Route::Xtest => {}
        }
        unsafe {
            use x11::xlib::*;
            use x11::xtest::*;
            let dpy = open_display()?;
            for code in codes {
                XTestFakeKeyEvent(dpy, *code, if down { 1 } else { 0 }, 0);
            }
            XFlush(dpy);
            XCloseDisplay(dpy);
        }
        Ok(())
    }

    /// Press keys and keep them down until `key_up` (or the emergency latch) releases them.
    #[napi]
    pub fn key_down(keys: Vec<String>) -> napi::Result<()> {
        let resolved = resolve_keys(&keys)?;
        crate::activity::ensure_not_emergency_stopped()?;
        let mut held = held();
        let fresh: Vec<u32> = resolved.into_iter().filter(|code| !held.contains(code)).collect();
        send(&fresh, true)?;
        held.extend(fresh);
        Ok(())
    }

    /// Release keys pressed by `key_down`, in reverse order; an empty list releases everything held. Not refused by
    /// the emergency latch.
    #[napi]
    pub fn key_up(keys: Vec<String>) -> napi::Result<()> {
        let mut held = held();
        let codes = if keys.is_empty() { held.clone() } else { resolve_keys(&keys)? };
        held.retain(|code| !codes.contains(code));
        let reversed: Vec<u32> = codes.into_iter().rev().collect();
        send(&reversed, false)
    }

    pub(crate) fn release_agent_held_keys() {
        let _ = key_up(Vec::new());
    }

    /// Hold keys for a duration on this thread (older callers); the server uses `key_down` and `key_up`.
    #[napi]
    pub fn hold_key(keys: Vec<String>, duration_ms: i32) -> napi::Result<()> {
        key_down(keys.clone())?;
        let sleep_result = crate::activity::interruptible_sleep(std::time::Duration::from_millis(
            duration_ms.max(0) as u64,
        ));
        key_up(keys)?;
        sleep_result
    }
}

// ── macOS implementation ──────────────────────────────────────────────────────
#[cfg(target_os = "macos")]
mod macos {
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, CGKeyCode};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    use napi_derive::napi;
    use std::collections::HashMap;
    use std::sync::OnceLock;

    fn source() -> CGEventSource {
        // Keep synthetic state out of the HID-only physical-user activity
        // clock used by host-side input attribution.
        CGEventSource::new(CGEventSourceStateID::Private).unwrap()
    }

    /// Post at the HID tap (goes to the frontmost app and moves nothing else), or
    /// straight to one process with `CGEventPostToPid` (no activation, no focus
    /// change). Whether a given app acts on pid-posted events is up to the app.
    fn deliver(event: CGEvent, pid: Option<i32>) {
        match pid {
            Some(pid) => event.post_to_pid(pid),
            None => event.post(CGEventTapLocation::HID),
        }
    }

    static KEY_MAP: OnceLock<HashMap<&'static str, CGKeyCode>> = OnceLock::new();

    fn key_code_map() -> &'static HashMap<&'static str, CGKeyCode> {
        KEY_MAP.get_or_init(|| {
            let mut m = HashMap::new();
            m.insert("return", 36);
            m.insert("enter", 36);
            m.insert("tab", 48);
            m.insert("space", 49);
            m.insert("delete", 51);
            m.insert("backspace", 51);
            m.insert("forwarddelete", 117);
            m.insert("escape", 53);
            m.insert("esc", 53);
            m.insert("command", 55);
            m.insert("cmd", 55);
            m.insert("shift", 56);
            m.insert("capslock", 57);
            m.insert("option", 58);
            m.insert("alt", 58);
            m.insert("control", 59);
            m.insert("ctrl", 59);
            m.insert("fn", 63);
            m.insert("f1", 122);
            m.insert("f2", 120);
            m.insert("f3", 99);
            m.insert("f4", 118);
            m.insert("f5", 96);
            m.insert("f6", 97);
            m.insert("f7", 98);
            m.insert("f8", 100);
            m.insert("f9", 101);
            m.insert("f10", 109);
            m.insert("f11", 103);
            m.insert("f12", 111);
            m.insert("f13", 105);
            m.insert("f14", 107);
            m.insert("f15", 113);
            m.insert("f16", 106);
            m.insert("f17", 64);
            m.insert("f18", 79);
            m.insert("f19", 80);
            m.insert("f20", 90);
            m.insert("home", 115);
            m.insert("end", 119);
            m.insert("pageup", 116);
            m.insert("pagedown", 121);
            m.insert("left", 123);
            m.insert("right", 124);
            m.insert("down", 125);
            m.insert("up", 126);
            m.insert("a", 0);
            m.insert("b", 11);
            m.insert("c", 8);
            m.insert("d", 2);
            m.insert("e", 14);
            m.insert("f", 3);
            m.insert("g", 5);
            m.insert("h", 4);
            m.insert("i", 34);
            m.insert("j", 38);
            m.insert("k", 40);
            m.insert("l", 37);
            m.insert("m", 46);
            m.insert("n", 45);
            m.insert("o", 31);
            m.insert("p", 35);
            m.insert("q", 12);
            m.insert("r", 15);
            m.insert("s", 1);
            m.insert("t", 17);
            m.insert("u", 32);
            m.insert("v", 9);
            m.insert("w", 13);
            m.insert("x", 7);
            m.insert("y", 16);
            m.insert("z", 6);
            m.insert("0", 29);
            m.insert("1", 18);
            m.insert("2", 19);
            m.insert("3", 20);
            m.insert("4", 21);
            m.insert("5", 23);
            m.insert("6", 22);
            m.insert("7", 26);
            m.insert("8", 28);
            m.insert("9", 25);
            m.insert("-", 27);
            m.insert("=", 24);
            m.insert("[", 33);
            m.insert("]", 30);
            m.insert("\\", 42);
            m.insert(";", 41);
            m.insert("'", 39);
            m.insert(",", 43);
            m.insert(".", 47);
            m.insert("/", 44);
            // kVK_ANSI_Grave: the key Unreal (and most games) bind the console to.
            m.insert("`", 50);
            m.insert("grave", 50);
            m.insert("backtick", 50);
            m
        })
    }

    fn modifier_flag(name: &str) -> Option<CGEventFlags> {
        match name {
            "command" | "cmd" => Some(CGEventFlags::CGEventFlagCommand),
            "shift" => Some(CGEventFlags::CGEventFlagShift),
            "option" | "alt" => Some(CGEventFlags::CGEventFlagAlternate),
            "control" | "ctrl" => Some(CGEventFlags::CGEventFlagControl),
            "fn" => Some(CGEventFlags::CGEventFlagSecondaryFn),
            _ => None,
        }
    }

    fn key_press_impl(combo: &str, repeat: Option<i32>, pid: Option<i32>) -> napi::Result<()> {
        let map = key_code_map();
        crate::activity::ensure_not_emergency_stopped()?;
        crate::permissions::ensure_input_trusted()?;
        let repeat = repeat.unwrap_or(1);
        let combo_lower = combo.to_lowercase();
        let parts: Vec<&str> = combo_lower.split('+').map(|s| s.trim()).collect();

        let mut flags = CGEventFlags::empty();
        let mut main_key: Option<CGKeyCode> = None;

        for part in &parts {
            if let Some(flag) = modifier_flag(part) {
                flags |= flag;
            } else if let Some(&code) = map.get(part) {
                main_key = Some(code);
            }
        }

        let code = main_key
            .ok_or_else(|| napi::Error::from_reason(format!("Unknown key in combo: {combo}")))?;

        for i in 0..repeat {
            crate::activity::ensure_not_emergency_stopped()?;
            let down = CGEvent::new_keyboard_event(source(), code, true).unwrap();
            down.set_flags(flags);
            deliver(down, pid);
            let up = CGEvent::new_keyboard_event(source(), code, false).unwrap();
            // 7.7.0 (C3): the last event of the chord carries no modifier flags. A flagged final key-up left Shift or
            // Command latched in the window server's modifier state (the class Peekaboo #797 measured).
            up.set_flags(if i == repeat - 1 { CGEventFlags::CGEventFlagNull } else { flags });
            deliver(up, pid);
            if i < repeat - 1 {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }
        Ok(())
    }

    #[napi]
    pub fn key_press(combo: String, repeat: Option<i32>) -> napi::Result<()> {
        key_press_impl(&combo, repeat, None)
    }

    /// Press a key combination in one process without activating it.
    #[napi]
    pub fn key_press_to_pid(pid: i32, combo: String, repeat: Option<i32>) -> napi::Result<()> {
        key_press_impl(&combo, repeat, Some(pid))
    }

    fn type_text_impl(text: &str, pid: Option<i32>) -> napi::Result<()> {
        crate::activity::ensure_not_emergency_stopped()?;
        crate::permissions::ensure_input_trusted()?;
        let chunks = super::utf16_chunks(text, 20);
        let total = chunks.len();
        for (index, chunk) in chunks.iter().enumerate() {
            // 7.7.0 (C4): stopped part-way is an error that says how far it got, never a silent success.
            if crate::activity::emergency_stop_active() {
                return Err(napi::Error::from_reason(format!(
                    "EmergencyStop: typing stopped after {index} of {total} chunks; host reset required"
                )));
            }
            let down = CGEvent::new_keyboard_event(source(), 0, true).unwrap();
            down.set_string_from_utf16_unchecked(chunk);
            deliver(down, pid);
            let up = CGEvent::new_keyboard_event(source(), 0, false).unwrap();
            deliver(up, pid);
            std::thread::sleep(std::time::Duration::from_millis(3));
        }
        Ok(())
    }

    #[napi]
    pub fn type_text(text: String) -> napi::Result<()> {
        type_text_impl(&text, None)
    }

    /// Type Unicode text into one process without activating it.
    #[napi]
    pub fn type_text_to_pid(pid: i32, text: String) -> napi::Result<()> {
        type_text_impl(&text, Some(pid))
    }

    // ── Character → key event table (`type mode:"keys"`) ──────────────────────

    #[derive(Clone, Copy)]
    struct KeyStroke {
        code: CGKeyCode,
        shift: bool,
        option: bool,
    }

    static CHAR_TABLE: OnceLock<(HashMap<char, KeyStroke>, &'static str)> = OnceLock::new();

    #[allow(non_upper_case_globals)]
    extern "C" {
        fn pthread_main_np() -> i32;
        fn TISCopyCurrentKeyboardLayoutInputSource() -> *mut std::ffi::c_void;
        fn TISGetInputSourceProperty(
            source: *mut std::ffi::c_void,
            key: *const std::ffi::c_void,
        ) -> *const std::ffi::c_void;
        static kTISPropertyUnicodeKeyLayoutData: *const std::ffi::c_void;
        fn CFDataGetBytePtr(data: *const std::ffi::c_void) -> *const u8;
        fn CFRelease(cf: *const std::ffi::c_void);
        fn LMGetKbdType() -> u8;
        fn UCKeyTranslate(
            layout: *const u8,
            virtual_key_code: u16,
            key_action: u16,
            modifier_key_state: u32,
            keyboard_type: u32,
            key_translate_options: u32,
            dead_key_state: *mut u32,
            max_string_length: usize,
            actual_string_length: *mut usize,
            unicode_string: *mut u16,
        ) -> i32;
    }

    /// Keypad codes: never chosen for a character, so "1" is the main-row 1.
    fn is_keypad(code: u16) -> bool {
        matches!(code, 65 | 67 | 69 | 71 | 75 | 76 | 78 | 81..=92)
    }

    /// Reverse the current keyboard layout with UCKeyTranslate: for every virtual
    /// key, with no modifier / shift / option / shift+option, record which single
    /// character it produces. The first (least-modified) mapping wins.
    ///
    /// Text Input Sources must be read on the main thread (macOS 14 asserts it);
    /// Node calls native functions on its main thread, but a worker thread would
    /// not, so off the main thread the US-ANSI table is used instead.
    fn layout_table() -> Option<HashMap<char, KeyStroke>> {
        unsafe {
            if pthread_main_np() == 0 {
                return None;
            }
            let source = TISCopyCurrentKeyboardLayoutInputSource();
            if source.is_null() {
                return None;
            }
            let data = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData);
            if data.is_null() {
                CFRelease(source);
                return None;
            }
            let layout = CFDataGetBytePtr(data);
            let kbd_type = LMGetKbdType() as u32;
            let mut table: HashMap<char, KeyStroke> = HashMap::new();
            // (modifierKeyState = EventModifiers >> 8): shift 0x02, option 0x08.
            for (state, shift, option) in [
                (0u32, false, false),
                (2, true, false),
                (8, false, true),
                (10, true, true),
            ] {
                for code in 0u16..128 {
                    if is_keypad(code) {
                        continue;
                    }
                    let mut dead: u32 = 0;
                    let mut len: usize = 0;
                    let mut buf = [0u16; 4];
                    // kUCKeyActionDown = 0, kUCKeyTranslateNoDeadKeysMask = 1
                    let status = UCKeyTranslate(
                        layout,
                        code,
                        0,
                        state,
                        kbd_type,
                        1,
                        &mut dead,
                        4,
                        &mut len,
                        buf.as_mut_ptr(),
                    );
                    if status != 0 || len != 1 {
                        continue;
                    }
                    if let Some(ch) = char::from_u32(buf[0] as u32) {
                        if ch.is_control() {
                            continue;
                        }
                        table.entry(ch).or_insert(KeyStroke {
                            code,
                            shift,
                            option,
                        });
                    }
                }
            }
            CFRelease(source);
            if table.len() < 40 {
                None
            } else {
                Some(table)
            }
        }
    }

    /// US-ANSI fallback: the physical keys for printable ASCII.
    fn us_ansi_table() -> HashMap<char, KeyStroke> {
        let map = key_code_map();
        let mut table = HashMap::new();
        let plain = "abcdefghijklmnopqrstuvwxyz0123456789-=[]\\;',./`";
        for ch in plain.chars() {
            let code = map[ch.to_string().as_str()];
            table.insert(
                ch,
                KeyStroke {
                    code,
                    shift: false,
                    option: false,
                },
            );
        }
        for ch in 'A'..='Z' {
            let code = map[ch.to_ascii_lowercase().to_string().as_str()];
            table.insert(
                ch,
                KeyStroke {
                    code,
                    shift: true,
                    option: false,
                },
            );
        }
        let shifted = [
            ('!', '1'),
            ('@', '2'),
            ('#', '3'),
            ('$', '4'),
            ('%', '5'),
            ('^', '6'),
            ('&', '7'),
            ('*', '8'),
            ('(', '9'),
            (')', '0'),
            ('_', '-'),
            ('+', '='),
            ('{', '['),
            ('}', ']'),
            ('|', '\\'),
            (':', ';'),
            ('"', '\''),
            ('<', ','),
            ('>', '.'),
            ('?', '/'),
            ('~', '`'),
        ];
        for (ch, base) in shifted {
            let code = map[base.to_string().as_str()];
            table.insert(
                ch,
                KeyStroke {
                    code,
                    shift: true,
                    option: false,
                },
            );
        }
        table.insert(
            ' ',
            KeyStroke {
                code: 49,
                shift: false,
                option: false,
            },
        );
        table
    }

    fn char_table() -> &'static (HashMap<char, KeyStroke>, &'static str) {
        CHAR_TABLE.get_or_init(|| match layout_table() {
            Some(table) => (table, "current_layout"),
            None => (us_ansi_table(), "us_ansi"),
        })
    }

    fn type_keys_impl(text: &str, pid: Option<i32>) -> napi::Result<serde_json::Value> {
        crate::permissions::ensure_input_trusted()?;
        crate::activity::ensure_not_emergency_stopped()?;
        let (table, layout) = char_table();
        let mut as_keys = 0u32;
        let mut as_text = 0u32;
        for ch in text.chars() {
            crate::activity::ensure_not_emergency_stopped()?;
            let stroke = match ch {
                '\n' | '\r' => Some(KeyStroke {
                    code: 36,
                    shift: false,
                    option: false,
                }),
                '\t' => Some(KeyStroke {
                    code: 48,
                    shift: false,
                    option: false,
                }),
                _ => table.get(&ch).copied(),
            };
            if ch == '\r' {
                continue;
            }
            match stroke {
                Some(stroke) => {
                    let mut flags = CGEventFlags::empty();
                    if stroke.shift {
                        flags |= CGEventFlags::CGEventFlagShift;
                    }
                    if stroke.option {
                        flags |= CGEventFlags::CGEventFlagAlternate;
                    }
                    let down = CGEvent::new_keyboard_event(source(), stroke.code, true).unwrap();
                    down.set_flags(flags);
                    deliver(down, pid);
                    let up = CGEvent::new_keyboard_event(source(), stroke.code, false).unwrap();
                    // No flags on the key-up, so Shift or Option never stays latched after the text (7.7.0, C3).
                    up.set_flags(CGEventFlags::CGEventFlagNull);
                    deliver(up, pid);
                    as_keys += 1;
                }
                None => {
                    let mut buf = [0u8; 4];
                    type_text_impl(ch.encode_utf8(&mut buf), pid)?;
                    as_text += 1;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(4));
        }
        Ok(serde_json::json!({ "keys": as_keys, "unicode": as_text, "layout": layout }))
    }

    /// Type each character as the key-down/key-up of its virtual key (with shift or
    /// option when the layout needs it), so apps that bind keys rather than read
    /// text — a game console on the grave/tilde key — receive them. Characters the
    /// layout cannot produce fall back to Unicode text.
    #[napi]
    pub fn type_keys(text: String) -> napi::Result<serde_json::Value> {
        type_keys_impl(&text, None)
    }

    /// `type_keys`, delivered to one process without activating it.
    #[napi]
    pub fn type_keys_to_pid(pid: i32, text: String) -> napi::Result<serde_json::Value> {
        type_keys_impl(&text, Some(pid))
    }

    // ── Held keys (7.7.0, C1/C2/C6) ─────────────────────────────────────────

    /// Keys this process pressed and has not released, in press order, with their modifier flag. The emergency latch
    /// releases them; `key_up` releases them by name. Releases are never refused by the latch.
    static HELD_KEYS: std::sync::Mutex<Vec<(CGKeyCode, CGEventFlags)>> = std::sync::Mutex::new(Vec::new());

    fn held() -> std::sync::MutexGuard<'static, Vec<(CGKeyCode, CGEventFlags)>> {
        HELD_KEYS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Resolve every name before pressing anything, so an unknown key never leaves the earlier ones held.
    fn resolve_keys(keys: &[String]) -> napi::Result<Vec<(CGKeyCode, CGEventFlags)>> {
        let map = key_code_map();
        let mut resolved = Vec::with_capacity(keys.len());
        let mut unknown = Vec::new();
        for k in keys {
            let lower = k.to_lowercase();
            match map.get(lower.as_str()) {
                Some(&code) => resolved.push((code, modifier_flag(&lower).unwrap_or(CGEventFlags::empty()))),
                None => unknown.push(k.clone()),
            }
        }
        if unknown.is_empty() {
            Ok(resolved)
        } else {
            Err(napi::Error::from_reason(format!("Unknown key: {}", unknown.join(", "))))
        }
    }

    fn held_flags(keys: &[(CGKeyCode, CGEventFlags)]) -> CGEventFlags {
        keys.iter().fold(CGEventFlags::CGEventFlagNull, |flags, (_, flag)| flags | *flag)
    }

    /// Press keys and keep them down until `key_up` (or the emergency latch) releases them. Each key-down carries the
    /// flags of every modifier held so far, as a real keyboard would.
    #[napi]
    pub fn key_down(keys: Vec<String>) -> napi::Result<()> {
        let resolved = resolve_keys(&keys)?;
        crate::activity::ensure_not_emergency_stopped()?;
        crate::permissions::ensure_input_trusted()?;
        let mut held = held();
        for (code, flag) in resolved {
            if held.iter().any(|(held_code, _)| *held_code == code) {
                continue;
            }
            held.push((code, flag));
            let down = CGEvent::new_keyboard_event(source(), code, true)
                .map_err(|_| napi::Error::from_reason("Could not create key event"))?;
            down.set_flags(held_flags(&held));
            deliver(down, None);
        }
        Ok(())
    }

    fn release(code: CGKeyCode, held: &mut Vec<(CGKeyCode, CGEventFlags)>) {
        held.retain(|(held_code, _)| *held_code != code);
        if let Ok(up) = CGEvent::new_keyboard_event(source(), code, false) {
            // The flags of what is still held; none once the last key is up (C3).
            up.set_flags(held_flags(held));
            deliver(up, None);
        }
    }

    /// Release keys pressed by `key_down`, in reverse order; an empty list releases everything held. Not refused by
    /// the emergency latch: a release is always safe.
    #[napi]
    pub fn key_up(keys: Vec<String>) -> napi::Result<()> {
        let mut held = held();
        let codes: Vec<CGKeyCode> = if keys.is_empty() {
            held.iter().map(|(code, _)| *code).collect()
        } else {
            resolve_keys(&keys)?.into_iter().map(|(code, _)| code).collect()
        };
        for code in codes.into_iter().rev() {
            release(code, &mut held);
        }
        Ok(())
    }

    pub(crate) fn release_agent_held_keys() {
        let mut held = held();
        let codes: Vec<CGKeyCode> = held.iter().map(|(code, _)| *code).collect();
        for code in codes.into_iter().rev() {
            release(code, &mut held);
        }
    }

    /// Hold keys for a duration on this thread. The server holds keys with `key_down`, an awaited timer and `key_up`
    /// instead (7.7.0), so the event loop stays free; this stays for older callers, and releases on every exit.
    #[napi]
    pub fn hold_key(keys: Vec<String>, duration_ms: i32) -> napi::Result<()> {
        key_down(keys.clone())?;
        let sleep_result = crate::activity::interruptible_sleep(std::time::Duration::from_millis(
            duration_ms.max(0) as u64,
        ));
        key_up(keys)?;
        sleep_result
    }
}

// ── Windows implementation ───────────────────────────────────────────────────
#[cfg(target_os = "windows")]
mod win {
    use napi_derive::napi;
    use std::collections::HashMap;
    use std::sync::OnceLock;
    use windows::Win32::UI::Input::KeyboardAndMouse::*;

    static WIN_KEY_MAP: OnceLock<HashMap<&'static str, VIRTUAL_KEY>> = OnceLock::new();

    fn key_map() -> &'static HashMap<&'static str, VIRTUAL_KEY> {
        WIN_KEY_MAP.get_or_init(|| {
            let mut m = HashMap::new();
            m.insert("return", VK_RETURN);
            m.insert("enter", VK_RETURN);
            m.insert("tab", VK_TAB);
            m.insert("space", VK_SPACE);
            m.insert("backspace", VK_BACK);
            m.insert("delete", VK_DELETE);
            m.insert("forwarddelete", VK_DELETE);
            m.insert("escape", VK_ESCAPE);
            m.insert("esc", VK_ESCAPE);
            // Modifiers
            m.insert("command", VK_LWIN);
            m.insert("cmd", VK_LWIN);
            m.insert("super", VK_LWIN);
            m.insert("win", VK_LWIN);
            m.insert("meta", VK_LWIN);
            m.insert("shift", VK_SHIFT);
            m.insert("control", VK_CONTROL);
            m.insert("ctrl", VK_CONTROL);
            m.insert("option", VK_MENU);
            m.insert("alt", VK_MENU);
            m.insert("fn", VK_F24); // no direct equiv
            m.insert("capslock", VK_CAPITAL);
            // Function keys, F1–F20 (7.7.0: F13–F20 were accepted by the server and missing here)
            for (i, name) in ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12", "f13", "f14",
                "f15", "f16", "f17", "f18", "f19", "f20"].into_iter().enumerate()
            {
                m.insert(name, VIRTUAL_KEY(VK_F1.0 + i as u16));
            }
            // Navigation
            m.insert("home", VK_HOME);
            m.insert("end", VK_END);
            m.insert("pageup", VK_PRIOR);
            m.insert("pagedown", VK_NEXT);
            m.insert("left", VK_LEFT);
            m.insert("right", VK_RIGHT);
            m.insert("down", VK_DOWN);
            m.insert("up", VK_UP);
            // Letters a-z
            for (i, c) in ('a'..='z').enumerate() {
                // VK_A = 0x41
                let s: &'static str = Box::leak(c.to_string().into_boxed_str());
                m.insert(s, VIRTUAL_KEY(0x41 + i as u16));
            }
            // Digits 0-9
            for (i, c) in ('0'..='9').enumerate() {
                let s: &'static str = Box::leak(c.to_string().into_boxed_str());
                m.insert(s, VIRTUAL_KEY(0x30 + i as u16));
            }
            // Symbols
            m.insert("-", VK_OEM_MINUS);
            m.insert("=", VK_OEM_PLUS);
            m.insert("[", VK_OEM_4);
            m.insert("]", VK_OEM_6);
            m.insert("\\", VK_OEM_5);
            m.insert(";", VK_OEM_1);
            m.insert("'", VK_OEM_7);
            m.insert(",", VK_OEM_COMMA);
            m.insert(".", VK_OEM_PERIOD);
            m.insert("/", VK_OEM_2);
            m.insert("`", VK_OEM_3);
            m
        })
    }

    fn is_modifier(vk: VIRTUAL_KEY) -> bool {
        matches!(
            vk,
            VK_SHIFT | VK_CONTROL | VK_MENU | VK_LWIN | VK_RWIN | VK_CAPITAL | VK_F24
        )
    }

    /// Send input events in one atomic `SendInput` call. 7.7.0 (W2): `SendInput` returns how many events it inserted
    /// and does not signal input blocked by UIPI any other way; fewer than asked is now an error, not a success.
    pub(crate) fn send_inputs(inputs: &[INPUT]) -> napi::Result<()> {
        if inputs.is_empty() {
            return Ok(());
        }
        let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) } as usize;
        if sent == inputs.len() {
            Ok(())
        } else {
            Err(napi::Error::from_reason(format!(
                "input_blocked: Windows accepted {sent} of {} input events. The foreground window may belong to an \
                 elevated (administrator) process, or the lock screen or a UAC prompt is up; Windows blocks input to \
                 those from a normal process.",
                inputs.len()
            )))
        }
    }

    fn key_input(vk: VIRTUAL_KEY, down: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: if down { KEYBD_EVENT_FLAGS(0) } else { KEYEVENTF_KEYUP },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    #[napi]
    pub fn key_press(combo: String, repeat: Option<i32>) -> napi::Result<()> {
        crate::activity::ensure_not_emergency_stopped()?;
        let map = key_map();
        let repeat = repeat.unwrap_or(1);
        let combo_lower = combo.to_lowercase();
        let parts: Vec<&str> = combo_lower.split('+').map(|s| s.trim()).collect();

        let mut modifiers: Vec<VIRTUAL_KEY> = Vec::new();
        let mut main_key: Option<VIRTUAL_KEY> = None;

        for part in &parts {
            if let Some(&vk) = map.get(part) {
                if is_modifier(vk) {
                    modifiers.push(vk);
                } else {
                    main_key = Some(vk);
                }
            }
        }

        let key = main_key
            .ok_or_else(|| napi::Error::from_reason(format!("Unknown key in combo: {combo}")))?;

        for i in 0..repeat {
            crate::activity::ensure_not_emergency_stopped()?;
            // The whole chord in one SendInput: atomic, so a failure can never leave a modifier down.
            let mut chord: Vec<INPUT> = modifiers.iter().map(|m| key_input(*m, true)).collect();
            chord.push(key_input(key, true));
            chord.push(key_input(key, false));
            chord.extend(modifiers.iter().rev().map(|m| key_input(*m, false)));
            send_inputs(&chord)?;
            if i < repeat - 1 {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }
        Ok(())
    }

    #[napi]
    pub fn type_text(text: String) -> napi::Result<()> {
        // 7.7.0 (C4): a latched call is an error, not a silent success.
        crate::activity::ensure_not_emergency_stopped()?;
        // Build ALL key events up front and dispatch them in a single SendInput
        // call. Sending one char per SendInput (with a sleep between) races the
        // target app's message pump and intermittently drops characters on
        // UWP/RichEdit controls (e.g. Windows 11 Notepad). A batched SendInput
        // is atomic and reliably queued, so no characters are lost.
        let unicode_event = |ch: u16, key_up: bool| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0),
                    wScan: ch,
                    dwFlags: if key_up {
                        KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
                    } else {
                        KEYEVENTF_UNICODE
                    },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        // Every UTF-16 code unit as a KEYEVENTF_UNICODE down/up pair, except line breaks: "\n" is a real Enter
        // (VK_RETURN), because a bare KEYEVENTF_UNICODE 0x0A is ignored by many editors (7.7.0, W5), and "\r" is
        // skipped so "\r\n" is one Enter. Long or multi-line text normally takes the session's clipboard route.
        let mut inputs: Vec<INPUT> = Vec::with_capacity(text.encode_utf16().count() * 2);
        for ch in text.encode_utf16() {
            match ch {
                0x0D => {}
                0x0A => {
                    inputs.push(key_input(VK_RETURN, true));
                    inputs.push(key_input(VK_RETURN, false));
                }
                _ => {
                    inputs.push(unicode_event(ch, false));
                    inputs.push(unicode_event(ch, true));
                }
            }
        }
        send_inputs(&inputs)
    }

    // ── Held keys (7.7.0, C1/C2/C6) ─────────────────────────────────────────

    /// Keys this process pressed and has not released, in press order; released by `key_up` or the emergency latch.
    static HELD_KEYS: std::sync::Mutex<Vec<VIRTUAL_KEY>> = std::sync::Mutex::new(Vec::new());

    fn held() -> std::sync::MutexGuard<'static, Vec<VIRTUAL_KEY>> {
        HELD_KEYS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Resolve every name before pressing anything, so an unknown key never leaves the earlier ones held.
    fn resolve_keys(keys: &[String]) -> napi::Result<Vec<VIRTUAL_KEY>> {
        let map = key_map();
        let mut resolved = Vec::with_capacity(keys.len());
        let mut unknown = Vec::new();
        for k in keys {
            match map.get(k.to_lowercase().as_str()) {
                Some(&vk) => resolved.push(vk),
                None => unknown.push(k.clone()),
            }
        }
        if unknown.is_empty() {
            Ok(resolved)
        } else {
            Err(napi::Error::from_reason(format!("Unknown key: {}", unknown.join(", "))))
        }
    }

    /// Press keys and keep them down until `key_up` (or the emergency latch) releases them.
    #[napi]
    pub fn key_down(keys: Vec<String>) -> napi::Result<()> {
        let resolved = resolve_keys(&keys)?;
        crate::activity::ensure_not_emergency_stopped()?;
        let mut held = held();
        let fresh: Vec<VIRTUAL_KEY> = resolved.into_iter().filter(|vk| !held.contains(vk)).collect();
        let downs: Vec<INPUT> = fresh.iter().map(|vk| key_input(*vk, true)).collect();
        send_inputs(&downs)?;
        held.extend(fresh);
        Ok(())
    }

    fn release(vks: Vec<VIRTUAL_KEY>, held: &mut Vec<VIRTUAL_KEY>) -> napi::Result<()> {
        held.retain(|vk| !vks.contains(vk));
        let ups: Vec<INPUT> = vks.iter().rev().map(|vk| key_input(*vk, false)).collect();
        send_inputs(&ups)
    }

    /// Release keys pressed by `key_down`, in reverse order; an empty list releases everything held. Not refused by
    /// the emergency latch.
    #[napi]
    pub fn key_up(keys: Vec<String>) -> napi::Result<()> {
        let mut held = held();
        let vks = if keys.is_empty() { held.clone() } else { resolve_keys(&keys)? };
        release(vks, &mut held)
    }

    pub(crate) fn release_agent_held_keys() {
        let mut held = held();
        let vks = held.clone();
        let _ = release(vks, &mut held);
    }

    /// Hold keys for a duration on this thread (older callers); the server uses `key_down` and `key_up`.
    #[napi]
    pub fn hold_key(keys: Vec<String>, duration_ms: i32) -> napi::Result<()> {
        key_down(keys.clone())?;
        let sleep_result = crate::activity::interruptible_sleep(std::time::Duration::from_millis(
            duration_ms.max(0) as u64,
        ));
        key_up(keys)?;
        sleep_result
    }
}

/// Split text into UTF-16 chunks of at most `max` code units without splitting a surrogate pair (7.7.0, C5): a chunk
/// boundary inside an emoji's pair typed two broken halves.
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
pub(crate) fn utf16_chunks(text: &str, max: usize) -> Vec<Vec<u16>> {
    let mut chunks: Vec<Vec<u16>> = Vec::new();
    let mut current: Vec<u16> = Vec::with_capacity(max);
    let mut buffer = [0u16; 2];
    for ch in text.chars() {
        let units = ch.encode_utf16(&mut buffer);
        if !current.is_empty() && current.len() + units.len() > max.max(2) {
            chunks.push(std::mem::take(&mut current));
        }
        current.extend_from_slice(units);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

/// Release every key this process holds. Called on the emergency latch's own thread; never refused by the latch.
pub(crate) fn release_agent_held_keys() {
    #[cfg(target_os = "macos")]
    macos::release_agent_held_keys();
    #[cfg(target_os = "windows")]
    win::release_agent_held_keys();
    #[cfg(target_os = "linux")]
    linux::release_agent_held_keys();
}

#[cfg(target_os = "windows")]
pub(crate) use win::send_inputs;

#[cfg(test)]
mod tests {
    use super::utf16_chunks;

    #[test]
    fn chunks_never_split_a_surrogate_pair() {
        // 19 ASCII letters then an emoji (2 units): the emoji moves whole into the next chunk.
        let text = format!("{}😀tail", "a".repeat(19));
        let chunks = utf16_chunks(&text, 20);
        assert_eq!(chunks[0].len(), 19);
        for chunk in &chunks {
            assert!(String::from_utf16(chunk).is_ok(), "every chunk is valid UTF-16");
            assert!(chunk.len() <= 20);
        }
        let joined: Vec<u16> = chunks.concat();
        assert_eq!(String::from_utf16(&joined).unwrap(), text);
    }

    #[test]
    fn chunking_keeps_all_text_and_handles_the_edges() {
        assert!(utf16_chunks("", 20).is_empty());
        assert_eq!(utf16_chunks("abc", 20), vec!["abc".encode_utf16().collect::<Vec<u16>>()]);
        let emoji = "😀".repeat(15); // 30 units
        let chunks = utf16_chunks(&emoji, 20);
        assert_eq!(chunks.iter().map(Vec::len).collect::<Vec<_>>(), vec![20, 10]);
    }
}
