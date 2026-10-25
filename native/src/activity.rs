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

// ── Physical input counters (7.7.0, K5: takeover) ───────────────────────────
//
// How much the person moved the pointer (sum of |dx| + |dy| in points or pixels), and how many keys and buttons they
// pressed, physical input only. The server compares readings taken during an action to tell a deliberate takeover (a
// real drag of the mouse, a key, a click) from a nudge; zero-length moves (some wireless receivers stream them,
// Windows-MCP #498) count for nothing (W8).
static PHYSICAL_MOVEMENT: AtomicU64 = AtomicU64::new(0);
static PHYSICAL_KEYS: AtomicU64 = AtomicU64::new(0);
static PHYSICAL_BUTTONS: AtomicU64 = AtomicU64::new(0);

#[cfg_attr(not(any(target_os = "macos", target_os = "windows", target_os = "linux")), allow(dead_code))]
fn count_movement(dx: i64, dy: i64) {
    let amount = dx.unsigned_abs().saturating_add(dy.unsigned_abs());
    if amount > 0 {
        PHYSICAL_MOVEMENT.fetch_add(amount, Ordering::AcqRel);
    }
}

#[napi(object)]
pub struct PhysicalInputCounters {
    /// False when no physical-input monitor runs (no permission, Wayland, or nothing started yet).
    pub supported: bool,
    pub movement: f64,
    pub keys: f64,
    pub buttons: f64,
}

