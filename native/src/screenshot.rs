use base64::Engine;
use core_foundation::array::CFArrayRef;
use core_foundation::base::{CFRelease, TCFType};
use core_foundation::dictionary::CFDictionaryRef;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use napi_derive::napi;
use objc::runtime::{Class, Object};
use objc::{msg_send, sel, sel_impl};
use std::collections::hash_map::DefaultHasher;
use std::ffi::CStr;
use std::fs::OpenOptions;
use std::hash::{Hash, Hasher};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};

static SHOT_SEQ: AtomicU32 = AtomicU32::new(0);

type CGWindowID = u32;
type RawCFTypeRef = *const std::ffi::c_void;

extern "C" {
    fn CGWindowListCopyWindowInfo(option: u32, relativeToWindow: CGWindowID) -> CFArrayRef;
    fn CFArrayGetCount(array: CFArrayRef) -> isize;
    fn CFArrayGetValueAtIndex(array: CFArrayRef, idx: isize) -> RawCFTypeRef;
    fn CFDictionaryGetValue(dict: CFDictionaryRef, key: RawCFTypeRef) -> RawCFTypeRef;
}

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

fn pid_for_bundle(bundle_id: &str) -> Option<i32> {
    unsafe {
        let ws = shared_workspace();
        let apps: *mut Object = msg_send![ws, runningApplications];
        let count: usize = msg_send![apps, count];

        for i in 0..count {
            let app: *mut Object = msg_send![apps, objectAtIndex: i];
            let bid: *mut Object = msg_send![app, bundleIdentifier];
            if nsstring_to_string(bid).as_deref() == Some(bundle_id) {
                let pid: i32 = msg_send![app, processIdentifier];
                return Some(pid);
            }
        }
    }
    None
}

/// Get an i64 value from a raw CFDictionary by string key.
unsafe fn dict_get_i64(dict: CFDictionaryRef, key: &str) -> Option<i64> {
    let cf_key = CFString::new(key);
    let val = CFDictionaryGetValue(dict, cf_key.as_concrete_TypeRef() as RawCFTypeRef);
    if val.is_null() {
        return None;
    }
    let cf_num: CFNumber = TCFType::wrap_under_get_rule(val as *const _);
    cf_num.to_i64()
}

/// Get the CGWindowID of the frontmost layer-0 window belonging to the given bundle ID.
/// Uses native CoreGraphics FFI instead of spawning a Swift subprocess.
fn window_id_for_bundle(bundle_id: &str) -> Option<u32> {
    let pid = pid_for_bundle(bundle_id)? as i64;

    unsafe {
        let array_ref = CGWindowListCopyWindowInfo(1 << 0, 0); // kCGWindowListOptionOnScreenOnly
        if array_ref.is_null() {
            return None;
        }
        let count = CFArrayGetCount(array_ref) as usize;

        for i in 0..count {
            let dict = CFArrayGetValueAtIndex(array_ref, i as isize) as CFDictionaryRef;

            // Check layer == 0
            if dict_get_i64(dict, "kCGWindowLayer") != Some(0) {
                continue;
            }

            // Check PID matches
            if dict_get_i64(dict, "kCGWindowOwnerPID") != Some(pid) {
                continue;
            }

            // Get window ID
            if let Some(wid) = dict_get_i64(dict, "kCGWindowNumber") {
                CFRelease(array_ref as *const _);
                return Some(wid as u32);
            }
        }

        CFRelease(array_ref as *const _);
    }

    None
}

#[napi]
pub fn take_screenshot(
    width: Option<u32>,
    target_app: Option<String>,
    quality: Option<u32>,
    previous_hash: Option<String>,
    window_id: Option<u32>,
) -> napi::Result<serde_json::Value> {
    let seq = SHOT_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = format!("/tmp/cu-{}-{}.jpg", std::process::id(), seq);

    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(|e| napi::Error::from_reason(format!("temp file: {e}")))?;

    let mut args: Vec<String> = vec!["-x".into(), "-t".into(), "jpg".into()];

    // window_id takes precedence over target_app
    if let Some(wid) = window_id {
        args.push("-l".into());
        args.push(wid.to_string());
    } else if let Some(bundle_id) = target_app {
        let wid = window_id_for_bundle(&bundle_id).ok_or_else(|| {
            let _ = std::fs::remove_file(&tmp);
            napi::Error::from_reason(format!(
                "No on-screen window found for target_app: {bundle_id}"
            ))
        })?;
        args.push("-l".into());
        args.push(wid.to_string());
    }

    args.push(tmp.clone());

    let status = Command::new("screencapture")
        .args(&args)
        .status()
        .map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            napi::Error::from_reason(format!("screencapture: {e}"))
        })?;

    if !status.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err(napi::Error::from_reason("screencapture failed"));
    }

    // Resize width if requested
    if let Some(w) = width {
        let _ = Command::new("sips")
            .args(["--resampleWidth", &w.to_string(), &tmp])
            .output();
    }

    // Re-encode at requested quality (sips default is ~85; we use explicit quality)
    let q = quality.unwrap_or(80).clamp(1, 100);
    if q != 85 {
        // sips --setProperty formatOptions <quality> re-encodes the JPEG in-place
        let _ = Command::new("sips")
            .args(["--setProperty", "formatOptions", &q.to_string(), &tmp])
            .output();
    }

    let data = std::fs::read(&tmp).map_err(|e| napi::Error::from_reason(format!("read: {e}")))?;
    let _ = std::fs::remove_file(&tmp);

    let (w, h) = jpeg_dimensions(&data).unwrap_or((0, 0));
    let mut hasher = DefaultHasher::new();
    data.hash(&mut hasher);
    let hash = format!("{:016x}", hasher.finish());

    if previous_hash.as_deref() == Some(hash.as_str()) {
        return Ok(serde_json::json!({
            "width": w,
            "height": h,
            "mimeType": "image/jpeg",
            "hash": hash,
            "unchanged": true,
        }));
    }

    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
    Ok(serde_json::json!({
        "base64": b64,
        "width": w,
        "height": h,
        "mimeType": "image/jpeg",
        "hash": hash,
        "unchanged": false,
    }))
}

/// Extract width/height from JPEG SOF0/SOF2 marker
fn jpeg_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    let mut i = 0;
    while i + 1 < data.len() {
        if data[i] != 0xFF {
            i += 1;
            continue;
        }
        let marker = data[i + 1];
        if marker == 0xC0 || marker == 0xC2 {
            if i + 9 < data.len() {
                let h = ((data[i + 5] as u32) << 8) | data[i + 6] as u32;
                let w = ((data[i + 7] as u32) << 8) | data[i + 8] as u32;
                return Some((w, h));
            }
        }
        if marker == 0xD8 || marker == 0xD9 || marker == 0x00 {
            i += 2;
        } else if i + 3 < data.len() {
            let len = ((data[i + 2] as usize) << 8) | data[i + 3] as usize;
            i += 2 + len;
        } else {
            break;
        }
    }
    None
}
