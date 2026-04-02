use base64::Engine;
use napi_derive::napi;
use std::fs::OpenOptions;
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};

static SHOT_SEQ: AtomicU32 = AtomicU32::new(0);

/// Get the CGWindowID of the frontmost window belonging to the given bundle ID.
fn window_id_for_bundle(bundle_id: &str) -> Option<u32> {
    let pid_out = Command::new("osascript")
        .args(["-e", &format!(
            "tell application \"System Events\" to get unix id of (first application process whose bundle identifier is \"{}\")",
            bundle_id
        )])
        .output()
        .ok()?;
    let pid: u32 = String::from_utf8_lossy(&pid_out.stdout).trim().parse().ok()?;

    let script = format!(
        "import CoreGraphics; \
         let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID)! as! [[String:Any]]; \
         let w = list.first(where: {{ ($0[\"kCGWindowOwnerPID\"] as? Int) == {} && ($0[\"kCGWindowLayer\"] as? Int) == 0 }}); \
         if let id = w?[\"kCGWindowNumber\"] as? Int {{ print(id) }}",
        pid
    );
    let out = Command::new("swift").args(["-e", &script]).output().ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

#[napi]
pub fn take_screenshot(width: Option<u32>, target_app: Option<String>, quality: Option<u32>) -> napi::Result<serde_json::Value> {
    let seq = SHOT_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = format!("/tmp/cu-{}-{}.jpg", std::process::id(), seq);

    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(|e| napi::Error::from_reason(format!("temp file: {e}")))?;

    let mut args: Vec<String> = vec!["-x".into(), "-t".into(), "jpg".into()];

    if let Some(bundle_id) = target_app {
        if let Some(wid) = window_id_for_bundle(&bundle_id) {
            args.push("-l".into());
            args.push(wid.to_string());
        }
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
    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
    Ok(serde_json::json!({ "base64": b64, "width": w, "height": h, "mimeType": "image/jpeg" }))
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