/// Monotonic counters of physical input since this process started its monitor.
#[napi]
pub fn get_physical_input_counters() -> PhysicalInputCounters {
    #[cfg(target_os = "macos")]
    let supported = macos_monitor::ensure_started().is_ok();
    #[cfg(target_os = "windows")]
    let supported = windows_monitor::ensure_started().is_ok();
    #[cfg(target_os = "linux")]
    let supported = linux_monitor().is_ok();
    PhysicalInputCounters {
        supported,
        movement: PHYSICAL_MOVEMENT.load(Ordering::Acquire) as f64,
        keys: PHYSICAL_KEYS.load(Ordering::Acquire) as f64,
        buttons: PHYSICAL_BUTTONS.load(Ordering::Acquire) as f64,
    }
}

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
        // Release only the buttons and keys this process deliberately held (7.7.0: every button and every key held
        // with key_down, not just the left button). Do this off the OS hook callback so emergency detection never
        // blocks hook delivery; releases are never refused by the latch.
        let _ = std::thread::Builder::new()
            .name("computer-use-emergency-release".into())
            .spawn(|| {
                crate::mouse::release_agent_held_buttons();
                crate::keyboard::release_agent_held_keys();
            });
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

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
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
    use std::sync::atomic::{AtomicPtr, AtomicU64, Ordering};
    use std::sync::{mpsc, OnceLock};
    use std::time::{Duration, Instant};
    use super::seed_last_physical_ms;

    static CLOCK_ORIGIN: OnceLock<Instant> = OnceLock::new();
    static LAST_PHYSICAL_MS: AtomicU64 = AtomicU64::new(0);
    static TAP_STATUS: OnceLock<Result<(), String>> = OnceLock::new();
    /// The tap's mach port, so the callback can turn the tap back on (M2).
    static TAP_PORT: AtomicPtr<std::ffi::c_void> = AtomicPtr::new(std::ptr::null_mut());

    extern "C" {
        fn CGEventTapEnable(tap: *mut std::ffi::c_void, enable: bool);
    }

    /// kCGEventTapDisabledByTimeout and kCGEventTapDisabledByUserInput: the system turned the tap off. 7.7.0 (M2):
    /// turn it back on; before, the guard read the person as idle forever after the first timeout.
    const TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
    const TAP_DISABLED_BY_USER_INPUT: u32 = 0xFFFF_FFFF;

    /// The clock starts one day in, not at zero, so a "last physical input" before this process started (seeded
    /// from the system's idle counter at tap install) is representable: 0 reads as a day of idle, never as "now".
    pub(crate) const CLOCK_BASE_MS: u64 = 86_400_000;

    fn monotonic_ms() -> u64 {
        CLOCK_BASE_MS.saturating_add(
            CLOCK_ORIGIN
                .get_or_init(Instant::now)
                .elapsed()
                .as_millis()
                .min(u128::from(u64::MAX)) as u64,
        )
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
                        let kind = event_type as u32;
                        if kind == TAP_DISABLED_BY_TIMEOUT || kind == TAP_DISABLED_BY_USER_INPUT {
                            let port = TAP_PORT.load(Ordering::Acquire);
                            if !port.is_null() {
                                unsafe { CGEventTapEnable(port, true) };
                            }
                            return None;
                        }
                        // kCGEventSourceStateHIDSystemState=1. Events posted by
                        // this runtime use a private source (-1); other process
                        // injection normally uses combined/private state (0/-1).
                        if super::macos_source_state_is_physical(
                            event.get_integer_value_field(EventField::EVENT_SOURCE_STATE_ID),
                        ) {
                            let moving = kind == CGEventType::MouseMoved as u32
                                || kind == CGEventType::LeftMouseDragged as u32
                                || kind == CGEventType::RightMouseDragged as u32
                                || kind == CGEventType::OtherMouseDragged as u32;
                            if moving {
                                let dx = event.get_integer_value_field(EventField::MOUSE_EVENT_DELTA_X);
                                let dy = event.get_integer_value_field(EventField::MOUSE_EVENT_DELTA_Y);
                                // A zero-length move is not the person (W8).
                                if dx == 0 && dy == 0 {
                                    return None;
                                }
                                super::count_movement(dx, dy);
                            } else if kind == CGEventType::KeyDown as u32 {
                                super::PHYSICAL_KEYS.fetch_add(1, Ordering::AcqRel);
                            } else if kind == CGEventType::LeftMouseDown as u32
                                || kind == CGEventType::RightMouseDown as u32
                                || kind == CGEventType::OtherMouseDown as u32
                                || kind == CGEventType::ScrollWheel as u32
                            {
                                super::PHYSICAL_BUTTONS.fetch_add(1, Ordering::AcqRel);
                            }
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
                // Seed the clock from the system's own HID idle counter, not from "now". Stamping "now" made the
                // first guarded call of every server process read as user activity (user_active, msSinceInput
                // under the threshold) with nobody at the keyboard; CI's macOS smoke test failed exactly there.
                // CGEventSourceSecondsSinceLastEventType with the HID system state counts physical devices only;
                // this process has posted nothing yet when the tap installs, so the reading is the user's.
                LAST_PHYSICAL_MS.store(seed_last_physical_ms(monotonic_ms(), hid_idle_seconds()), Ordering::Release);
                unsafe { run_loop.add_source(&source, kCFRunLoopCommonModes) };
                {
                    use core_foundation::base::TCFType;
                    TAP_PORT.store(tap.mach_port.as_concrete_TypeRef() as *mut std::ffi::c_void, Ordering::Release);
                }
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

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        // CGEventSourceSecondsSinceLastEventType(CGEventSourceStateID stateID, CGEventType eventType) -> CFTimeInterval
        fn CGEventSourceSecondsSinceLastEventType(state_id: u32, event_type: u32) -> f64;
    }
    const K_CG_EVENT_SOURCE_STATE_HID_SYSTEM_STATE: u32 = 1;
    const K_CG_ANY_INPUT_EVENT_TYPE: u32 = u32::MAX;

    /// Seconds since the last physical (HID system state) input event, or None when the system can't say.
    fn hid_idle_seconds() -> Option<f64> {
        let seconds = unsafe {
            CGEventSourceSecondsSinceLastEventType(K_CG_EVENT_SOURCE_STATE_HID_SYSTEM_STATE, K_CG_ANY_INPUT_EVENT_TYPE)
        };
        if seconds.is_finite() && seconds >= 0.0 { Some(seconds) } else { None }
    }
}

#[cfg(target_os = "macos")]
#[napi]
pub fn get_user_idle_time_ms() -> Option<f64> {
    macos_monitor::idle_time_ms()
}

