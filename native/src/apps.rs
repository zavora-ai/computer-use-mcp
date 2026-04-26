use napi_derive::napi;
use objc::runtime::{Class, Object, BOOL, YES};
use objc::{msg_send, sel, sel_impl};
use std::ffi::{CStr, CString};

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

// NSWorkspace.runningApplications is KVO-observed; its contents only refresh
// when the main run loop pumps notifications. In a long-lived Node host that
// never spins the run loop, the array is frozen at whatever apps existed at
// process start. Draining pending sources + timers in default mode (zero
// timeout, return after the first source fires) refreshes the observed
// collection without introducing unbounded dispatch side effects.
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRunLoopRunInMode(mode: *const std::ffi::c_void, seconds: f64, returnAfterSourceHandled: bool) -> i32;
    static kCFRunLoopDefaultMode: *const std::ffi::c_void;
}

fn drain_runloop() {
    unsafe {
        // Up to ~4 drain cycles — each pump may queue follow-up notifications.
        // Stops early when no source fires.
        for _ in 0..4 {
            let result = CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.0, true);
            // 1 = kCFRunLoopRunHandledSource (something fired)
            // 2 = kCFRunLoopRunStopped, 3 = kCFRunLoopRunTimedOut, 4 = kCFRunLoopRunFinished
            if result != 1 {
                break;
            }
        }
    }
}

/// Pump the main CFRunLoop once in default mode.
///
/// Long-lived Node hosts under libuv never spin the main run loop, so KVO
/// updates (e.g. `NSWorkspace.runningApplications` refreshes) and
/// `@MainActor` continuations can go unserviced. Callers schedule this on a
/// 1 ms interval during a computer-use session to keep macOS state fresh
/// without blocking. Cheap when no sources are pending.
#[napi(js_name = "drainRunloop")]
pub fn drain_runloop_pub() {
    drain_runloop();
}

#[napi]
pub fn get_frontmost_app() -> napi::Result<serde_json::Value> {
    drain_runloop();
    unsafe {
        let ws = shared_workspace();
        let app: *mut Object = msg_send![ws, frontmostApplication];
        if app.is_null() {
            return Ok(serde_json::json!(null));
        }
        let bid: *mut Object = msg_send![app, bundleIdentifier];
        let name: *mut Object = msg_send![app, localizedName];
        let pid: i32 = msg_send![app, processIdentifier];
        Ok(serde_json::json!({
            "bundleId": nsstring_to_string(bid),
            "displayName": nsstring_to_string(name),
            "pid": pid,
        }))
    }
}

/// Activate an app and poll until it's frontmost (up to timeout_ms).
/// Runs in-process — no focus-stealing from Terminal.
#[napi]
pub fn activate_app(bundle_id: String, timeout_ms: Option<i32>) -> napi::Result<serde_json::Value> {
    let timeout = timeout_ms.unwrap_or(2000) as u64;
    drain_runloop();
    unsafe {
        let ws = shared_workspace();
        let apps: *mut Object = msg_send![ws, runningApplications];
        let count: usize = msg_send![apps, count];

        let mut target: *mut Object = std::ptr::null_mut();
        for i in 0..count {
            let app: *mut Object = msg_send![apps, objectAtIndex: i];
            let bid: *mut Object = msg_send![app, bundleIdentifier];
            if let Some(b) = nsstring_to_string(bid) {
                if b == bundle_id {
                    target = app;
                    break;
                }
            }
        }

        if target.is_null() {
            // Not running — try to open it
            let bid_nsstr = nsstring_from_str(&bundle_id);
            if bid_nsstr.is_null() {
                return Err(napi::Error::from_reason("Invalid bundle_id"));
            }
            let url: *mut Object = msg_send![ws, URLForApplicationWithBundleIdentifier: bid_nsstr];
            if !url.is_null() {
                let config_cls = Class::get("NSWorkspaceOpenConfiguration").unwrap();
                let config: *mut Object = msg_send![config_cls, configuration];
                let _: () = msg_send![ws, openApplicationAtURL: url configuration: config completionHandler: std::ptr::null::<Object>()];
                std::thread::sleep(std::time::Duration::from_millis(timeout.min(2000)));
            }
            return Ok(serde_json::json!({ "activated": false, "reason": "not_running" }));
        }

        // Activate
        let _: BOOL = msg_send![target, activateWithOptions: 1u64]; // NSApplicationActivateIgnoringOtherApps

        // Poll until frontmost
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout);
        let mut activated = false;
        while std::time::Instant::now() < deadline {
            let front: *mut Object = msg_send![ws, frontmostApplication];
            let front_bid: *mut Object = msg_send![front, bundleIdentifier];
            if let Some(b) = nsstring_to_string(front_bid) {
                if b == bundle_id {
                    activated = true;
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(30));
        }

        let name: *mut Object = msg_send![target, localizedName];
        Ok(serde_json::json!({
            "bundleId": bundle_id,
            "displayName": nsstring_to_string(name),
            "activated": activated,
        }))
    }
}

