use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, CGKeyCode};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use napi_derive::napi;
use std::collections::HashMap;

fn source() -> CGEventSource {
    CGEventSource::new(CGEventSourceStateID::HIDSystemState).unwrap()
}

fn post(event: CGEvent) {
    event.post(CGEventTapLocation::HID);
}

fn key_code_map() -> HashMap<&'static str, CGKeyCode> {
    let mut m = HashMap::new();
    m.insert("return", 36); m.insert("enter", 36); m.insert("tab", 48);
    m.insert("space", 49); m.insert("delete", 51); m.insert("backspace", 51);
    m.insert("escape", 53); m.insert("esc", 53);
    m.insert("command", 55); m.insert("cmd", 55);
    m.insert("shift", 56); m.insert("capslock", 57);
    m.insert("option", 58); m.insert("alt", 58);
    m.insert("control", 59); m.insert("ctrl", 59); m.insert("fn", 63);
    m.insert("f1", 122); m.insert("f2", 120); m.insert("f3", 99); m.insert("f4", 118);
    m.insert("f5", 96); m.insert("f6", 97); m.insert("f7", 98); m.insert("f8", 100);
    m.insert("f9", 101); m.insert("f10", 109); m.insert("f11", 103); m.insert("f12", 111);
    m.insert("home", 115); m.insert("end", 119);
    m.insert("pageup", 116); m.insert("pagedown", 121);
    m.insert("left", 123); m.insert("right", 124); m.insert("down", 125); m.insert("up", 126);
    // Letters
    m.insert("a", 0); m.insert("b", 11); m.insert("c", 8); m.insert("d", 2);
    m.insert("e", 14); m.insert("f", 3); m.insert("g", 5); m.insert("h", 4);
    m.insert("i", 34); m.insert("j", 38); m.insert("k", 40); m.insert("l", 37);
    m.insert("m", 46); m.insert("n", 45); m.insert("o", 31); m.insert("p", 35);
    m.insert("q", 12); m.insert("r", 15); m.insert("s", 1); m.insert("t", 17);
    m.insert("u", 32); m.insert("v", 9); m.insert("w", 13); m.insert("x", 7);
    m.insert("y", 16); m.insert("z", 6);
    // Numbers
    m.insert("0", 29); m.insert("1", 18); m.insert("2", 19); m.insert("3", 20);
    m.insert("4", 21); m.insert("5", 23); m.insert("6", 22); m.insert("7", 26);
    m.insert("8", 28); m.insert("9", 25);
    // Symbols
    m.insert("-", 27); m.insert("=", 24); m.insert("[", 33); m.insert("]", 30);
    m.insert("\\", 42); m.insert(";", 41); m.insert("'", 39);
    m.insert(",", 43); m.insert(".", 47); m.insert("/", 44); m.insert("`", 50);
    m
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
pub fn key_press(combo: String, repeat: Option<i32>) {
    let map = key_code_map();
    let repeat = repeat.unwrap_or(1);
    let parts: Vec<&str> = combo.to_lowercase().leak().split('+').map(|s| s.trim()).collect();

    let mut flags = CGEventFlags::empty();
    let mut main_key: Option<CGKeyCode> = None;

    for part in &parts {
        if let Some(flag) = modifier_flag(part) {
            flags |= flag;
        } else if let Some(&code) = map.get(part) {
            main_key = Some(code);
        }
    }

    let code = match main_key {
        Some(c) => c,
        None => return,
    };

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
}

#[napi]
pub fn type_text(text: String) {
    // Type via CGEvent with Unicode string — handles all characters
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
pub fn hold_key(keys: Vec<String>, duration_ms: i32) {
    let map = key_code_map();
    let mut pressed: Vec<(CGKeyCode, CGEventFlags)> = Vec::new();

    for k in &keys {
        let lower = k.to_lowercase();
        let flag = modifier_flag(&lower).unwrap_or(CGEventFlags::empty());
        if let Some(&code) = map.get(lower.as_str()) {
            let down = CGEvent::new_keyboard_event(source(), code, true).unwrap();
            down.set_flags(flag);
            post(down);
            pressed.push((code, flag));
        }
    }

    std::thread::sleep(std::time::Duration::from_millis(duration_ms as u64));

    for (code, flags) in pressed.into_iter().rev() {
        let up = CGEvent::new_keyboard_event(source(), code, false).unwrap();
        up.set_flags(flags);
        post(up);
    }
}