/// The clock value to store at tap install: `now` minus the system's idle time, so the first reading reflects the
/// user's real last input. Without an idle reading the clock is seeded far in the past (idle), never "now".
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
pub(crate) fn seed_last_physical_ms(now_ms: u64, hid_idle_seconds: Option<f64>) -> u64 {
    match hid_idle_seconds {
        Some(seconds) if seconds.is_finite() && seconds >= 0.0 => {
            let idle_ms = (seconds * 1000.0).min(u64::MAX as f64) as u64;
            now_ms.saturating_sub(idle_ms)
        }
        _ => 0,
    }
}

#[cfg(test)]
mod seed_tests {
    use super::seed_last_physical_ms;

    #[test]
    fn seed_uses_the_system_idle_time() {
        // 10 s idle at now = 60 s: the last input was at 50 s
        assert_eq!(seed_last_physical_ms(60_000, Some(10.0)), 50_000);
    }

    #[test]
    fn seed_never_reads_as_now_when_idle_is_unknown() {
        assert_eq!(seed_last_physical_ms(60_000, None), 0);
        assert_eq!(seed_last_physical_ms(60_000, Some(f64::NAN)), 0);
        assert_eq!(seed_last_physical_ms(60_000, Some(-1.0)), 0);
    }

    #[test]
    fn seed_saturates_when_idle_exceeds_uptime() {
        assert_eq!(seed_last_physical_ms(5_000, Some(10.0)), 0);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_clock_can_represent_input_before_process_start() {
        // At install the elapsed time is ~0; a 20 s idle reading must still come out as 20 s, not 0.
        let now = super::macos_monitor::CLOCK_BASE_MS + 5;
        let seed = seed_last_physical_ms(now, Some(20.0));
        assert_eq!(now - seed, 20_000);
        // And the unknown case reads as a day idle, never as now.
        assert!(now - seed_last_physical_ms(now, None) >= 86_400_000);
    }
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
    /// The last physical pointer position, packed (x in the high half), to measure movement and drop zero-length moves.
    static LAST_POINT: AtomicU64 = AtomicU64::new(u64::MAX);

    const WM_MOUSEMOVE: usize = 0x0200;
    const BUTTON_DOWNS: [usize; 5] = [0x0201, 0x0204, 0x0207, 0x020B, 0x020A]; // L, R, M, X down; wheel

    unsafe extern "system" fn mouse_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            let event = &*(lparam.0 as *const MSLLHOOKSTRUCT);
            if super::windows_flags_are_physical(event.flags, LLMHF_INJECTED) {
                let mut counts = true;
                if wparam.0 == WM_MOUSEMOVE {
                    let packed = ((event.pt.x as u32 as u64) << 32) | event.pt.y as u32 as u64;
                    let previous = LAST_POINT.swap(packed, Ordering::AcqRel);
                    if previous == packed {
                        // A zero-length move (W8): wireless receivers stream these; it is not the person.
                        counts = false;
                    } else if previous != u64::MAX {
                        let (px, py) = ((previous >> 32) as u32 as i32, previous as u32 as i32);
                        super::count_movement((event.pt.x - px) as i64, (event.pt.y - py) as i64);
                    }
                } else if BUTTON_DOWNS.contains(&wparam.0) {
                    super::PHYSICAL_BUTTONS.fetch_add(1, Ordering::AcqRel);
                }
                if counts {
                    LAST_PHYSICAL_TICK_MS.store(GetTickCount64(), Ordering::Release);
                }
            }
        }
        CallNextHookEx(None, code, wparam, lparam)
    }

    /// 7.7.0 (K5): the modifiers the chord sees are the tracked physical ones that are also down right now. A missed
    /// key-up (the secure desktop, a hook timeout) left a modifier counted as held, so the chord could fire on fewer
    /// keys than configured (the Windows-MCP #460 class).
    fn reconciled_modifiers() -> u32 {
        use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT};
        let tracked = PHYSICAL_MODIFIERS.load(Ordering::Acquire);
        let down = |vk: u16| unsafe { GetAsyncKeyState(vk as i32) } < 0;
        let mut live = 0u32;
        if down(VK_SHIFT.0) { live |= super::MOD_SHIFT; }
        if down(VK_CONTROL.0) { live |= super::MOD_CTRL; }
        if down(VK_MENU.0) { live |= super::MOD_ALT; }
        if down(VK_LWIN.0) || down(VK_RWIN.0) { live |= super::MOD_META; }
        let reconciled = tracked & live;
        PHYSICAL_MODIFIERS.store(reconciled, Ordering::Release);
        reconciled
    }

    unsafe extern "system" fn keyboard_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            let event = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
            if super::windows_flags_are_physical(event.flags.0, LLKHF_INJECTED.0) {
                LAST_PHYSICAL_TICK_MS.store(GetTickCount64(), Ordering::Release);
                let down = wparam.0 == WM_KEYDOWN as usize || wparam.0 == WM_SYSKEYDOWN as usize;
                let up = wparam.0 == WM_KEYUP as usize || wparam.0 == WM_SYSKEYUP as usize;
                if down {
                    super::PHYSICAL_KEYS.fetch_add(1, Ordering::AcqRel);
                }
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
                    if trigger != 0 && super::chord_matches(reconciled_modifiers(), trigger) {
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
        chord_matches, idle_activity_is_physical, linux_session_is_native_wayland, linux_x11_device_is_physical,
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
    fn mutter_idle_activity_is_the_person_only_away_from_the_agents_input() {
        // New activity, long after the agent's last input: the person.
        assert!(idle_activity_is_physical(5_000, 4_000, false, 1_000, 150));
        // Already counted.
        assert!(!idle_activity_is_physical(4_000, 4_000, false, 1_000, 150));
        // While the agent's input is in flight, or within the margin after it: the agent.
        assert!(!idle_activity_is_physical(5_000, 4_000, true, 1_000, 150));
        assert!(!idle_activity_is_physical(5_100, 4_000, false, 5_000, 150));
        assert!(idle_activity_is_physical(5_200, 4_000, false, 5_000, 150));
        // Activity before the agent's input began is masked by it, never counted late.
        assert!(!idle_activity_is_physical(4_900, 4_000, false, 5_000, 150));
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
                    let mut counts = true;
                    match cookie.evtype {
                        xinput2::XI_RawMotion => {
                            // Sum the raw deltas of valuators 0 (x) and 1 (y); a zero-length move is not the person (W8).
                            let (dx, dy) = raw_motion_xy(raw);
                            if dx == 0.0 && dy == 0.0 {
                                counts = false;
                            } else {
                                super::count_movement(dx.round() as i64, dy.round() as i64);
                            }
                        }
                        xinput2::XI_RawKeyPress => {
                            super::PHYSICAL_KEYS.fetch_add(1, Ordering::AcqRel);
                        }
                        xinput2::XI_RawButtonPress => {
                            super::PHYSICAL_BUTTONS.fetch_add(1, Ordering::AcqRel);
                        }
                        _ => {}
                    }
                    if counts {
                        LAST_PHYSICAL_MS.store(monotonic_ms(), Ordering::Release);
                    }
                }
            }
            xlib::XFreeEventData(display, &mut cookie);
        }
    }

    /// The raw x and y deltas of an XI2 raw motion event (valuators 0 and 1, when present in its mask).
    unsafe fn raw_motion_xy(raw: &xinput2::XIRawEvent) -> (f64, f64) {
        let mask = std::slice::from_raw_parts(raw.valuators.mask, raw.valuators.mask_len.max(0) as usize);
        let mut value_index = 0usize;
        let (mut dx, mut dy) = (0.0, 0.0);
        for valuator in 0..(mask.len() * 8) {
            if mask[valuator / 8] & (1 << (valuator % 8)) == 0 {
                continue;
            }
            let value = *raw.raw_values.add(value_index);
            match valuator {
                0 => dx = value,
                1 => dy = value,
                _ => {}
            }
            value_index += 1;
            if valuator >= 1 {
                break;
            }
        }
        (dx, dy)
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
    match linux_monitor().ok()? {
        "mutter_idle_monitor" => linux_gnome_monitor::idle_time_ms(),
        _ => linux_x11_monitor::idle_time_ms(),
    }
}

