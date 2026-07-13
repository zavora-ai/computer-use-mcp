//! Native physical-user input activity clock.
//!
//! This clock deliberately excludes synthetic input. On macOS a passive HID
//! event tap accepts only events whose source state is the hardware HID table.
//! On Windows, dedicated low-level hooks discard events carrying the operating
//! system's injected flags. Both backends update a monotonic physical-event
//! clock read by the TypeScript lease monitor.

use napi_derive::napi;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::OnceLock;

const MOD_CTRL: u32 = 1 << 0;
const MOD_ALT: u32 = 1 << 1;
const MOD_SHIFT: u32 = 1 << 2;
const MOD_META: u32 = 1 << 3;
const TRIGGER_ESCAPE: u32 = 1 << 8;
const TRIGGER_F12: u32 = 1 << 9;
const MOD_MASK: u32 = MOD_CTRL | MOD_ALT | MOD_SHIFT | MOD_META;
const TRIGGER_MASK: u32 = TRIGGER_ESCAPE | TRIGGER_F12;

static EMERGENCY_CHORD: AtomicU32 = AtomicU32::new(0);
static EMERGENCY_GENERATION: AtomicU32 = AtomicU32::new(0);
static EMERGENCY_LATCHED: AtomicBool = AtomicBool::new(false);
static EMERGENCY_DETECTED_US: AtomicU64 = AtomicU64::new(0);
static EMERGENCY_CLOCK_ORIGIN: OnceLock<std::time::Instant> = OnceLock::new();

fn emergency_monotonic_us() -> u64 {
    EMERGENCY_CLOCK_ORIGIN
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_micros()
        .min(u128::from(u64::MAX)) as u64
}

fn parse_emergency_chord(chord: &str) -> Result<u32, String> {
    let mut encoded = 0u32;
    for part in chord
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
    {
        let bit = match part.to_ascii_lowercase().as_str() {
            "control" | "ctrl" => MOD_CTRL,
            "option" | "alt" => MOD_ALT,
            "shift" => MOD_SHIFT,
            "command" | "cmd" | "meta" | "super" | "win" => MOD_META,
            "escape" | "esc" => TRIGGER_ESCAPE,
            "f12" => TRIGGER_F12,
            _ => return Err(format!("unsupported emergency-stop chord key: {part}")),
        };
        if encoded & bit != 0 {
            return Err(format!("duplicate emergency-stop chord key: {part}"));
        }
        encoded |= bit;
    }
    if (encoded & MOD_MASK).count_ones() < 2 {
        return Err("emergency-stop chord requires at least two modifiers".into());
    }
    if (encoded & TRIGGER_MASK).count_ones() != 1 {
        return Err("emergency-stop chord requires exactly one trigger: escape or f12".into());
    }
    Ok(encoded)
}

fn chord_matches(modifiers: u32, trigger: u32) -> bool {
    let configured = EMERGENCY_CHORD.load(Ordering::Acquire);
    configured != 0
        && configured & MOD_MASK == modifiers & MOD_MASK
        && configured & TRIGGER_MASK == trigger
}

fn latch_emergency_stop() {
    if !EMERGENCY_LATCHED.swap(true, Ordering::AcqRel) {
        EMERGENCY_DETECTED_US.store(emergency_monotonic_us(), Ordering::Release);
        EMERGENCY_GENERATION.fetch_add(1, Ordering::AcqRel);
        // Release only buttons this process deliberately held. Do this off the
        // OS hook callback so emergency detection never blocks hook delivery.
        let _ = std::thread::Builder::new()
            .name("computer-use-emergency-release".into())
            .spawn(crate::mouse::release_agent_held_buttons);
    }
}

pub(crate) fn ensure_not_emergency_stopped() -> napi::Result<()> {
    if EMERGENCY_LATCHED.load(Ordering::Acquire) {
        Err(napi::Error::from_reason(
            "EmergencyStop: native input is latched off; host reset required",
        ))
    } else {
        Ok(())
    }
}

