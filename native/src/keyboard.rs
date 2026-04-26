// ── macOS implementation ──────────────────────────────────────────────────────
#[cfg(target_os = "macos")]
mod macos {
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, CGKeyCode};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    use napi_derive::napi;
    use std::collections::HashMap;
    use std::sync::OnceLock;

    fn source() -> CGEventSource {
        CGEventSource::new(CGEventSourceStateID::HIDSystemState).unwrap()
    }

    fn post(event: CGEvent) {
        event.post(CGEventTapLocation::HID);
    }

    static KEY_MAP: OnceLock<HashMap<&'static str, CGKeyCode>> = OnceLock::new();

    fn key_code_map() -> &'static HashMap<&'static str, CGKeyCode> {
        KEY_MAP.get_or_init(|| {
            let mut m = HashMap::new();
            m.insert("return", 36); m.insert("enter", 36);
            m.insert("tab", 48); m.insert("space", 49);
            m.insert("delete", 51); m.insert("backspace", 51);
            m.insert("escape", 53); m.insert("esc", 53);
            m.insert("command", 55); m.insert("cmd", 55);
            m.insert("shift", 56); m.insert("capslock", 57);
            m.insert("option", 58); m.insert("alt", 58);
            m.insert("control", 59); m.insert("ctrl", 59);
            m.insert("fn", 63);
            m.insert("f1", 122); m.insert("f2", 120); m.insert("f3", 99);
            m.insert("f4", 118); m.insert("f5", 96); m.insert("f6", 97);
            m.insert("f7", 98); m.insert("f8", 100); m.insert("f9", 101);
            m.insert("f10", 109); m.insert("f11", 103); m.insert("f12", 111);
            m.insert("home", 115); m.insert("end", 119);
            m.insert("pageup", 116); m.insert("pagedown", 121);
            m.insert("left", 123); m.insert("right", 124);
            m.insert("down", 125); m.insert("up", 126);
            m.insert("a", 0); m.insert("b", 11); m.insert("c", 8);
            m.insert("d", 2); m.insert("e", 14); m.insert("f", 3);
            m.insert("g", 5); m.insert("h", 4); m.insert("i", 34);
            m.insert("j", 38); m.insert("k", 40); m.insert("l", 37);
            m.insert("m", 46); m.insert("n", 45); m.insert("o", 31);
            m.insert("p", 35); m.insert("q", 12); m.insert("r", 15);
            m.insert("s", 1); m.insert("t", 17); m.insert("u", 32);
            m.insert("v", 9); m.insert("w", 13); m.insert("x", 7);
            m.insert("y", 16); m.insert("z", 6);
            m.insert("0", 29); m.insert("1", 18); m.insert("2", 19);
            m.insert("3", 20); m.insert("4", 21); m.insert("5", 23);
            m.insert("6", 22); m.insert("7", 26); m.insert("8", 28);
            m.insert("9", 25);
            m.insert("-", 27); m.insert("=", 24); m.insert("[", 33);
            m.insert("]", 30); m.insert("\\", 42); m.insert(";", 41);
            m.insert("'", 39); m.insert(",", 43); m.insert(".", 47);
            m.insert("/", 44); m.insert("`", 50);
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

    #[napi]
    pub fn key_press(combo: String, repeat: Option<i32>) -> napi::Result<()> {
        let map = key_code_map();
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
            let down = CGEvent::new_keyboard_event(source(), code, true).unwrap();
            down.set_flags(flags);
            post(down);
            let up = CGEvent::new_keyboard_event(source(), code, false).unwrap();
            up.set_flags(flags);
            post(up);
            if i < repeat - 1 {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }
        Ok(())
    }

    #[napi]
    pub fn type_text(text: String) {
        let chars: Vec<u16> = text.encode_utf16().collect();
        for chunk in chars.chunks(20) {
            let down = CGEvent::new_keyboard_event(source(), 0, true).unwrap();
            down.set_string_from_utf16_unchecked(chunk);
            post(down);
            let up = CGEvent::new_keyboard_event(source(), 0, false).unwrap();
            post(up);
            std::thread::sleep(std::time::Duration::from_millis(3));
        }
    }

    #[napi]
    pub fn hold_key(keys: Vec<String>, duration_ms: i32) -> napi::Result<()> {
        let map = key_code_map();
        let mut pressed: Vec<(CGKeyCode, CGEventFlags)> = Vec::new();

        for k in &keys {
            let lower = k.to_lowercase();
            let flag = modifier_flag(&lower).unwrap_or(CGEventFlags::empty());
            let code = map
                .get(lower.as_str())
                .copied()
                .ok_or_else(|| napi::Error::from_reason(format!("Unknown key: {k}")))?;
            let down = CGEvent::new_keyboard_event(source(), code, true).unwrap();
            down.set_flags(flag);
            post(down);
            pressed.push((code, flag));
        }

        std::thread::sleep(std::time::Duration::from_millis(duration_ms as u64));

        for (code, flags) in pressed.into_iter().rev() {
            let up = CGEvent::new_keyboard_event(source(), code, false).unwrap();
            up.set_flags(flags);
            post(up);
        }
        Ok(())
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
            m.insert("return", VK_RETURN); m.insert("enter", VK_RETURN);
            m.insert("tab", VK_TAB); m.insert("space", VK_SPACE);
            m.insert("backspace", VK_BACK); m.insert("delete", VK_DELETE);
            m.insert("escape", VK_ESCAPE); m.insert("esc", VK_ESCAPE);
            // Modifiers
            m.insert("command", VK_LWIN); m.insert("cmd", VK_LWIN);
            m.insert("super", VK_LWIN); m.insert("win", VK_LWIN);
            m.insert("shift", VK_SHIFT); m.insert("control", VK_CONTROL);
            m.insert("ctrl", VK_CONTROL); m.insert("option", VK_MENU);
            m.insert("alt", VK_MENU); m.insert("fn", VK_F24); // no direct equiv
            m.insert("capslock", VK_CAPITAL);
            // Function keys
            m.insert("f1", VK_F1); m.insert("f2", VK_F2); m.insert("f3", VK_F3);
            m.insert("f4", VK_F4); m.insert("f5", VK_F5); m.insert("f6", VK_F6);
            m.insert("f7", VK_F7); m.insert("f8", VK_F8); m.insert("f9", VK_F9);
            m.insert("f10", VK_F10); m.insert("f11", VK_F11); m.insert("f12", VK_F12);
            // Navigation
            m.insert("home", VK_HOME); m.insert("end", VK_END);
            m.insert("pageup", VK_PRIOR); m.insert("pagedown", VK_NEXT);
            m.insert("left", VK_LEFT); m.insert("right", VK_RIGHT);
            m.insert("down", VK_DOWN); m.insert("up", VK_UP);
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
            m.insert("-", VK_OEM_MINUS); m.insert("=", VK_OEM_PLUS);
            m.insert("[", VK_OEM_4); m.insert("]", VK_OEM_6);
            m.insert("\\", VK_OEM_5); m.insert(";", VK_OEM_1);
            m.insert("'", VK_OEM_7); m.insert(",", VK_OEM_COMMA);
            m.insert(".", VK_OEM_PERIOD); m.insert("/", VK_OEM_2);
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

    fn send_key(vk: VIRTUAL_KEY, down: bool) {
        let flags = if down {
            KEYBD_EVENT_FLAGS(0)
        } else {
            KEYEVENTF_KEYUP
        };
        let input = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
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
    pub fn key_press(combo: String, repeat: Option<i32>) -> napi::Result<()> {
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
            for &m in &modifiers {
                send_key(m, true);
            }
            send_key(key, true);
            send_key(key, false);
            for m in modifiers.iter().rev() {
                send_key(*m, false);
            }
            if i < repeat - 1 {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }
        Ok(())
    }

    #[napi]
    pub fn type_text(text: String) {
        // Use KEYEVENTF_UNICODE for each UTF-16 code unit
        let chars: Vec<u16> = text.encode_utf16().collect();
        for &ch in &chars {
            let down = INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VIRTUAL_KEY(0),
                        wScan: ch,
                        dwFlags: KEYEVENTF_UNICODE,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            };
            let up = INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VIRTUAL_KEY(0),
                        wScan: ch,
                        dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            };
            unsafe {
                SendInput(&[down, up], std::mem::size_of::<INPUT>() as i32);
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }

    #[napi]
    pub fn hold_key(keys: Vec<String>, duration_ms: i32) -> napi::Result<()> {
        let map = key_map();
        let mut pressed: Vec<VIRTUAL_KEY> = Vec::new();

        for k in &keys {
            let lower = k.to_lowercase();
            let vk = map
                .get(lower.as_str())
                .copied()
                .ok_or_else(|| napi::Error::from_reason(format!("Unknown key: {k}")))?;
            send_key(vk, true);
            pressed.push(vk);
        }

        std::thread::sleep(std::time::Duration::from_millis(duration_ms as u64));

        for vk in pressed.into_iter().rev() {
            send_key(vk, false);
        }
        Ok(())
    }
}
