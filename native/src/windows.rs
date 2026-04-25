use core_foundation::array::CFArrayRef;
use core_foundation::base::{CFRelease, TCFType, ToVoid};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionaryRef;
use core_foundation::number::CFNumber;
use core_foundation::string::{CFString, CFStringRef};
use core_graphics::event::CGEvent;
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use core_graphics::geometry::CGRect;
use napi_derive::napi;
use objc::runtime::{Class, Object};
use objc::{msg_send, sel, sel_impl};
use std::ffi::CStr;

// ---------------------------------------------------------------------------
// CoreGraphics FFI
// ---------------------------------------------------------------------------

type CGWindowID = u32;

const K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY: u32 = 1 << 0;
const K_CG_NULL_WINDOW_ID: CGWindowID = 0;

extern "C" {
    fn CGWindowListCopyWindowInfo(option: u32, relativeToWindow: CGWindowID) -> CFArrayRef;

    // Display mapping
    fn CGMainDisplayID() -> u32;
    fn CGGetActiveDisplayList(max: u32, displays: *mut u32, count: *mut u32) -> i32;
    fn CGDisplayBounds(display: u32) -> CGRect;
}

// ---------------------------------------------------------------------------
// AXUIElement FFI (ApplicationServices framework, already linked in build.rs)
// ---------------------------------------------------------------------------

type AXUIElementRef = *mut std::ffi::c_void;
type AXError = i32;
type RawCFTypeRef = *const std::ffi::c_void;

const K_AX_ERROR_SUCCESS: AXError = 0;

extern "C" {
    fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut RawCFTypeRef,
    ) -> AXError;
    fn AXUIElementPerformAction(element: AXUIElementRef, action: CFStringRef) -> AXError;
    fn AXUIElementSetAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: RawCFTypeRef,
    ) -> AXError;
    fn AXValueGetValue(
        value: RawCFTypeRef,
        value_type: u32,
        value_ptr: *mut std::ffi::c_void,
    ) -> bool;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn nsstring_to_string(nsstr: *mut Object) -> Option<String> {
    if nsstr.is_null() {
        return None;
    }
    unsafe {
        let cstr: *const i8 = msg_send![nsstr, UTF8String];
        if cstr.is_null() {
            return None;
        }
        Some(CStr::from_ptr(cstr).to_string_lossy().into_owned())
    }
}

fn shared_workspace() -> *mut Object {
    unsafe {
        let cls = Class::get("NSWorkspace").unwrap();
        msg_send![cls, sharedWorkspace]
    }
}

/// Resolve bundle identifier for a given PID via NSRunningApplication.
fn bundle_id_for_pid(pid: i32) -> Option<String> {
    unsafe {
        let cls = Class::get("NSRunningApplication").unwrap();
        let app: *mut Object =
            msg_send![cls, runningApplicationWithProcessIdentifier: pid];
        if app.is_null() {
            return None;
        }
        let bid: *mut Object = msg_send![app, bundleIdentifier];
        nsstring_to_string(bid)
    }
}

/// Resolve localized display name for a given PID via NSRunningApplication.
fn display_name_for_pid(pid: i32) -> Option<String> {
    unsafe {
        let cls = Class::get("NSRunningApplication").unwrap();
        let app: *mut Object =
            msg_send![cls, runningApplicationWithProcessIdentifier: pid];
        if app.is_null() {
            return None;
        }
        let name: *mut Object = msg_send![app, localizedName];
        nsstring_to_string(name)
    }
}

/// Get the PID of the frontmost application.
fn frontmost_pid() -> Option<i32> {
    unsafe {
        let ws = shared_workspace();
        let app: *mut Object = msg_send![ws, frontmostApplication];
        if app.is_null() {
            return None;
        }
        let pid: i32 = msg_send![app, processIdentifier];
        Some(pid)
    }
}

/// Determine which display contains the center of the given bounds.
fn display_id_for_bounds(x: f64, y: f64, w: f64, h: f64) -> u32 {
    let cx = x + w / 2.0;
    let cy = y + h / 2.0;

    let mut displays = [0u32; 16];
    let mut count = 0u32;
    let err = unsafe { CGGetActiveDisplayList(16, displays.as_mut_ptr(), &mut count) };
    if err != 0 || count == 0 {
        return unsafe { CGMainDisplayID() };
    }

    for i in 0..count as usize {
        let did = displays[i];
        let bounds = unsafe { CGDisplayBounds(did) };
        if cx >= bounds.origin.x
            && cx < bounds.origin.x + bounds.size.width
            && cy >= bounds.origin.y
            && cy < bounds.origin.y + bounds.size.height
        {
            return did;
        }
    }

    unsafe { CGMainDisplayID() }
}