pub(crate) fn emergency_stop_active() -> bool {
    EMERGENCY_LATCHED.load(Ordering::Acquire)
}

pub(crate) fn interruptible_sleep(duration: std::time::Duration) -> napi::Result<()> {
    let deadline = std::time::Instant::now() + duration;
    loop {
        ensure_not_emergency_stopped()?;
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Ok(());
        }
        std::thread::sleep(remaining.min(std::time::Duration::from_millis(10)));
    }
}

#[napi(object)]
pub struct EmergencyStopCapability {
    pub supported: bool,
    pub backend: String,
    pub physical_only: bool,
    pub latched: bool,
    pub generation: u32,
    pub chord: Option<String>,
    pub reason: Option<String>,
}

#[napi(object)]
pub struct EmergencyStopWaitResult {
    pub triggered: bool,
    pub generation: u32,
    pub observer_latency_ms: Option<f64>,
}

#[napi]
pub fn configure_emergency_stop_chord(chord: String) -> napi::Result<EmergencyStopCapability> {
    #[cfg(target_os = "linux")]
    {
        parse_emergency_chord(&chord).map_err(napi::Error::from_reason)?;
        return Err(napi::Error::from_reason(
            "global physical emergency-stop chord is unsupported on this Linux backend",
        ));
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let encoded = parse_emergency_chord(&chord).map_err(napi::Error::from_reason)?;
    #[cfg(target_os = "macos")]
    macos_monitor::ensure_started()
        .as_ref()
        .map_err(|reason| napi::Error::from_reason(reason.clone()))?;
    #[cfg(target_os = "windows")]
    windows_monitor::ensure_started()
        .as_ref()
        .map_err(|reason| napi::Error::from_reason(reason.clone()))?;
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    EMERGENCY_CHORD.store(encoded, Ordering::Release);
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    Ok(get_emergency_stop_capability(Some(chord)))
}

#[napi]
pub fn trigger_native_emergency_stop() {
    latch_emergency_stop();
}

#[napi]
pub fn reset_native_emergency_stop() {
    EMERGENCY_LATCHED.store(false, Ordering::Release);
}

#[napi]
pub fn get_emergency_stop_generation() -> u32 {
    EMERGENCY_GENERATION.load(Ordering::Acquire)
}

#[napi]
pub fn is_native_emergency_stop_active() -> bool {
    EMERGENCY_LATCHED.load(Ordering::Acquire)
}

/// Blocking host probe intended for a worker thread. It performs no input and
/// uses the same native latch observed by actuator loops.
#[napi]
pub fn wait_for_native_emergency_stop(timeout_ms: u32) -> napi::Result<EmergencyStopWaitResult> {
    if !(100..=120_000).contains(&timeout_ms) {
        return Err(napi::Error::from_reason(
            "emergency-stop wait timeout must be between 100 and 120000 ms",
        ));
    }
    let initial_generation = EMERGENCY_GENERATION.load(Ordering::Acquire);
    let deadline =
        std::time::Instant::now() + std::time::Duration::from_millis(u64::from(timeout_ms));
    loop {
        let generation = EMERGENCY_GENERATION.load(Ordering::Acquire);
        if EMERGENCY_LATCHED.load(Ordering::Acquire) && generation > initial_generation {
            let observed_us = emergency_monotonic_us();
            let detected_us = EMERGENCY_DETECTED_US.load(Ordering::Acquire);
            return Ok(EmergencyStopWaitResult {
                triggered: true,
                generation,
                observer_latency_ms: Some(observed_us.saturating_sub(detected_us) as f64 / 1000.0),
            });
        }
        if std::time::Instant::now() >= deadline {
            return Ok(EmergencyStopWaitResult {
                triggered: false,
                generation,
                observer_latency_ms: None,
            });
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
}

fn get_emergency_stop_capability(chord: Option<String>) -> EmergencyStopCapability {
    EmergencyStopCapability {
        supported: cfg!(any(target_os = "macos", target_os = "windows")),
        backend: if cfg!(target_os = "macos") {
            "macos_hid_event_tap".into()
        } else if cfg!(target_os = "windows") {
            "windows_low_level_keyboard_hook".into()
        } else {
            "unsupported".into()
        },
        physical_only: cfg!(any(target_os = "macos", target_os = "windows")),
        latched: EMERGENCY_LATCHED.load(Ordering::Acquire),
        generation: EMERGENCY_GENERATION.load(Ordering::Acquire),
        chord,
        reason: if cfg!(target_os = "linux") {
            Some("global physical emergency-stop chord is unsupported on this Linux backend".into())
        } else {
            None
        },
    }
}

#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
fn macos_source_state_is_physical(source_state_id: i64) -> bool {
    source_state_id == 1
}

#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
fn windows_flags_are_physical(flags: u32, injected_mask: u32) -> bool {
    flags & injected_mask == 0
}

#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
fn linux_x11_device_is_physical(name: &str, device_use: i32) -> bool {
    // XI2 raw events identify the originating slave device. XTEST synthesis
    // uses the server-created XTEST devices, which are excluded here. Other
    // virtual/uinput devices are not universally identifiable, so the public
    // capability deliberately remains best-effort rather than claiming full
    // injected-versus-physical attribution.
    let slave = device_use == 3 || device_use == 4; // XISlavePointer/Keyboard
    let normalized = name.to_ascii_lowercase();
    slave && !normalized.contains("xtest") && !normalized.contains("virtual core")
}

#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
fn linux_session_is_native_wayland(
    session_type: Option<&str>,
    wayland_display: Option<&str>,
) -> bool {
    session_type
        .map(|value| value.eq_ignore_ascii_case("wayland"))
        .unwrap_or(false)
        || (wayland_display.is_some()
            && !session_type
                .map(|value| value.eq_ignore_ascii_case("x11"))
                .unwrap_or(false))
}

#[napi(object)]
pub struct InputMonitorCapability {
    pub supported: bool,
    pub backend: String,
    pub distinguishes_injected: bool,
    pub recommended_poll_ms: u32,
    pub reason: Option<String>,
}

#[cfg(target_os = "macos")]
mod macos_monitor {
    use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
    use core_graphics::event::{
        CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType,
        EventField,
    };
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{mpsc, OnceLock};
    use std::time::{Duration, Instant};

    static CLOCK_ORIGIN: OnceLock<Instant> = OnceLock::new();
    static LAST_PHYSICAL_MS: AtomicU64 = AtomicU64::new(0);
    static TAP_STATUS: OnceLock<Result<(), String>> = OnceLock::new();

    fn monotonic_ms() -> u64 {
        CLOCK_ORIGIN
            .get_or_init(Instant::now)
            .elapsed()
            .as_millis()
            .min(u128::from(u64::MAX)) as u64
    }

    fn install_tap() -> Result<(), String> {
        let (sender, receiver) = mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("computer-use-input-monitor".into())
            .spawn(move || {
                let event_types = vec![
                    CGEventType::LeftMouseDown,
                    CGEventType::LeftMouseUp,
                    CGEventType::RightMouseDown,
                    CGEventType::RightMouseUp,
                    CGEventType::MouseMoved,
                    CGEventType::LeftMouseDragged,
                    CGEventType::RightMouseDragged,
                    CGEventType::KeyDown,
                    CGEventType::KeyUp,
                    CGEventType::FlagsChanged,
                    CGEventType::ScrollWheel,
                    CGEventType::TabletPointer,
                    CGEventType::TabletProximity,
                    CGEventType::OtherMouseDown,
                    CGEventType::OtherMouseUp,
                    CGEventType::OtherMouseDragged,
                ];
                let tap = match CGEventTap::new(
                    CGEventTapLocation::HID,
                    CGEventTapPlacement::HeadInsertEventTap,
                    CGEventTapOptions::ListenOnly,
                    event_types,
                    |_proxy, event_type, event| {
                        // kCGEventSourceStateHIDSystemState=1. Events posted by
                        // this runtime use a private source (-1); other process
                        // injection normally uses combined/private state (0/-1).
                        if super::macos_source_state_is_physical(
                            event.get_integer_value_field(EventField::EVENT_SOURCE_STATE_ID),
                        ) {
                            LAST_PHYSICAL_MS.store(monotonic_ms(), Ordering::Release);
                            if event_type as u32 == CGEventType::KeyDown as u32 {
                                let flags = event.get_flags();
                                let mut modifiers = 0u32;
                                if flags.contains(core_graphics::event::CGEventFlags::CGEventFlagControl) { modifiers |= super::MOD_CTRL; }
                                if flags.contains(core_graphics::event::CGEventFlags::CGEventFlagAlternate) { modifiers |= super::MOD_ALT; }
                                if flags.contains(core_graphics::event::CGEventFlags::CGEventFlagShift) { modifiers |= super::MOD_SHIFT; }
                                if flags.contains(core_graphics::event::CGEventFlags::CGEventFlagCommand) { modifiers |= super::MOD_META; }
                                let keycode = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
                                let trigger = match keycode { 53 => super::TRIGGER_ESCAPE, 111 => super::TRIGGER_F12, _ => 0 };
                                if super::chord_matches(modifiers, trigger) {
                                    super::latch_emergency_stop();
                                }
                            }
                        }
                        None
                    },
                ) {
                    Ok(tap) => tap,
                    Err(()) => {
                        let _ = sender.send(Err(
                            "failed to install passive HID event tap; Input Monitoring permission may be missing"
                                .into(),
                        ));
                        return;
                    }
                };
                let run_loop = CFRunLoop::get_current();
                let source = match tap.mach_port.create_runloop_source(0) {
                    Ok(source) => source,
                    Err(()) => {
                        let _ = sender.send(Err("failed to create event-tap run-loop source".into()));
                        return;
                    }
                };
                LAST_PHYSICAL_MS.store(monotonic_ms(), Ordering::Release);
                unsafe { run_loop.add_source(&source, kCFRunLoopCommonModes) };
                tap.enable();
                if sender.send(Ok(())).is_err() {
                    return;
                }
                CFRunLoop::run_current();
            })
            .map_err(|error| format!("failed to start input event-tap thread: {error}"))?;

        receiver
            .recv_timeout(Duration::from_secs(2))
            .map_err(|error| format!("input event-tap initialization timed out: {error}"))?
    }

    pub fn ensure_started() -> &'static Result<(), String> {
        TAP_STATUS.get_or_init(install_tap)
    }

    pub fn idle_time_ms() -> Option<f64> {
        ensure_started().as_ref().ok()?;
        Some(monotonic_ms().saturating_sub(LAST_PHYSICAL_MS.load(Ordering::Acquire)) as f64)
    }
}

#[cfg(target_os = "macos")]
#[napi]
pub fn get_user_idle_time_ms() -> Option<f64> {
    macos_monitor::idle_time_ms()
}

#[cfg(target_os = "windows")]
mod windows_monitor {
    use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
    use std::sync::{mpsc, OnceLock};
    use std::time::Duration;
    use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::SystemInformation::GetTickCount64;
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, SetWindowsHookExW, UnhookWindowsHookEx, HC_ACTION,
        KBDLLHOOKSTRUCT, LLKHF_INJECTED, LLMHF_INJECTED, MSG, MSLLHOOKSTRUCT, WH_KEYBOARD_LL,
        WH_MOUSE_LL, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    static LAST_PHYSICAL_TICK_MS: AtomicU64 = AtomicU64::new(0);
    static HOOK_STATUS: OnceLock<Result<(), String>> = OnceLock::new();
    static PHYSICAL_MODIFIERS: AtomicU32 = AtomicU32::new(0);

    unsafe extern "system" fn mouse_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            let event = &*(lparam.0 as *const MSLLHOOKSTRUCT);
            if super::windows_flags_are_physical(event.flags, LLMHF_INJECTED) {
                LAST_PHYSICAL_TICK_MS.store(GetTickCount64(), Ordering::Release);
            }
        }
        CallNextHookEx(None, code, wparam, lparam)
    }

    unsafe extern "system" fn keyboard_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            let event = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
            if super::windows_flags_are_physical(event.flags.0, LLKHF_INJECTED.0) {
                LAST_PHYSICAL_TICK_MS.store(GetTickCount64(), Ordering::Release);
                let down = wparam.0 == WM_KEYDOWN as usize || wparam.0 == WM_SYSKEYDOWN as usize;
                let up = wparam.0 == WM_KEYUP as usize || wparam.0 == WM_SYSKEYUP as usize;
                let modifier = match event.vkCode {
                    0x10 | 0xA0 | 0xA1 => super::MOD_SHIFT,
                    0x11 | 0xA2 | 0xA3 => super::MOD_CTRL,
                    0x12 | 0xA4 | 0xA5 => super::MOD_ALT,
                    0x5B | 0x5C => super::MOD_META,
                    _ => 0,
                };
                if modifier != 0 {
                    if down {
                        PHYSICAL_MODIFIERS.fetch_or(modifier, Ordering::AcqRel);
                    }
                    if up {
                        PHYSICAL_MODIFIERS.fetch_and(!modifier, Ordering::AcqRel);
                    }
                } else if down {
                    let trigger = match event.vkCode {
                        0x1B => super::TRIGGER_ESCAPE,
                        0x7B => super::TRIGGER_F12,
                        _ => 0,
                    };
                    if super::chord_matches(PHYSICAL_MODIFIERS.load(Ordering::Acquire), trigger) {
                        super::latch_emergency_stop();
                    }
                }
            }
        }
        CallNextHookEx(None, code, wparam, lparam)
    }

    fn install_hooks() -> Result<(), String> {
        let (sender, receiver) = mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("computer-use-input-monitor".into())
            .spawn(move || unsafe {
                let mouse =
                    SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), HINSTANCE::default(), 0);
                let keyboard =
                    SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), HINSTANCE::default(), 0);
                let (mouse, keyboard) = match (mouse, keyboard) {
                    (Ok(mouse), Ok(keyboard)) => (mouse, keyboard),
                    (mouse, keyboard) => {
                        if let Ok(hook) = mouse {
                            let _ = UnhookWindowsHookEx(hook);
                        }
                        if let Ok(hook) = keyboard {
                            let _ = UnhookWindowsHookEx(hook);
                        }
                        let _ = sender.send(Err(format!(
                            "failed to install low-level input hooks (mouse={}, keyboard={})",
                            mouse.is_ok(),
                            keyboard.is_ok(),
                        )));
                        return;
                    }
                };

                LAST_PHYSICAL_TICK_MS.store(GetTickCount64(), Ordering::Release);
                if sender.send(Ok(())).is_err() {
                    let _ = UnhookWindowsHookEx(mouse);
                    let _ = UnhookWindowsHookEx(keyboard);
                    return;
                }

                // Low-level hook callbacks are dispatched to the installing
                // thread, so it must retain a message loop for process life.
                let mut message = MSG::default();
                while GetMessageW(&mut message, None, 0, 0).as_bool() {}
                let _ = UnhookWindowsHookEx(mouse);
                let _ = UnhookWindowsHookEx(keyboard);
            })
            .map_err(|error| format!("failed to start input hook thread: {error}"))?;

        receiver
            .recv_timeout(Duration::from_secs(2))
            .map_err(|error| format!("input hook initialization timed out: {error}"))?
    }

    pub fn ensure_started() -> &'static Result<(), String> {
        HOOK_STATUS.get_or_init(install_hooks)
    }

    pub fn idle_time_ms() -> Option<f64> {
        ensure_started().as_ref().ok()?;
        let last = LAST_PHYSICAL_TICK_MS.load(Ordering::Acquire);
        let now = unsafe { GetTickCount64() };
        Some(now.saturating_sub(last) as f64)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        chord_matches, linux_session_is_native_wayland, linux_x11_device_is_physical,
        macos_source_state_is_physical, parse_emergency_chord, windows_flags_are_physical,
        EMERGENCY_CHORD, MOD_ALT, MOD_CTRL, MOD_SHIFT, TRIGGER_ESCAPE,
    };
    use std::sync::atomic::Ordering;

    #[test]
    fn emergency_chord_is_strict_and_requires_two_modifiers() {
        assert!(parse_emergency_chord("ctrl+escape").is_err());
        assert!(parse_emergency_chord("ctrl+alt+x").is_err());
        assert!(parse_emergency_chord("ctrl+alt+escape+f12").is_err());
        let encoded = parse_emergency_chord("ctrl+alt+shift+escape").unwrap();
        EMERGENCY_CHORD.store(encoded, Ordering::Release);
        assert!(chord_matches(
            MOD_CTRL | MOD_ALT | MOD_SHIFT,
            TRIGGER_ESCAPE
        ));
        assert!(!chord_matches(MOD_CTRL | MOD_ALT, TRIGGER_ESCAPE));
    }

    #[test]
    fn macos_accepts_only_hid_hardware_source_state() {
        assert!(macos_source_state_is_physical(1));
        assert!(!macos_source_state_is_physical(0));
        assert!(!macos_source_state_is_physical(-1));
    }

    #[test]
    fn windows_rejects_any_event_with_the_injected_flag() {
        assert!(windows_flags_are_physical(0, 0x01));
        assert!(!windows_flags_are_physical(0x01, 0x01));
        assert!(!windows_flags_are_physical(0x03, 0x01));
        assert!(windows_flags_are_physical(0x02, 0x10));
        assert!(!windows_flags_are_physical(0x12, 0x10));
    }

    #[test]
    fn linux_x11_excludes_server_xtest_and_master_devices() {
        assert!(linux_x11_device_is_physical("USB Optical Mouse", 3));
        assert!(linux_x11_device_is_physical(
            "AT Translated Set 2 keyboard",
            4
        ));
        assert!(!linux_x11_device_is_physical(
            "Virtual core XTEST pointer",
            3
        ));
        assert!(!linux_x11_device_is_physical("Virtual core pointer", 1));
        assert!(!linux_x11_device_is_physical("Some floating device", 5));
    }

    #[test]
    fn linux_x11_monitor_never_claims_native_wayland_or_xwayland() {
        assert!(linux_session_is_native_wayland(
            Some("wayland"),
            Some("wayland-0")
        ));
        assert!(linux_session_is_native_wayland(None, Some("wayland-0")));
        assert!(!linux_session_is_native_wayland(Some("x11"), None));
        assert!(!linux_session_is_native_wayland(
            Some("x11"),
            Some("wayland-0")
        ));
    }
}