/// The Linux physical-input monitor in use: XInput2 on X11, Mutter's idle clock on GNOME Wayland (7.7.x).
#[cfg(target_os = "linux")]
fn linux_monitor() -> Result<&'static str, String> {
    match linux_x11_monitor::ensure_started() {
        Ok(()) => Ok("xinput2_raw_non_xtest"),
        Err(x11) => match linux_gnome_monitor::ensure_started() {
            Ok(()) => Ok("mutter_idle_monitor"),
            Err(gnome) => Err(format!("{x11}; {gnome}")),
        },
    }
}

/// Mark the agent's own input on Linux, so a monitor that cannot attribute input (Mutter's idle clock) does not count
/// it as the person's. `start` before the events go out, `end` after.
#[cfg(target_os = "linux")]
pub(crate) fn note_agent_input(start: bool) {
    linux_gnome_monitor::note_agent_input(start);
}

/// Whether activity Mutter saw at `activity_ms` is new physical input: later than the last activity already counted,
/// not while the agent's input was in flight, and more than `margin_ms` after the agent's last input began or ended.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn idle_activity_is_physical(
    activity_ms: u64,
    last_counted_ms: u64,
    agent_in_flight: bool,
    last_agent_ms: u64,
    margin_ms: u64,
) -> bool {
    activity_ms > last_counted_ms && !agent_in_flight && activity_ms > last_agent_ms.saturating_add(margin_ms)
}