// ---------------------------------------------------------------------------
// Low-level CFDictionary helpers that work with raw pointers
// ---------------------------------------------------------------------------

/// Get a raw CFTypeRef from a CFDictionary by string key.
unsafe fn dict_raw_get(dict: CFDictionaryRef, key: &str) -> Option<RawCFTypeRef> {
    extern "C" {
        fn CFDictionaryGetValue(dict: CFDictionaryRef, key: RawCFTypeRef) -> RawCFTypeRef;
    }
    let cf_key = CFString::new(key);
    let val = CFDictionaryGetValue(dict, cf_key.as_concrete_TypeRef() as RawCFTypeRef);
    if val.is_null() {
        None
    } else {
        Some(val)
    }
}

/// Get a string value from a CFDictionary.
fn dict_get_string(dict: CFDictionaryRef, key: &str) -> Option<String> {
    unsafe {
        let val = dict_raw_get(dict, key)?;
        let cf_str: CFString = TCFType::wrap_under_get_rule(val as CFStringRef);
        Some(cf_str.to_string())
    }
}

/// Get an i64 value from a CFDictionary.
fn dict_get_i64(dict: CFDictionaryRef, key: &str) -> Option<i64> {
    unsafe {
        let val = dict_raw_get(dict, key)?;
        let cf_num: CFNumber = TCFType::wrap_under_get_rule(val as *const _);
        cf_num.to_i64()
    }
}

/// Get an f64 value from a CFDictionary.
fn dict_get_f64(dict: CFDictionaryRef, key: &str) -> Option<f64> {
    unsafe {
        let val = dict_raw_get(dict, key)?;
        let cf_num: CFNumber = TCFType::wrap_under_get_rule(val as *const _);
        cf_num.to_f64().or_else(|| cf_num.to_i64().map(|n| n as f64))
    }
}

/// Get a sub-dictionary ref from a CFDictionary.
fn dict_get_dict(dict: CFDictionaryRef, key: &str) -> Option<CFDictionaryRef> {
    unsafe {
        let val = dict_raw_get(dict, key)?;
        Some(val as CFDictionaryRef)
    }
}

/// Build a JSON window record from a CoreGraphics window info dictionary.
fn window_record_from_dict(
    dict: CFDictionaryRef,
    front_pid: Option<i32>,
) -> Option<serde_json::Value> {
    let layer = dict_get_i64(dict, "kCGWindowLayer")?;
    if layer != 0 {
        return None;
    }

    let window_id = dict_get_i64(dict, "kCGWindowNumber")? as u32;
    let pid = dict_get_i64(dict, "kCGWindowOwnerPID")? as i32;
    let owner_name = dict_get_string(dict, "kCGWindowOwnerName").unwrap_or_default();
    let title = dict_get_string(dict, "kCGWindowName");
    let alpha = dict_get_f64(dict, "kCGWindowAlpha").unwrap_or(1.0);

    let bundle_id = bundle_id_for_pid(pid);
    let display_name = display_name_for_pid(pid).unwrap_or(owner_name);

    // Bounds
    let (bx, by, bw, bh) = if let Some(bounds_ref) = dict_get_dict(dict, "kCGWindowBounds") {
        let x = dict_get_f64(bounds_ref, "X").unwrap_or(0.0);
        let y = dict_get_f64(bounds_ref, "Y").unwrap_or(0.0);
        let w = dict_get_f64(bounds_ref, "Width").unwrap_or(0.0);
        let h = dict_get_f64(bounds_ref, "Height").unwrap_or(0.0);
        (x, y, w, h)
    } else {
        (0.0, 0.0, 0.0, 0.0)
    };

    let display_id = display_id_for_bounds(bx, by, bw, bh);
    let is_focused = front_pid.map_or(false, |fp| fp == pid);

    Some(serde_json::json!({
        "windowId": window_id,
        "bundleId": bundle_id,
        "displayName": display_name,
        "pid": pid,
        "title": title,
        "bounds": {
            "x": bx,
            "y": by,
            "width": bw,
            "height": bh,
        },
        "isOnScreen": alpha > 0.0,
        "isFocused": is_focused,
        "displayId": display_id,
    }))
}