#[cfg(target_os = "windows")]
#[napi]
pub fn get_user_idle_time_ms() -> Option<f64> {
    windows_monitor::idle_time_ms()
}

#[cfg(target_os = "linux")]
mod linux_x11_monitor {
    use std::collections::HashSet;
    use std::ffi::CStr;
    use std::os::raw::{c_int, c_uchar};
    use std::ptr;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{mpsc, OnceLock};
    use std::time::{Duration, Instant};
    use x11::{xinput2, xlib};

    static CLOCK_ORIGIN: OnceLock<Instant> = OnceLock::new();
    static LAST_PHYSICAL_MS: AtomicU64 = AtomicU64::new(0);
    static MONITOR_STATUS: OnceLock<Result<(), String>> = OnceLock::new();

    fn monotonic_ms() -> u64 {
        CLOCK_ORIGIN
            .get_or_init(Instant::now)
            .elapsed()
            .as_millis()
            .min(u128::from(u64::MAX)) as u64
    }

    unsafe fn physical_devices(display: *mut xlib::Display) -> Result<HashSet<c_int>, String> {
        let mut count = 0;
        let devices = xinput2::XIQueryDevice(display, xinput2::XIAllDevices, &mut count);
        if devices.is_null() {
            return Err("XIQueryDevice returned no device table".into());
        }
        let mut physical = HashSet::new();
        for index in 0..count.max(0) as usize {
            let device = &*devices.add(index);
            if device.name.is_null() || device.enabled == 0 {
                continue;
            }
            let name = CStr::from_ptr(device.name).to_string_lossy();
            if super::linux_x11_device_is_physical(&name, device._use) {
                physical.insert(device.deviceid);
            }
        }
        xinput2::XIFreeDeviceInfo(devices);
        if physical.is_empty() {
            return Err("XI2 reported no enabled non-XTEST slave input devices".into());
        }
        Ok(physical)
    }

