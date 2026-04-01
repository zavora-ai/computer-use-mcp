use base64::Engine;
use napi_derive::napi;
use std::process::Command;
use std::fs::OpenOptions;

#[napi]
pub fn take_screenshot() -> napi::Result<serde_json::Value> {
    let entropy = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let tmp = format!("/tmp/cu-napi-{}-{}.jpg", std::process::id(), entropy);

    // Create exclusively — prevents symlink attack (fails if path already exists)
    OpenOptions::new().write(true).create_new(true).open(&tmp)
        .map_err(|e| napi::Error::from_reason(format!("temp file: {e}")))?;

    let status = Command::new("screencapture")
        .args(["-x", "-t", "jpg", &tmp])
        .status()
        .map_err(|e| napi::Error::from_reason(format!("screencapture: {e}")))?;

    if !status.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err(napi::Error::from_reason("screencapture failed"));
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
        if data[i] != 0xFF { i += 1; continue; }
        let marker = data[i + 1];
        if marker == 0xC0 || marker == 0xC2 {
            // SOF0 or SOF2: skip marker(2) + length(2) + precision(1), then height(2) + width(2)
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