/// Get the count and raw dict pointers from the CG window list.
fn cg_window_list_raw() -> Option<(CFArrayRef, usize)> {
    unsafe {
        let array_ref = CGWindowListCopyWindowInfo(
            K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY,
            K_CG_NULL_WINDOW_ID,
        );
        if array_ref.is_null() {
            return None;
        }
        extern "C" {
            fn CFArrayGetCount(array: CFArrayRef) -> isize;
        }
        let count = CFArrayGetCount(array_ref) as usize;
        Some((array_ref, count))
    }
}

/// Get a dictionary ref at index from a CFArray.
unsafe fn cg_array_get_dict(array: CFArrayRef, index: usize) -> CFDictionaryRef {
    extern "C" {
        fn CFArrayGetValueAtIndex(array: CFArrayRef, idx: isize) -> RawCFTypeRef;
    }
    CFArrayGetValueAtIndex(array, index as isize) as CFDictionaryRef
}

// ---------------------------------------------------------------------------
// Public NAPI functions
// ---------------------------------------------------------------------------

/// List on-screen windows using CGWindowListCopyWindowInfo directly.
/// Replaces the Swift subprocess in apps.rs.
/// Includes displayId via display mapping.
#[napi]
pub fn list_windows(bundle_id: Option<String>) -> napi::Result<serde_json::Value> {
    let front_pid = frontmost_pid();
    let (array_ref, count) = cg_window_list_raw()
        .ok_or_else(|| napi::Error::from_reason("CGWindowListCopyWindowInfo returned null"))?;

    let mut result = Vec::new();
    for i in 0..count {
        let dict = unsafe { cg_array_get_dict(array_ref, i) };

        if let Some(record) = window_record_from_dict(dict, front_pid) {
            if let Some(filter) = &bundle_id {
                if record.get("bundleId").and_then(|v| v.as_str()) != Some(filter.as_str()) {
                    continue;
                }
            }
            result.push(record);
        }
    }

    unsafe { CFRelease(array_ref as *const _) };
    Ok(serde_json::json!(result))
}

/// Look up a single window by its CGWindowID.
/// Returns the same shape as a list_windows entry, or null if not found.
#[napi]
pub fn get_window(window_id: u32) -> napi::Result<serde_json::Value> {
    let front_pid = frontmost_pid();
    let (array_ref, count) = cg_window_list_raw()
        .ok_or_else(|| napi::Error::from_reason("CGWindowListCopyWindowInfo returned null"))?;

    for i in 0..count {
        let dict = unsafe { cg_array_get_dict(array_ref, i) };
        let wid = dict_get_i64(dict, "kCGWindowNumber");
        if wid == Some(window_id as i64) {
            // Don't filter by layer here — window_record_from_dict does that,
            // but for get_window we still want layer-0 only per design
            if let Some(record) = window_record_from_dict(dict, front_pid) {
                unsafe { CFRelease(array_ref as *const _) };
                return Ok(record);
            }
        }
    }

    unsafe { CFRelease(array_ref as *const _) };
    Ok(serde_json::json!(null))
}

/// Find the window under the current cursor position.
/// Combines cursorPosition() with CGWindowListCopyWindowInfo + point-in-bounds.
#[napi]
pub fn get_cursor_window() -> napi::Result<serde_json::Value> {
    // Get cursor position via CGEvent
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| napi::Error::from_reason("Failed to create CGEventSource"))?;
    let event = CGEvent::new(source)
        .map_err(|_| napi::Error::from_reason("Failed to create CGEvent for cursor position"))?;
    let loc = event.location();
    let cx = loc.x;
    let cy = loc.y;

    let front_pid = frontmost_pid();
    let (array_ref, count) = cg_window_list_raw()
        .ok_or_else(|| napi::Error::from_reason("CGWindowListCopyWindowInfo returned null"))?;

    // Windows are returned front-to-back, so the first match is the topmost.
    for i in 0..count {
        let dict = unsafe { cg_array_get_dict(array_ref, i) };

        // Only consider layer-0 windows
        let layer = dict_get_i64(dict, "kCGWindowLayer");
        if layer != Some(0) {
            continue;
        }

        if let Some(bounds_ref) = dict_get_dict(dict, "kCGWindowBounds") {
            let x = dict_get_f64(bounds_ref, "X").unwrap_or(0.0);
            let y = dict_get_f64(bounds_ref, "Y").unwrap_or(0.0);
            let w = dict_get_f64(bounds_ref, "Width").unwrap_or(0.0);
            let h = dict_get_f64(bounds_ref, "Height").unwrap_or(0.0);

            if cx >= x && cx < x + w && cy >= y && cy < y + h {
                if let Some(record) = window_record_from_dict(dict, front_pid) {
                    unsafe { CFRelease(array_ref as *const _) };
                    return Ok(record);
                }
            }
        }
    }

    unsafe { CFRelease(array_ref as *const _) };
    // Cursor is over the desktop — no window found
    Ok(serde_json::json!(null))
}