    unsafe fn run_monitor(sender: mpsc::SyncSender<Result<(), String>>) {
        let session_type = std::env::var("XDG_SESSION_TYPE").ok();
        let wayland_display = std::env::var("WAYLAND_DISPLAY").ok();
        if super::linux_session_is_native_wayland(
            session_type.as_deref(),
            wayland_display.as_deref(),
        ) {
            let _ = sender.send(Err(
                "native Wayland does not expose an equivalent attributed global input stream; X11 only"
                    .into(),
            ));
            return;
        }
        let display = xlib::XOpenDisplay(ptr::null());
        if display.is_null() {
            let _ = sender.send(Err("cannot open DISPLAY for XI2 input monitoring".into()));
            return;
        }

        let mut opcode = 0;
        let mut first_event = 0;
        let mut first_error = 0;
        let extension = b"XInputExtension\0";
        if xlib::XQueryExtension(
            display,
            extension.as_ptr().cast(),
            &mut opcode,
            &mut first_event,
            &mut first_error,
        ) == xlib::False
        {
            let _ = xlib::XCloseDisplay(display);
            let _ = sender.send(Err(
                "XInput extension is unavailable on this X server".into()
            ));
            return;
        }
        let mut major = 2;
        let mut minor = 0;
        if xinput2::XIQueryVersion(display, &mut major, &mut minor) != xlib::Success as c_int {
            let _ = xlib::XCloseDisplay(display);
            let _ = sender.send(Err("XInput2 2.0 or newer is unavailable".into()));
            return;
        }

        let mut devices = match physical_devices(display) {
            Ok(devices) => devices,
            Err(reason) => {
                let _ = xlib::XCloseDisplay(display);
                let _ = sender.send(Err(reason));
                return;
            }
        };
        let mask_len = ((xinput2::XI_LASTEVENT + 7) / 8) as usize;
        let mut raw_mask = vec![0u8; mask_len];
        for event in [
            xinput2::XI_RawKeyPress,
            xinput2::XI_RawKeyRelease,
            xinput2::XI_RawButtonPress,
            xinput2::XI_RawButtonRelease,
            xinput2::XI_RawMotion,
            xinput2::XI_RawTouchBegin,
            xinput2::XI_RawTouchUpdate,
            xinput2::XI_RawTouchEnd,
        ] {
            xinput2::XISetMask(&mut raw_mask, event);
        }
        let mut hierarchy_mask = vec![0u8; mask_len];
        xinput2::XISetMask(&mut hierarchy_mask, xinput2::XI_HierarchyChanged);
        let mut masks = [
            xinput2::XIEventMask {
                deviceid: xinput2::XIAllMasterDevices,
                mask_len: raw_mask.len() as c_int,
                mask: raw_mask.as_mut_ptr() as *mut c_uchar,
            },
            xinput2::XIEventMask {
                deviceid: xinput2::XIAllDevices,
                mask_len: hierarchy_mask.len() as c_int,
                mask: hierarchy_mask.as_mut_ptr() as *mut c_uchar,
            },
        ];
        let root = xlib::XDefaultRootWindow(display);
        if xinput2::XISelectEvents(display, root, masks.as_mut_ptr(), masks.len() as c_int)
            != xlib::Success as c_int
        {
            let _ = xlib::XCloseDisplay(display);
            let _ = sender.send(Err("failed to select XI2 raw input events".into()));
            return;
        }
        xlib::XFlush(display);
        LAST_PHYSICAL_MS.store(monotonic_ms(), Ordering::Release);
        if sender.send(Ok(())).is_err() {
            let _ = xlib::XCloseDisplay(display);
            return;
        }

        loop {
            let mut event: xlib::XEvent = std::mem::zeroed();
            xlib::XNextEvent(display, &mut event);
            if event.get_type() != xlib::GenericEvent {
                continue;
            }
            let mut cookie = event.generic_event_cookie;
            if cookie.extension != opcode || xlib::XGetEventData(display, &mut cookie) != xlib::True
            {
                continue;
            }
            if cookie.evtype == xinput2::XI_HierarchyChanged {
                if let Ok(updated) = physical_devices(display) {
                    devices = updated;
                }
            } else if matches!(
                cookie.evtype,
                xinput2::XI_RawKeyPress
                    | xinput2::XI_RawKeyRelease
                    | xinput2::XI_RawButtonPress
                    | xinput2::XI_RawButtonRelease
                    | xinput2::XI_RawMotion
                    | xinput2::XI_RawTouchBegin
                    | xinput2::XI_RawTouchUpdate
                    | xinput2::XI_RawTouchEnd
            ) && !cookie.data.is_null()
            {
                let raw = &*(cookie.data as *const xinput2::XIRawEvent);
                if devices.contains(&raw.sourceid) {
                    LAST_PHYSICAL_MS.store(monotonic_ms(), Ordering::Release);
                }
            }
            xlib::XFreeEventData(display, &mut cookie);
        }
    }