/// GNOME on Wayland gives no program a global input stream, but Mutter publishes its own clock of the last user input
/// (`org.gnome.Mutter.IdleMonitor.GetIdletime`). That clock counts every input, the agent's libei events included, so
/// activity inside the agent's own input (plus a margin) is set aside and the rest is the person. The clock says when,
/// not what: each poll that finds new physical activity counts as movement, so a takeover needs about 300 ms of
/// sustained input (a moving mouse, typing) and a single key or click is not enough on its own.
#[cfg(target_os = "linux")]
mod linux_gnome_monitor {
    use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
    use std::sync::{mpsc, OnceLock};
    use std::time::{Duration, Instant};

    const POLL: Duration = Duration::from_millis(100);
    /// Activity this close to the agent's own input is the agent's. Measured on GNOME 46: Mutter registers a libei
    /// event before the send returns, so the margin only absorbs clock and scheduling jitter.
    const AGENT_MARGIN_MS: u64 = 150;
    /// Movement credited per poll with new physical activity (the takeover threshold is 500).
    const MOVEMENT_PER_POLL: u64 = 200;

    static CLOCK_ORIGIN: OnceLock<Instant> = OnceLock::new();
    static LAST_PHYSICAL_MS: AtomicU64 = AtomicU64::new(0);
    static LAST_AGENT_MS: AtomicU64 = AtomicU64::new(0);
    static AGENT_IN_FLIGHT: AtomicU32 = AtomicU32::new(0);
    static STATUS: OnceLock<Result<(), String>> = OnceLock::new();

    /// Milliseconds on a clock that starts a day in the past, so the seed (now minus the compositor's idle time) does
    /// not saturate at zero when the person has been idle longer than this process has run.
    fn monotonic_ms() -> u64 {
        CLOCK_ORIGIN
            .get_or_init(|| {
                let now = Instant::now();
                now.checked_sub(Duration::from_secs(24 * 3600)).unwrap_or(now)
            })
            .elapsed()
            .as_millis()
            .min(u128::from(u64::MAX)) as u64
    }

    pub fn note_agent_input(start: bool) {
        LAST_AGENT_MS.store(monotonic_ms(), Ordering::Release);
        if start {
            AGENT_IN_FLIGHT.fetch_add(1, Ordering::AcqRel);
        } else {
            // Never below zero, even if an end were ever noted without its start.
            let mut current = AGENT_IN_FLIGHT.load(Ordering::Acquire);
            while current > 0 {
                match AGENT_IN_FLIGHT.compare_exchange_weak(current, current - 1, Ordering::AcqRel, Ordering::Acquire) {
                    Ok(_) => break,
                    Err(actual) => current = actual,
                }
            }
        }
    }