/// Activate (raise) a specific window using AXUIElement API.
/// 1. Find the owning PID from CGWindowListCopyWindowInfo
/// 2. Create AXUIElementCreateApplication(pid)
/// 3. Enumerate AXUIElement children to find matching window
/// 4. AXUIElementPerformAction(kAXRaiseAction)
#[napi]
pub fn activate_window(
    window_id: u32,
    timeout_ms: Option<i32>,
) -> napi::Result<serde_json::Value> {
    let _timeout = timeout_ms.unwrap_or(3000) as u64;

    // Step 1: Find the window info from CG to get PID, title, and bounds
    let (array_ref, count) = cg_window_list_raw()
        .ok_or_else(|| napi::Error::from_reason("CGWindowListCopyWindowInfo returned null"))?;

    let mut target_pid: Option<i32> = None;
    let mut target_title: Option<String> = None;
    let mut target_bounds: Option<(f64, f64, f64, f64)> = None;

    for i in 0..count {
        let dict = unsafe { cg_array_get_dict(array_ref, i) };
        let wid = dict_get_i64(dict, "kCGWindowNumber");
        if wid == Some(window_id as i64) {
            target_pid = dict_get_i64(dict, "kCGWindowOwnerPID").map(|p| p as i32);
            target_title = dict_get_string(dict, "kCGWindowName");
            if let Some(bounds_ref) = dict_get_dict(dict, "kCGWindowBounds") {
                let x = dict_get_f64(bounds_ref, "X").unwrap_or(0.0);
                let y = dict_get_f64(bounds_ref, "Y").unwrap_or(0.0);
                let w = dict_get_f64(bounds_ref, "Width").unwrap_or(0.0);
                let h = dict_get_f64(bounds_ref, "Height").unwrap_or(0.0);
                target_bounds = Some((x, y, w, h));
            }
            break;
        }
    }

    unsafe { CFRelease(array_ref as *const _) };

    let pid = match target_pid {
        Some(p) => p,
        None => {
            return Ok(serde_json::json!({
                "windowId": window_id,
                "activated": false,
                "frontmostAfter": serde_json::Value::Null,
                "reason": "window_not_found",
            }));
        }
    };

    // Step 2: Create AXUIElement for the application
    let ax_app = unsafe { AXUIElementCreateApplication(pid) };
    if ax_app.is_null() {
        return Ok(serde_json::json!({
            "windowId": window_id,
            "activated": false,
            "frontmostAfter": serde_json::Value::Null,
            "reason": "ax_app_creation_failed",
        }));
    }

    // Step 3: Get the windows attribute
    let ax_windows_key = CFString::new("AXWindows");
    let mut ax_windows_value: RawCFTypeRef = std::ptr::null();
    let err = unsafe {
        AXUIElementCopyAttributeValue(
            ax_app,
            ax_windows_key.as_concrete_TypeRef(),
            &mut ax_windows_value,
        )
    };

    if err != K_AX_ERROR_SUCCESS || ax_windows_value.is_null() {
        unsafe { CFRelease(ax_app as *const _) };
        return Ok(serde_json::json!({
            "windowId": window_id,
            "activated": false,
            "frontmostAfter": serde_json::Value::Null,
            "reason": "raise_failed",
        }));
    }

    // ax_windows_value is a CFArray of AXUIElements — use raw CFArray access
    extern "C" {
        fn CFArrayGetCount(array: CFArrayRef) -> isize;
        fn CFArrayGetValueAtIndex(array: CFArrayRef, idx: isize) -> RawCFTypeRef;
    }

    let ax_array = ax_windows_value as CFArrayRef;
    let ax_count = unsafe { CFArrayGetCount(ax_array) } as usize;

    let mut raised = false;

    for i in 0..ax_count {
        let ax_win = unsafe { CFArrayGetValueAtIndex(ax_array, i as isize) } as AXUIElementRef;

        // Try to match by title
        let mut matched = false;

        if let Some(ref expected_title) = target_title {
            let title_key = CFString::new("AXTitle");
            let mut title_val: RawCFTypeRef = std::ptr::null();
            let title_err = unsafe {
                AXUIElementCopyAttributeValue(
                    ax_win,
                    title_key.as_concrete_TypeRef(),
                    &mut title_val,
                )
            };
            if title_err == K_AX_ERROR_SUCCESS && !title_val.is_null() {
                let ax_title: CFString =
                    unsafe { TCFType::wrap_under_get_rule(title_val as CFStringRef) };
                if ax_title.to_string() == *expected_title {
                    matched = true;
                }
            }
        }

        // Also try to match by position/size if title didn't match
        if !matched {
            if let Some((ex, ey, ew, eh)) = target_bounds {
                let pos_key = CFString::new("AXPosition");
                let size_key = CFString::new("AXSize");
                let mut pos_val: RawCFTypeRef = std::ptr::null();
                let mut size_val: RawCFTypeRef = std::ptr::null();

                let pos_err = unsafe {
                    AXUIElementCopyAttributeValue(
                        ax_win,
                        pos_key.as_concrete_TypeRef(),
                        &mut pos_val,
                    )
                };
                let size_err = unsafe {
                    AXUIElementCopyAttributeValue(
                        ax_win,
                        size_key.as_concrete_TypeRef(),
                        &mut size_val,
                    )
                };

                if pos_err == K_AX_ERROR_SUCCESS
                    && size_err == K_AX_ERROR_SUCCESS
                    && !pos_val.is_null()
                    && !size_val.is_null()
                {
                    let mut point = core_graphics::geometry::CGPoint::new(0.0, 0.0);
                    let mut size = core_graphics::geometry::CGSize::new(0.0, 0.0);

                    // kAXValueCGPointType = 1, kAXValueCGSizeType = 2
                    let got_point = unsafe {
                        AXValueGetValue(
                            pos_val,
                            1,
                            &mut point as *mut _ as *mut std::ffi::c_void,
                        )
                    };
                    let got_size = unsafe {
                        AXValueGetValue(
                            size_val,
                            2,
                            &mut size as *mut _ as *mut std::ffi::c_void,
                        )
                    };

                    if got_point && got_size {
                        let dx = (point.x - ex).abs();
                        let dy = (point.y - ey).abs();
                        let dw = (size.width - ew).abs();
                        let dh = (size.height - eh).abs();
                        if dx < 2.0 && dy < 2.0 && dw < 2.0 && dh < 2.0 {
                            matched = true;
                        }
                    }
                }
            }
        }

        // If we only have one window, just use it
        if !matched && ax_count == 1 {
            matched = true;
        }

        if matched {
            // Perform kAXRaiseAction
            let raise_action = CFString::new("AXRaise");
            let raise_err = unsafe {
                AXUIElementPerformAction(ax_win, raise_action.as_concrete_TypeRef())
            };

            if raise_err == K_AX_ERROR_SUCCESS {
                raised = true;
            } else {
                // Fallback: set AXMain attribute
                let main_key = CFString::new("AXMain");
                let _ = unsafe {
                    AXUIElementSetAttributeValue(
                        ax_win,
                        main_key.as_concrete_TypeRef(),
                        CFBoolean::true_value().to_void() as RawCFTypeRef,
                    )
                };
                raised = true;
            }
            break;
        }
    }

    unsafe {
        CFRelease(ax_windows_value);
        CFRelease(ax_app as *const _);
    }

    // Also activate the owning app to bring it frontmost
    if raised {
        unsafe {
            let ws = shared_workspace();
            let apps: *mut Object = msg_send![ws, runningApplications];
            let count: usize = msg_send![apps, count];
            for i in 0..count {
                let app: *mut Object = msg_send![apps, objectAtIndex: i];
                let app_pid: i32 = msg_send![app, processIdentifier];
                if app_pid == pid {
                    let _: objc::runtime::BOOL =
                        msg_send![app, activateWithOptions: 1u64]; // NSApplicationActivateIgnoringOtherApps
                    break;
                }
            }
        }
    }

    let front_after = frontmost_pid().and_then(|p| bundle_id_for_pid(p));

    Ok(serde_json::json!({
        "windowId": window_id,
        "activated": raised,
        "frontmostAfter": front_after,
        "reason": if raised { serde_json::Value::Null } else { serde_json::json!("raise_failed") },
    }))
}