    fn install() -> Result<(), String> {
        let (sender, receiver) = mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("computer-use-x11-input-monitor".into())
            .spawn(move || unsafe { run_monitor(sender) })
            .map_err(|error| format!("failed to start XI2 monitor thread: {error}"))?;
        receiver
            .recv_timeout(Duration::from_secs(2))
            .map_err(|error| format!("XI2 monitor initialization timed out: {error}"))?
    }

    pub fn ensure_started() -> &'static Result<(), String> {
        MONITOR_STATUS.get_or_init(install)
    }

    pub fn idle_time_ms() -> Option<f64> {
        ensure_started().as_ref().ok()?;
        Some(monotonic_ms().saturating_sub(LAST_PHYSICAL_MS.load(Ordering::Acquire)) as f64)
    }
}

#[cfg(target_os = "linux")]
#[napi]
pub fn get_user_idle_time_ms() -> Option<f64> {
    linux_x11_monitor::idle_time_ms()
}

#[napi]
pub fn get_input_monitor_capability() -> InputMonitorCapability {
    #[cfg(target_os = "macos")]
    {
        let status = macos_monitor::ensure_started();
        return InputMonitorCapability {
            supported: status.is_ok(),
            backend: "cg_hid_attributed_event_tap".into(),
            distinguishes_injected: status.is_ok(),
            recommended_poll_ms: 10,
            reason: status.as_ref().err().cloned(),
        };
    }

    #[cfg(target_os = "windows")]
    {
        let status = windows_monitor::ensure_started();
        return InputMonitorCapability {
            supported: status.is_ok(),
            backend: "win32_low_level_physical_input_hooks".into(),
            distinguishes_injected: status.is_ok(),
            recommended_poll_ms: 10,
            reason: status.as_ref().err().cloned(),
        };
    }

    #[cfg(target_os = "linux")]
    {
        let status = linux_x11_monitor::ensure_started();
        return InputMonitorCapability {
        supported: status.is_ok(),
        backend: if status.is_ok() { "xinput2_raw_non_xtest" } else { "unavailable" }.into(),
        distinguishes_injected: false,
        recommended_poll_ms: 20,
        reason: status.as_ref().err().cloned().or_else(|| Some(
            "best-effort X11 monitor excludes XTEST sources, but arbitrary virtual/uinput devices cannot be proven physical; Wayland is unsupported".into(),
        )),
        };
    }
}