    fn idle_proxy(connection: &zbus::blocking::Connection) -> zbus::Result<zbus::blocking::Proxy<'_>> {
        zbus::blocking::Proxy::new(
            connection,
            "org.gnome.Mutter.IdleMonitor",
            "/org/gnome/Mutter/IdleMonitor/Core",
            "org.gnome.Mutter.IdleMonitor",
        )
    }

    fn run(sender: mpsc::SyncSender<Result<(), String>>) {
        let wayland = super::linux_session_is_native_wayland(
            std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
            std::env::var("WAYLAND_DISPLAY").ok().as_deref(),
        );
        if !wayland {
            let _ = sender.send(Err("Mutter's idle clock is used on GNOME Wayland only".into()));
            return;
        }
        let connection = match zbus::blocking::Connection::session() {
            Ok(connection) => connection,
            Err(error) => {
                let _ = sender.send(Err(format!("D-Bus session bus: {error}")));
                return;
            }
        };
        let proxy = match idle_proxy(&connection) {
            Ok(proxy) => proxy,
            Err(error) => {
                let _ = sender.send(Err(format!("Mutter IdleMonitor: {error}")));
                return;
            }
        };
        let idle = |proxy: &zbus::blocking::Proxy| proxy.call::<_, _, u64>("GetIdletime", &());
        let first = match idle(&proxy) {
            Ok(idle) => idle,
            Err(error) => {
                let _ = sender.send(Err(format!("Mutter IdleMonitor is not available (not GNOME?): {error}")));
                return;
            }
        };
        // Seeded from the compositor's clock, like the other monitors, so a fresh server is not "active" at once.
        let mut last_counted = monotonic_ms().saturating_sub(first);
        LAST_PHYSICAL_MS.store(last_counted, Ordering::Release);
        if sender.send(Ok(())).is_err() {
            return;
        }
        loop {
            std::thread::sleep(POLL);
            let Ok(idle_ms) = idle(&proxy) else { continue };
            let activity = monotonic_ms().saturating_sub(idle_ms);
            let physical = super::idle_activity_is_physical(
                activity,
                last_counted,
                AGENT_IN_FLIGHT.load(Ordering::Acquire) > 0,
                LAST_AGENT_MS.load(Ordering::Acquire),
                AGENT_MARGIN_MS,
            );
            if activity > last_counted {
                last_counted = activity;
            }
            if physical {
                LAST_PHYSICAL_MS.store(activity, Ordering::Release);
                super::PHYSICAL_MOVEMENT.fetch_add(MOVEMENT_PER_POLL, Ordering::AcqRel);
            }
        }
    }

    pub fn ensure_started() -> &'static Result<(), String> {
        STATUS.get_or_init(|| {
            let (sender, receiver) = mpsc::sync_channel(1);
            std::thread::Builder::new()
                .name("computer-use-mutter-idle-monitor".into())
                .spawn(move || run(sender))
                .map_err(|error| format!("failed to start the Mutter idle monitor: {error}"))?;
            receiver
                .recv_timeout(Duration::from_secs(2))
                .map_err(|error| format!("Mutter idle monitor initialization timed out: {error}"))?
        })
    }

    pub fn idle_time_ms() -> Option<f64> {
        ensure_started().as_ref().ok()?;
        Some(monotonic_ms().saturating_sub(LAST_PHYSICAL_MS.load(Ordering::Acquire)) as f64)
    }
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
        let status = linux_monitor();
        let reason = match &status {
            Err(reason) => reason.clone(),
            Ok("mutter_idle_monitor") => "GNOME Wayland: Mutter's idle clock, minus the agent's own input; it says when the person \
                acted, not what, so a takeover needs sustained input".into(),
            Ok(_) => "best-effort X11 monitor excludes XTEST sources, but arbitrary virtual/uinput devices cannot be proven physical".into(),
        };
        return InputMonitorCapability {
            supported: status.is_ok(),
            backend: status.clone().unwrap_or("unavailable").into(),
            distinguishes_injected: false,
            recommended_poll_ms: if status == Ok("mutter_idle_monitor") { 100 } else { 20 },
            reason: Some(reason),
        };
    }
}