#[napi]
pub fn list_running_apps() -> napi::Result<serde_json::Value> {
    drain_runloop();
    unsafe {
        let ws = shared_workspace();
        let apps: *mut Object = msg_send![ws, runningApplications];
        let count: usize = msg_send![apps, count];
        let mut result = Vec::new();

        for i in 0..count {
            let app: *mut Object = msg_send![apps, objectAtIndex: i];
            let policy: i64 = msg_send![app, activationPolicy];
            if policy != 0 {
                continue;
            } // NSApplicationActivationPolicyRegular = 0
            let bid: *mut Object = msg_send![app, bundleIdentifier];
            let name: *mut Object = msg_send![app, localizedName];
            let pid: i32 = msg_send![app, processIdentifier];
            let hidden: BOOL = msg_send![app, isHidden];
            result.push(serde_json::json!({
                "bundleId": nsstring_to_string(bid),
                "displayName": nsstring_to_string(name),
                "pid": pid,
                "isHidden": hidden == YES,
            }));
        }
        Ok(serde_json::json!(result))
    }
}

/// Hide every non-target regular app except those in `keep_visible`.
///
/// Used by the session layer as the muscular option against focus-stealing
/// background apps (screenshot watchers, notification panels, etc.). The
/// session promises the target app will be frontmost when this returns.
///
/// Returns the list of bundle IDs we actually hid — apps already hidden at
/// call time are NOT included, so a later `unhide_bundles` helper can be
/// idempotent.
#[napi]
pub fn prepare_display(
    target_bundle_id: String,
    keep_visible: Vec<String>,
) -> napi::Result<serde_json::Value> {
    drain_runloop();
    let mut hidden: Vec<String> = Vec::new();

    unsafe {
        let ws = shared_workspace();
        let apps: *mut Object = msg_send![ws, runningApplications];
        let count: usize = msg_send![apps, count];

        for i in 0..count {
            let app: *mut Object = msg_send![apps, objectAtIndex: i];
            // Only regular apps — skip agents/menu-extras (they usually
            // don't have a visible window anyway, and some break on `hide`).
            let policy: i64 = msg_send![app, activationPolicy];
            if policy != 0 {
                continue;
            }
            let bid: *mut Object = msg_send![app, bundleIdentifier];
            let bid_str = match nsstring_to_string(bid) {
                Some(s) => s,
                None => continue,
            };

            // Never hide the target or the keep-visible set.
            if bid_str == target_bundle_id {
                continue;
            }
            if keep_visible.iter().any(|k| k == &bid_str) {
                continue;
            }

            // Skip already-hidden apps so our return value reflects the
            // delta we caused, not the preexisting state.
            let already_hidden: BOOL = msg_send![app, isHidden];
            if already_hidden == YES {
                continue;
            }

            let _: BOOL = msg_send![app, hide];
            hidden.push(bid_str);
        }
    }

    Ok(serde_json::json!({
        "targetBundleId": target_bundle_id,
        "hiddenBundleIds": hidden,
    }))
}

#[napi]
pub fn hide_app(bundle_id: String) -> napi::Result<bool> {
    unsafe {
        let ws = shared_workspace();
        let apps: *mut Object = msg_send![ws, runningApplications];
        let count: usize = msg_send![apps, count];
        let mut found = false;
        for i in 0..count {
            let app: *mut Object = msg_send![apps, objectAtIndex: i];
            let bid: *mut Object = msg_send![app, bundleIdentifier];
            if nsstring_to_string(bid).as_deref() == Some(&bundle_id) {
                let _: BOOL = msg_send![app, hide];
                found = true;
            }
        }
        Ok(found)
    }
}

#[napi]
pub fn unhide_app(bundle_id: String) -> napi::Result<bool> {
    unsafe {
        let ws = shared_workspace();
        let apps: *mut Object = msg_send![ws, runningApplications];
        let count: usize = msg_send![apps, count];
        let mut found = false;
        for i in 0..count {
            let app: *mut Object = msg_send![apps, objectAtIndex: i];
            let bid: *mut Object = msg_send![app, bundleIdentifier];
            if nsstring_to_string(bid).as_deref() == Some(&bundle_id) {
                let _: BOOL = msg_send![app, unhide];
                found = true;
            }
        }
        Ok(found)
    }
}

fn nsstring_from_str(s: &str) -> *mut Object {
    unsafe {
        let cls = Class::get("NSString").unwrap();
        let Ok(cstr) = CString::new(s) else {
            return std::ptr::null_mut();
        };
        msg_send![cls, stringWithUTF8String: cstr.as_ptr()]
    }
}
