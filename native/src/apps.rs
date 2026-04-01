use napi_derive::napi;
use objc::runtime::{Class, Object, BOOL, YES};
use objc::{msg_send, sel, sel_impl};
use std::ffi::CStr;

fn nsstring_to_string(nsstr: *mut Object) -> Option<String> {
    if nsstr.is_null() { return None; }
    unsafe {
        let cstr: *const i8 = msg_send![nsstr, UTF8String];
        if cstr.is_null() { return None; }
        Some(CStr::from_ptr(cstr).to_string_lossy().into_owned())
    }
}

fn shared_workspace() -> *mut Object {
    unsafe {
        let cls = Class::get("NSWorkspace").unwrap();
        msg_send![cls, sharedWorkspace]
    }
}

#[napi]
pub fn get_frontmost_app() -> napi::Result<serde_json::Value> {
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
    unsafe {
        let ws = shared_workspace();
        let apps: *mut Object = msg_send![ws, runningApplications];
        let count: usize = msg_send![apps, count];
        let mut result = Vec::new();

        for i in 0..count {
            let app: *mut Object = msg_send![apps, objectAtIndex: i];
            let policy: i64 = msg_send![app, activationPolicy];
            if policy != 0 { continue; } // NSApplicationActivationPolicyRegular = 0
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
        msg_send![cls, stringWithUTF8String: s.as_ptr() as *const i8]
    }
}
