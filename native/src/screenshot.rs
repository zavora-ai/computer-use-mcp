// ── Linux implementation ──────────────────────────────────────────────────────
#[cfg(target_os = "linux")]
mod linux {
    use crate::{linux_desktop, linux_tools};
    use base64::Engine;
    use napi_derive::napi;
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::path::Path;

    /// 7.7.0 (K7): the XDG desktop portal's Screenshot, for Wayland sessions where no capture tool works (GNOME 41
    /// and later refuse `gnome-screenshot`'s old D-Bus call from other programs). The reply arrives as a signal on a
    /// request object, so it needs one process holding the bus connection: python3 with GObject introspection, the
    /// same dependency as the AT-SPI bridge. A fixed script; the only argument is the output path.
    const PORTAL_SCRIPT: &str = r#"
import os, shutil, sys, urllib.parse
import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib
out = sys.argv[1]
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
token = 'computer_use_%d' % os.getpid()
sender = bus.get_unique_name()[1:].replace('.', '_')
path = '/org/freedesktop/portal/desktop/request/%s/%s' % (sender, token)
loop = GLib.MainLoop()
result = {}
def on_response(_c, _s, _p, _i, _n, params):
    code, results = params.unpack()
    result['code'] = code
    result['uri'] = results.get('uri')
    loop.quit()
bus.signal_subscribe('org.freedesktop.portal.Desktop', 'org.freedesktop.portal.Request', 'Response', path, None,
                     Gio.DBusSignalFlags.NONE, on_response)
bus.call_sync('org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop', 'org.freedesktop.portal.Screenshot',
              'Screenshot', GLib.Variant('(sa{sv})', ('', {'handle_token': GLib.Variant('s', token),
                                                            'interactive': GLib.Variant('b', False)})),
              GLib.VariantType('(o)'), Gio.DBusCallFlags.NONE, -1, None)
def give_up():
    result['code'] = 'timeout'
    loop.quit()
GLib.timeout_add_seconds(30, give_up)
loop.run()
if result.get('code') == 0 and result.get('uri'):
    shutil.move(urllib.parse.unquote(urllib.parse.urlparse(result['uri']).path), out)
    sys.exit(0)
reasons = {1: 'the screenshot was declined (the portal asks the person the first time)', 'timeout': 'no answer in 30 s'}
sys.stderr.write('portal screenshot failed: %s' % reasons.get(result.get('code'), 'code %s' % result.get('code')))
sys.exit(1)
"#;

    /// Run one capture tool. True when it exited 0 and left a non-empty file; otherwise why not, for the error.
    fn attempt(tool: &str, args: &[&str], path: &Path, tried: &mut Vec<String>) -> bool {
        match linux_tools::run(tool, args) {
            Ok(_) if path.metadata().map(|meta| meta.len() > 0).unwrap_or(false) => true,
            Ok(_) => {
                tried.push(format!("{tool} wrote no image"));
                false
            }
            Err(error) => {
                tried.push(error.reason);
                false
            }
        }
    }

    fn capture_wayland(path: &Path, window_id: Option<u32>, tried: &mut Vec<String>) -> bool {
        let file = path.to_string_lossy();
        // A window on a wlroots compositor: grim cuts its rectangle out of the screen (covered parts show what
        // covers them).
        if let Some(window) = window_id.and_then(|id| linux_desktop::find(id).ok().flatten()) {
            if window.width > 0 && window.height > 0 {
                let geometry = format!("{},{} {}x{}", window.x, window.y, window.width, window.height);
                if attempt("grim", &["-g", &geometry, &file], path, tried) {
                    return true;
                }
            }
        }
        attempt("grim", &[&file], path, tried)
            || attempt("gnome-screenshot", &["-f", &file], path, tried)
            || attempt("python3", &["-c", PORTAL_SCRIPT, &file], path, tried)
    }

    fn capture_x11(path: &Path, window_id: Option<u32>, target_app: &Option<String>, tried: &mut Vec<String>) -> bool {
        let file = path.to_string_lossy();
        if let Some(id) = window_id {
            if attempt("import", &["-window", &id.to_string(), &file], path, tried) {
                return true;
            }
        }
        if target_app.is_some() && attempt("scrot", &["-u", &file], path, tried) {
            return true;
        }
        attempt("scrot", &[&file], path, tried)
            || attempt("gnome-screenshot", &["-f", &file], path, tried)
            || attempt("import", &["-window", "root", &file], path, tried)
    }

    /// 7.7.0 (L3): JPEG at the requested quality (it was always the encoder's default).
    fn encode(image: &image::DynamicImage, quality: u32) -> napi::Result<(Vec<u8>, &'static str)> {
        let mut buf = Vec::new();
        if quality == 0 {
            image
                .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
                .map_err(|e| napi::Error::from_reason(format!("png encode: {e}")))?;
            return Ok((buf, "image/png"));
        }
        let rgb = image.to_rgb8();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality.clamp(1, 100) as u8)
            .encode_image(&rgb)
            .map_err(|e| napi::Error::from_reason(format!("jpeg encode: {e}")))?;
        Ok((buf, "image/jpeg"))
    }

    #[napi]
    pub fn take_screenshot(
        width: Option<u32>,
        target_app: Option<String>,
        quality: Option<u32>,
        previous_hash: Option<String>,
        window_id: Option<u32>,
    ) -> napi::Result<serde_json::Value> {
        // A fresh path in a private directory: a tool handed an existing file (scrot) writes beside it instead.
        let directory = tempfile::Builder::new()
            .prefix("cu-mcp-shot-")
            .tempdir()
            .map_err(|e| napi::Error::from_reason(format!("temp dir: {e}")))?;
        let path = directory.path().join("shot.png");

        let mut tried = Vec::new();
        let captured = if linux_desktop::is_wayland() {
            capture_wayland(&path, window_id, &mut tried)
        } else {
            capture_x11(&path, window_id, &target_app, &mut tried)
        };
        if !captured {
            return Err(napi::Error::from_reason(format!(
                "Screenshot failed. Tried: {}. Install {}.",
                tried.join("; "),
                if linux_desktop::is_wayland() {
                    "grim (sway, Hyprland), or python3-gi for the desktop portal (GNOME, KDE)"
                } else {
                    "scrot or ImageMagick (import)"
                }
            )));
        }

        let raw = std::fs::read(&path).map_err(|e| napi::Error::from_reason(format!("read: {e}")))?;
        let img = image::load_from_memory(&raw).map_err(|e| napi::Error::from_reason(format!("decode: {e}")))?;

        let target_width = width.unwrap_or(1024);
        let resized = if img.width() > target_width {
            img.resize(target_width, u32::MAX, image::imageops::FilterType::Lanczos3)
        } else {
            img
        };

        let (encoded, mime) = encode(&resized, quality.unwrap_or(80))?;

        let mut hasher = DefaultHasher::new();
        encoded.hash(&mut hasher);
        let hash = format!("{:x}", hasher.finish());

        if let Some(prev) = previous_hash {
            if prev == hash {
                return Ok(serde_json::json!({
                    "width": resized.width(),
                    "height": resized.height(),
                    "mimeType": mime,
                    "hash": hash,
                    "unchanged": true,
                }));
            }
        }

        let b64 = base64::engine::general_purpose::STANDARD.encode(&encoded);
        Ok(serde_json::json!({
            "base64": b64,
            "width": resized.width(),
            "height": resized.height(),
            "mimeType": mime,
            "hash": hash,
            "unchanged": false,
        }))
    }

    /// Crop a region from a base64-encoded image at full resolution.
    ///
    /// This was missing on Linux while macOS and Windows had it, so `zoom` failed with
    /// `cropImage is not a function` — a TypeError from JavaScript reaching for an
    /// export that did not exist, which says nothing about which platform or why. The
    /// operation is not platform-specific at all: decode, crop, re-encode. It ended up
    /// duplicated per platform because the encode helpers are, and the Linux block was
    /// simply never given a copy.
    #[napi]
    pub fn crop_image(
        base64_image: String,
        x1: u32,
        y1: u32,
        x2: u32,
        y2: u32,
        quality: Option<u32>,
    ) -> napi::Result<serde_json::Value> {
        let img_bytes = base64::engine::general_purpose::STANDARD
            .decode(&base64_image)
            .map_err(|e| napi::Error::from_reason(format!("base64 decode: {e}")))?;

        let img = image::ImageReader::new(std::io::Cursor::new(&img_bytes))
            .with_guessed_format()
            .map_err(|e| napi::Error::from_reason(format!("image format: {e}")))?
            .decode()
            .map_err(|e| napi::Error::from_reason(format!("image decode: {e}")))?;

        // Clamp into the image rather than failing: a caller asking for a region that
        // runs off the edge wants what is there, and an error would tell it nothing it
        // could act on without a second round trip.
        let iw = img.width();
        let ih = img.height();
        let cx1 = x1.min(iw.saturating_sub(1));
        let cy1 = y1.min(ih.saturating_sub(1));
        let cx2 = x2.min(iw).max(cx1 + 1);
        let cy2 = y2.min(ih).max(cy1 + 1);

        let cropped = img.crop_imm(cx1, cy1, cx2 - cx1, cy2 - cy1);
        let width = cropped.width();
        let height = cropped.height();

        // JPEG has no alpha; `encode` converts to RGB and honours the quality (L3).
        let (buf, mime) = encode(&cropped, quality.unwrap_or(0))?;

        Ok(serde_json::json!({
            "base64": base64::engine::general_purpose::STANDARD.encode(&buf),
            "width": width,
            "height": height,
            "mimeType": mime,
        }))
    }

    /// Fill rectangles of a base64-encoded image with a flat grey and re-encode it. The Linux status card cannot be
    /// excluded from screen capture the way the macOS and Windows cards are, so captures paint over the rectangle it
    /// reports and the agent never sees its own Stop button. `rects` is flat `[x, y, width, height, ...]` in image
    /// pixels, clamped to the image. quality=0 for PNG, 1-100 for JPEG.
    #[napi]
    pub fn mask_image(base64_image: String, rects: Vec<u32>, quality: Option<u32>) -> napi::Result<serde_json::Value> {
        let img_bytes = base64::engine::general_purpose::STANDARD
            .decode(&base64_image)
            .map_err(|e| napi::Error::from_reason(format!("base64 decode: {e}")))?;
        let img = image::ImageReader::new(std::io::Cursor::new(&img_bytes))
            .with_guessed_format()
            .map_err(|e| napi::Error::from_reason(format!("image format: {e}")))?
            .decode()
            .map_err(|e| napi::Error::from_reason(format!("image decode: {e}")))?;
        let mut rgb = img.to_rgb8();
        let (iw, ih) = (rgb.width(), rgb.height());
        for rect in rects.chunks_exact(4) {
            let (x1, y1) = (rect[0].min(iw), rect[1].min(ih));
            let (x2, y2) = (rect[0].saturating_add(rect[2]).min(iw), rect[1].saturating_add(rect[3]).min(ih));
            for y in y1..y2 {
                for x in x1..x2 {
                    rgb.put_pixel(x, y, image::Rgb([128, 128, 128]));
                }
            }
        }
        let (buf, mime) = encode(&image::DynamicImage::ImageRgb8(rgb), quality.unwrap_or(80))?;
        Ok(serde_json::json!({
            "base64": base64::engine::general_purpose::STANDARD.encode(&buf),
            "width": iw,
            "height": ih,
            "mimeType": mime,
        }))
    }
}

// ── macOS implementation ──────────────────────────────────────────────────────
#[cfg(target_os = "macos")]
mod macos {
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
    use std::hash::{Hash, Hasher};
    use std::process::Command;

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

    unsafe fn dict_get_i64(dict: CFDictionaryRef, key: &str) -> Option<i64> {
        let cf_key = CFString::new(key);
        let val = CFDictionaryGetValue(dict, cf_key.as_concrete_TypeRef() as RawCFTypeRef);
        if val.is_null() {
            return None;
        }
        let cf_num: CFNumber = TCFType::wrap_under_get_rule(val as *const _);
        cf_num.to_i64()
    }

    unsafe fn dict_get_raw(dict: CFDictionaryRef, key: &str) -> RawCFTypeRef {
        let cf_key = CFString::new(key);
        CFDictionaryGetValue(dict, cf_key.as_concrete_TypeRef() as RawCFTypeRef)
    }

    unsafe fn dict_get_f64(dict: CFDictionaryRef, key: &str) -> Option<f64> {
        let val = dict_get_raw(dict, key);
        if val.is_null() {
            return None;
        }
        let cf_num: CFNumber = TCFType::wrap_under_get_rule(val as *const _);
        cf_num
            .to_f64()
            .or_else(|| cf_num.to_i64().map(|n| n as f64))
    }

    unsafe fn dict_has_title(dict: CFDictionaryRef) -> bool {
        let val = dict_get_raw(dict, "kCGWindowName");
        if val.is_null() {
            return false;
        }
        let title: CFString =
            TCFType::wrap_under_get_rule(val as core_foundation::string::CFStringRef);
        !title.to_string().trim().is_empty()
    }

    /// Pick the app's main window: the largest titled, layer-0, on-screen window.
    ///
    /// This used to return the first layer-0 window in front-to-back order, which for
    /// the Unreal Editor was a 352x81 notification toast sitting above the editor. Score
    /// by (has a title, area) and let ties go to the earlier, frontmost entry. Window
    /// titles need Screen Recording permission; without it every title is empty and the
    /// choice falls back to the largest window, which is still the main one.
    fn main_window_for_pid(pid: i64) -> Option<u32> {
        unsafe {
            let array_ref = CGWindowListCopyWindowInfo(1 << 0, 0);
            if array_ref.is_null() {
                return None;
            }
            let count = CFArrayGetCount(array_ref) as usize;
            let mut best: Option<((bool, f64), u32)> = None;
            for i in 0..count {
                let dict = CFArrayGetValueAtIndex(array_ref, i as isize) as CFDictionaryRef;
                if dict_get_i64(dict, "kCGWindowLayer") != Some(0) {
                    continue;
                }
                if dict_get_i64(dict, "kCGWindowOwnerPID") != Some(pid) {
                    continue;
                }
                if dict_get_f64(dict, "kCGWindowAlpha").unwrap_or(1.0) <= 0.0 {
                    continue;
                }
                let Some(wid) = dict_get_i64(dict, "kCGWindowNumber") else {
                    continue;
                };
                let bounds = dict_get_raw(dict, "kCGWindowBounds") as CFDictionaryRef;
                let area = if bounds.is_null() {
                    0.0
                } else {
                    dict_get_f64(bounds, "Width").unwrap_or(0.0)
                        * dict_get_f64(bounds, "Height").unwrap_or(0.0)
                };
                let score = (dict_has_title(dict), area);
                // Strictly greater: an equal score keeps the earlier (frontmost) window.
                let better = match &best {
                    None => true,
                    Some((current, _)) => {
                        score.0 && !current.0 || (score.0 == current.0 && score.1 > current.1)
                    }
                };
                if better {
                    best = Some((score, wid as u32));
                }
            }
            CFRelease(array_ref as *const _);
            best.map(|(_, wid)| wid)
        }
    }

    fn window_id_for_bundle(bundle_id: &str) -> Option<u32> {
        main_window_for_pid(pid_for_bundle(bundle_id)? as i64)
    }

    /// Name the reason a capture failed. Without Screen Recording, `screencapture`
    /// exits non-zero and prints nothing, which used to surface as the bare string
    /// "screencapture failed" — nothing an agent or a person could act on.
    pub(crate) fn capture_failure_reason(
        screen_recording_granted: bool,
        code: Option<i32>,
        stderr: &str,
    ) -> String {
        if !screen_recording_granted {
            return "screen_recording_permission_denied: Screen Recording is not granted to this host process, so screencapture produced nothing. Enable your terminal, IDE or agent host in System Settings > Privacy & Security > Screen & System Audio Recording, then restart it.".to_string();
        }
        let detail = stderr.trim();
        match (code, detail.is_empty()) {
            (Some(code), true) => format!("screencapture exited with status {code}"),
            (Some(code), false) => format!("screencapture exited with status {code}: {detail}"),
            (None, true) => "screencapture was terminated by a signal".to_string(),
            (None, false) => format!("screencapture was terminated by a signal: {detail}"),
        }
    }

    #[cfg(test)]
    mod capture_failure_tests {
        use super::capture_failure_reason;

        #[test]
        fn names_the_permission_before_anything_else() {
            let reason = capture_failure_reason(false, Some(1), "");
            assert!(reason.starts_with("screen_recording_permission_denied:"));
            assert!(reason.contains("Screen & System Audio Recording"));
        }

        #[test]
        fn reports_exit_status_and_stderr_when_permitted() {
            assert_eq!(
                capture_failure_reason(true, Some(1), ""),
                "screencapture exited with status 1"
            );
            assert_eq!(
                capture_failure_reason(true, Some(2), "  could not create image from display  \n"),
                "screencapture exited with status 2: could not create image from display"
            );
            assert_eq!(
                capture_failure_reason(true, None, ""),
                "screencapture was terminated by a signal"
            );
        }
    }

    #[napi]
    pub fn take_screenshot(
        width: Option<u32>,
        target_app: Option<String>,
        quality: Option<u32>,
        previous_hash: Option<String>,
        window_id: Option<u32>,
    ) -> napi::Result<serde_json::Value> {
        let temporary = tempfile::Builder::new()
            .prefix("cu-mcp-shot-")
            .suffix(".jpg")
            .tempfile()
            .map_err(|e| napi::Error::from_reason(format!("temp file: {e}")))?;
        let tmp = temporary.path().to_string_lossy().into_owned();

        let mut args: Vec<String> = vec!["-x".into(), "-t".into(), "jpg".into()];
        if let Some(wid) = window_id {
            args.push("-l".into());
            args.push(wid.to_string());
        } else if let Some(bundle_id) = target_app {
            let wid = window_id_for_bundle(&bundle_id).ok_or_else(|| {
                napi::Error::from_reason(format!(
                    "No on-screen window found for target_app: {bundle_id}"
                ))
            })?;
            args.push("-l".into());
            args.push(wid.to_string());
        }
        args.push(tmp.clone());

        // `.output()` rather than `.status()`: the child must not inherit this
        // process's stdio, because on a stdio transport stdout *is* the MCP
        // channel, and anything a child prints there corrupts the JSON-RPC stream.
        let output = Command::new("screencapture")
            .args(&args)
            .output()
            .map_err(|e| napi::Error::from_reason(format!("screencapture: {e}")))?;
        if !output.status.success() {
            return Err(napi::Error::from_reason(capture_failure_reason(
                crate::permissions::screen_capture_granted(),
                output.status.code(),
                &String::from_utf8_lossy(&output.stderr),
            )));
        }

        if let Some(w) = width {
            let _ = Command::new("sips")
                .args(["--resampleWidth", &w.to_string(), &tmp])
                .output();
        }
        let wants_png = quality == Some(0);
        let q = quality.unwrap_or(80).clamp(1, 100);
        if !wants_png && q != 85 {
            let _ = Command::new("sips")
                .args(["--setProperty", "formatOptions", &q.to_string(), &tmp])
                .output();
        }

        let captured =
            std::fs::read(&tmp).map_err(|e| napi::Error::from_reason(format!("read: {e}")))?;

        let (data, mime_type, w, h) = if wants_png {
            use image::ImageReader;
            use std::io::Cursor;
            let img = ImageReader::new(Cursor::new(&captured))
                .with_guessed_format()
                .map_err(|e| napi::Error::from_reason(format!("image format: {e}")))?
                .decode()
                .map_err(|e| napi::Error::from_reason(format!("image decode: {e}")))?;
            let rgb = img.to_rgb8();
            let w = rgb.width();
            let h = rgb.height();
            (encode_png_mac(&rgb.into_raw(), w, h)?, "image/png", w, h)
        } else {
            let (w, h) = jpeg_dimensions(&captured).unwrap_or((0, 0));
            (captured, "image/jpeg", w, h)
        };

        let mut hasher = DefaultHasher::new();
        data.hash(&mut hasher);
        let hash = format!("{:016x}", hasher.finish());

        if previous_hash.as_deref() == Some(hash.as_str()) {
            return Ok(
                serde_json::json!({ "width": w, "height": h, "mimeType": mime_type, "hash": hash, "unchanged": true }),
            );
        }

        let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
        Ok(
            serde_json::json!({ "base64": b64, "width": w, "height": h, "mimeType": mime_type, "hash": hash, "unchanged": false }),
        )
    }

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

    fn encode_png_mac(rgb: &[u8], w: u32, h: u32) -> napi::Result<Vec<u8>> {
        use image::codecs::png::PngEncoder;
        use image::ImageEncoder;
        use std::io::Cursor;
        let estimated = (w * h * 3 / 2) as usize;
        let mut buf = Cursor::new(Vec::with_capacity(estimated));
        let enc = PngEncoder::new(&mut buf);
        enc.write_image(rgb, w, h, image::ExtendedColorType::Rgb8)
            .map_err(|e| napi::Error::from_reason(format!("PNG encode: {e}")))?;
        Ok(buf.into_inner())
    }

    fn encode_jpeg_mac(rgb: &[u8], w: u32, h: u32, quality: u8) -> napi::Result<Vec<u8>> {
        use image::codecs::jpeg::JpegEncoder;
        use std::io::Cursor;
        let estimated = (w * h * 3 / 10) as usize;
        let mut buf = Cursor::new(Vec::with_capacity(estimated));
        let mut enc = JpegEncoder::new_with_quality(&mut buf, quality);
        enc.encode(rgb, w, h, image::ExtendedColorType::Rgb8)
            .map_err(|e| napi::Error::from_reason(format!("JPEG encode: {e}")))?;
        Ok(buf.into_inner())
    }

    /// Draw colored rectangles and grid lines on an image, then re-encode as JPEG.
    #[napi]
    pub fn annotate_image(
        base64_jpeg: String,
        annotations: Option<String>,
        grid_cols: Option<u32>,
        grid_rows: Option<u32>,
        quality: Option<u32>,
    ) -> napi::Result<serde_json::Value> {
        let jpeg_bytes = base64::engine::general_purpose::STANDARD
            .decode(&base64_jpeg)
            .map_err(|e| napi::Error::from_reason(format!("base64 decode: {e}")))?;

        use image::ImageReader;
        use std::io::Cursor;
        let img = ImageReader::new(Cursor::new(&jpeg_bytes))
            .with_guessed_format()
            .map_err(|e| napi::Error::from_reason(format!("image format: {e}")))?
            .decode()
            .map_err(|e| napi::Error::from_reason(format!("image decode: {e}")))?;
        let mut rgb_img = img.to_rgb8();
        let w = rgb_img.width();
        let h = rgb_img.height();

        let colors: [(u8, u8, u8); 8] = [
            (255, 0, 0),
            (0, 255, 0),
            (0, 0, 255),
            (255, 255, 0),
            (255, 0, 255),
            (0, 255, 255),
            (255, 128, 0),
            (128, 0, 255),
        ];

        if let Some(ref ann_json) = annotations {
            if let Ok(anns) = serde_json::from_str::<Vec<serde_json::Value>>(ann_json) {
                for (i, ann) in anns.iter().enumerate() {
                    let ax = ann.get("x").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                    let ay = ann.get("y").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                    let aw = ann.get("width").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                    let ah = ann.get("height").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                    let (cr, cg, cb) = colors[i % colors.len()];
                    let thickness = 2i32;
                    for t in 0..thickness {
                        for x in ax.max(0)..(ax + aw).min(w as i32) {
                            for dy in [ay + t, ay + ah - 1 - t] {
                                if dy >= 0 && dy < h as i32 && x >= 0 && x < w as i32 {
                                    rgb_img.put_pixel(
                                        x as u32,
                                        dy as u32,
                                        image::Rgb([cr, cg, cb]),
                                    );
                                }
                            }
                        }
                        for y in ay.max(0)..(ay + ah).min(h as i32) {
                            for dx in [ax + t, ax + aw - 1 - t] {
                                if dx >= 0 && dx < w as i32 && y >= 0 && y < h as i32 {
                                    rgb_img.put_pixel(
                                        dx as u32,
                                        y as u32,
                                        image::Rgb([cr, cg, cb]),
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }

        if let (Some(cols), Some(rows)) = (grid_cols, grid_rows) {
            let gray = image::Rgb([128u8, 128, 128]);
            if cols > 0 {
                for i in 1..cols {
                    let x = (w as u64 * i as u64 / cols as u64) as u32;
                    if x < w {
                        for y in 0..h {
                            rgb_img.put_pixel(x, y, gray);
                        }
                    }
                }
            }
            if rows > 0 {
                for i in 1..rows {
                    let y = (h as u64 * i as u64 / rows as u64) as u32;
                    if y < h {
                        for x in 0..w {
                            rgb_img.put_pixel(x, y, gray);
                        }
                    }
                }
            }
        }

        let q = quality.unwrap_or(80).clamp(1, 100) as u8;
        let rgb_raw = rgb_img.into_raw();
        let jpeg = encode_jpeg_mac(&rgb_raw, w, h, q)?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&jpeg);

        Ok(serde_json::json!({
            "base64": b64,
            "width": w, "height": h,
            "mimeType": "image/jpeg",
        }))
    }

    /// Crop a region from a base64-encoded image at full resolution.
    #[napi]
    pub fn crop_image(
        base64_image: String,
        x1: u32,
        y1: u32,
        x2: u32,
        y2: u32,
        quality: Option<u32>,
    ) -> napi::Result<serde_json::Value> {
        let img_bytes = base64::engine::general_purpose::STANDARD
            .decode(&base64_image)
            .map_err(|e| napi::Error::from_reason(format!("base64 decode: {e}")))?;

        use image::ImageReader;
        use std::io::Cursor;
        let img = ImageReader::new(Cursor::new(&img_bytes))
            .with_guessed_format()
            .map_err(|e| napi::Error::from_reason(format!("image format: {e}")))?
            .decode()
            .map_err(|e| napi::Error::from_reason(format!("image decode: {e}")))?;

        let iw = img.width();
        let ih = img.height();
        let cx1 = x1.min(iw.saturating_sub(1));
        let cy1 = y1.min(ih.saturating_sub(1));
        let cx2 = x2.min(iw).max(cx1 + 1);
        let cy2 = y2.min(ih).max(cy1 + 1);

        let cropped = img.crop_imm(cx1, cy1, cx2 - cx1, cy2 - cy1);
        let rgb = cropped.to_rgb8();
        let cw = rgb.width();
        let ch = rgb.height();
        let raw = rgb.into_raw();

        let q = quality.unwrap_or(0);
        let (encoded, mime) = if q == 0 {
            (encode_png_mac(&raw, cw, ch)?, "image/png")
        } else {
            (
                encode_jpeg_mac(&raw, cw, ch, q.clamp(1, 100) as u8)?,
                "image/jpeg",
            )
        };

        let b64 = base64::engine::general_purpose::STANDARD.encode(&encoded);
        Ok(serde_json::json!({
            "base64": b64,
            "width": cw, "height": ch,
            "mimeType": mime,
        }))
    }
}

// ── Windows implementation ───────────────────────────────────────────────────
#[cfg(target_os = "windows")]
mod win {
    use base64::Engine;
    use napi_derive::napi;
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use windows::Win32::Graphics::Gdi::HMONITOR;

    /// Resize BGRA pixels using area averaging (box filter) — better quality than
    /// nearest-neighbor and faster for large downscale ratios because it reads
    /// source pixels sequentially. Returns BGRA.
    fn resize_bgra_box(src: &[u8], sw: u32, sh: u32, dw: u32, dh: u32) -> Vec<u8> {
        let mut dst = vec![0u8; (dw * dh * 4) as usize];
        let x_ratio = sw as f64 / dw as f64;
        let y_ratio = sh as f64 / dh as f64;

        for dy in 0..dh {
            let sy_start = (dy as f64 * y_ratio) as u32;
            let sy_end = (((dy + 1) as f64 * y_ratio) as u32).min(sh);
            let y_count = (sy_end - sy_start).max(1) as u32;

            for dx in 0..dw {
                let sx_start = (dx as f64 * x_ratio) as u32;
                let sx_end = (((dx + 1) as f64 * x_ratio) as u32).min(sw);
                let x_count = (sx_end - sx_start).max(1) as u32;
                let area = (x_count * y_count) as u32;

                let mut r_sum = 0u32;
                let mut g_sum = 0u32;
                let mut b_sum = 0u32;

                for sy in sy_start..sy_end {
                    let row_off = (sy * sw * 4) as usize;
                    for sx in sx_start..sx_end {
                        let si = row_off + (sx * 4) as usize;
                        b_sum += src[si] as u32;
                        g_sum += src[si + 1] as u32;
                        r_sum += src[si + 2] as u32;
                    }
                }

                let di = ((dy * dw + dx) * 4) as usize;
                dst[di] = (b_sum / area) as u8;
                dst[di + 1] = (g_sum / area) as u8;
                dst[di + 2] = (r_sum / area) as u8;
                dst[di + 3] = 255;
            }
        }
        dst
    }

    /// Convert BGRA to RGB in a single pass. When no resize is needed, this is
    /// the only conversion step.
    fn bgra_to_rgb(bgra: &[u8], _w: u32, _h: u32) -> Vec<u8> {
        let pixel_count = bgra.len() / 4;
        let mut rgb = Vec::with_capacity(pixel_count * 3);
        // Process 4 pixels at a time for better throughput
        let chunks = bgra.chunks_exact(16); // 4 pixels × 4 bytes
        let remainder = chunks.remainder();
        for chunk in chunks {
            rgb.extend_from_slice(&[chunk[2], chunk[1], chunk[0]]); // pixel 0
            rgb.extend_from_slice(&[chunk[6], chunk[5], chunk[4]]); // pixel 1
            rgb.extend_from_slice(&[chunk[10], chunk[9], chunk[8]]); // pixel 2
            rgb.extend_from_slice(&[chunk[14], chunk[13], chunk[12]]); // pixel 3
        }
        for pixel in remainder.chunks_exact(4) {
            rgb.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
        }
        rgb
    }

    /// Encode RGB pixels as PNG (lossless).
    fn encode_png(rgb: &[u8], w: u32, h: u32) -> napi::Result<Vec<u8>> {
        use image::codecs::png::PngEncoder;
        use image::ImageEncoder;
        use std::io::Cursor;
        let estimated = (w * h * 3 / 2) as usize;
        let mut buf = Cursor::new(Vec::with_capacity(estimated));
        let enc = PngEncoder::new(&mut buf);
        enc.write_image(rgb, w, h, image::ExtendedColorType::Rgb8)
            .map_err(|e| napi::Error::from_reason(format!("PNG encode: {e}")))?;
        Ok(buf.into_inner())
    }

    /// Encode RGB pixels as JPEG using the `image` crate.
    fn encode_jpeg(rgb: &[u8], w: u32, h: u32, quality: u8) -> napi::Result<Vec<u8>> {
        use image::codecs::jpeg::JpegEncoder;
        use std::io::Cursor;
        let estimated = (w * h * 3 / 10) as usize;
        let mut buf = Cursor::new(Vec::with_capacity(estimated));
        let mut enc = JpegEncoder::new_with_quality(&mut buf, quality);
        enc.encode(rgb, w, h, image::ExtendedColorType::Rgb8)
            .map_err(|e| napi::Error::from_reason(format!("JPEG encode: {e}")))?;
        Ok(buf.into_inner())
    }

    /// Capture a window (the ladder in `capture_win`) or a monitor (`display_id`, default the primary), scale it to
    /// `width`, encode it. 7.7.0: the reply names the capture method, whether a screen crop was covered, and the
    /// captured rectangle in screen coordinates, so the image-to-screen mapping never has to be guessed.
    #[napi]
    pub fn take_screenshot(
        width: Option<u32>,
        _target_app: Option<String>,
        quality: Option<u32>,
        previous_hash: Option<String>,
        window_id: Option<u32>,
        display_id: Option<u32>,
    ) -> napi::Result<serde_json::Value> {
        let (frame, method, occluded) = if let Some(wid) = window_id {
            let captured = crate::capture_win::capture_window(wid)?;
            (captured.frame, captured.method, captured.occluded)
        } else {
            let monitor = display_id.map(|id| HMONITOR(id as usize as *mut _));
            (crate::capture_win::capture_monitor(monitor)?, "screen", false)
        };
        let (left, top) = (frame.left, frame.top);
        let (source_w, source_h) = (frame.width, frame.height);
        let (pixels, mut w, mut h) = (frame.bgra, frame.width, frame.height);

        // Optimization: resize on BGRA (4-byte aligned) THEN convert to RGB.
        // Box-filter downscale produces better quality than nearest-neighbor.
        let rgb = if let Some(target_w) = width {
            if target_w < w && target_w > 0 {
                let target_h = (h as u64 * target_w as u64 / w as u64).max(1) as u32;
                let resized = resize_bgra_box(&pixels, w, h, target_w, target_h);
                w = target_w;
                h = target_h;
                bgra_to_rgb(&resized, w, h)
            } else {
                bgra_to_rgb(&pixels, w, h)
            }
        } else {
            bgra_to_rgb(&pixels, w, h)
        };

        // quality=0 means PNG (lossless), quality 1-100 means JPEG
        let q = quality.unwrap_or(80);
        let (encoded, mime_type) = if q == 0 {
            (encode_png(&rgb, w, h)?, "image/png")
        } else {
            (
                encode_jpeg(&rgb, w, h, q.clamp(1, 100) as u8)?,
                "image/jpeg",
            )
        };

        let mut hasher = DefaultHasher::new();
        encoded.hash(&mut hasher);
        let hash = format!("{:016x}", hasher.finish());
        let capture = serde_json::json!({
            "method": method,
            "occluded": occluded,
            "x": left, "y": top, "width": source_w, "height": source_h,
        });

        if previous_hash.as_deref() == Some(hash.as_str()) {
            return Ok(serde_json::json!({
                "width": w, "height": h,
                "mimeType": mime_type,
                "hash": hash,
                "unchanged": true,
                "capture": capture,
            }));
        }

        let b64 = base64::engine::general_purpose::STANDARD.encode(&encoded);
        Ok(serde_json::json!({
            "base64": b64,
            "width": w, "height": h,
            "mimeType": mime_type,
            "hash": hash,
            "unchanged": false,
            "capture": capture,
        }))
    }

    /// Draw colored rectangles and grid lines on an RGB buffer, then JPEG encode.
    /// `annotations` is a JSON array of {x, y, width, height, color_index}.
    /// `grid_cols` and `grid_rows` draw evenly spaced reference lines.
    #[napi]
    pub fn annotate_image(
        base64_jpeg: String,
        annotations: Option<String>,
        grid_cols: Option<u32>,
        grid_rows: Option<u32>,
        quality: Option<u32>,
    ) -> napi::Result<serde_json::Value> {
        // Decode base64 JPEG
        let jpeg_bytes = base64::engine::general_purpose::STANDARD
            .decode(&base64_jpeg)
            .map_err(|e| napi::Error::from_reason(format!("base64 decode: {e}")))?;

        // Decode JPEG to RGB using image crate
        use image::io::Reader as ImageReader;
        use std::io::Cursor;
        let img = ImageReader::new(Cursor::new(&jpeg_bytes))
            .with_guessed_format()
            .map_err(|e| napi::Error::from_reason(format!("image format: {e}")))?
            .decode()
            .map_err(|e| napi::Error::from_reason(format!("image decode: {e}")))?;
        let mut rgb_img = img.to_rgb8();
        let w = rgb_img.width();
        let h = rgb_img.height();

        // Color palette for annotations (matching Windows-MCP style)
        let colors: [(u8, u8, u8); 8] = [
            (255, 0, 0),   // red
            (0, 255, 0),   // green
            (0, 0, 255),   // blue
            (255, 255, 0), // yellow
            (255, 0, 255), // magenta
            (0, 255, 255), // cyan
            (255, 128, 0), // orange
            (128, 0, 255), // purple
        ];

        // Draw annotation rectangles
        if let Some(ref ann_json) = annotations {
            if let Ok(anns) = serde_json::from_str::<Vec<serde_json::Value>>(ann_json) {
                for (i, ann) in anns.iter().enumerate() {
                    let ax = ann.get("x").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                    let ay = ann.get("y").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                    let aw = ann.get("width").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                    let ah = ann.get("height").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                    let (cr, cg, cb) = colors[i % colors.len()];
                    let thickness = 2i32;

                    // Draw rectangle border
                    for t in 0..thickness {
                        // Top and bottom edges
                        for x in ax.max(0)..(ax + aw).min(w as i32) {
                            for dy in [ay + t, ay + ah - 1 - t] {
                                if dy >= 0 && dy < h as i32 && x >= 0 && x < w as i32 {
                                    rgb_img.put_pixel(
                                        x as u32,
                                        dy as u32,
                                        image::Rgb([cr, cg, cb]),
                                    );
                                }
                            }
                        }
                        // Left and right edges
                        for y in ay.max(0)..(ay + ah).min(h as i32) {
                            for dx in [ax + t, ax + aw - 1 - t] {
                                if dx >= 0 && dx < w as i32 && y >= 0 && y < h as i32 {
                                    rgb_img.put_pixel(
                                        dx as u32,
                                        y as u32,
                                        image::Rgb([cr, cg, cb]),
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }

        // Draw grid lines
        if let (Some(cols), Some(rows)) = (grid_cols, grid_rows) {
            let gray = image::Rgb([128u8, 128, 128]);
            if cols > 0 {
                for i in 1..cols {
                    let x = (w as u64 * i as u64 / cols as u64) as u32;
                    if x < w {
                        for y in 0..h {
                            rgb_img.put_pixel(x, y, gray);
                        }
                    }
                }
            }
            if rows > 0 {
                for i in 1..rows {
                    let y = (h as u64 * i as u64 / rows as u64) as u32;
                    if y < h {
                        for x in 0..w {
                            rgb_img.put_pixel(x, y, gray);
                        }
                    }
                }
            }
        }

        // Re-encode as JPEG
        let q = quality.unwrap_or(80).clamp(1, 100) as u8;
        let rgb_raw = rgb_img.into_raw();
        let jpeg = encode_jpeg(&rgb_raw, w, h, q)?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&jpeg);

        Ok(serde_json::json!({
            "base64": b64,
            "width": w, "height": h,
            "mimeType": "image/jpeg",
        }))
    }

    /// Crop a region from a base64-encoded image and return at full resolution.
    /// quality=0 for PNG, 1-100 for JPEG.
    #[napi]
    pub fn crop_image(
        base64_image: String,
        x1: u32,
        y1: u32,
        x2: u32,
        y2: u32,
        quality: Option<u32>,
    ) -> napi::Result<serde_json::Value> {
        let img_bytes = base64::engine::general_purpose::STANDARD
            .decode(&base64_image)
            .map_err(|e| napi::Error::from_reason(format!("base64 decode: {e}")))?;

        use image::io::Reader as ImageReader;
        use std::io::Cursor;
        let img = ImageReader::new(Cursor::new(&img_bytes))
            .with_guessed_format()
            .map_err(|e| napi::Error::from_reason(format!("image format: {e}")))?
            .decode()
            .map_err(|e| napi::Error::from_reason(format!("image decode: {e}")))?;

        let iw = img.width();
        let ih = img.height();
        let cx1 = x1.min(iw.saturating_sub(1));
        let cy1 = y1.min(ih.saturating_sub(1));
        let cx2 = x2.min(iw).max(cx1 + 1);
        let cy2 = y2.min(ih).max(cy1 + 1);

        let cropped = img.crop_imm(cx1, cy1, cx2 - cx1, cy2 - cy1);
        let rgb = cropped.to_rgb8();
        let cw = rgb.width();
        let ch = rgb.height();
        let raw = rgb.into_raw();

        let q = quality.unwrap_or(0);
        let (encoded, mime) = if q == 0 {
            (encode_png(&raw, cw, ch)?, "image/png")
        } else {
            (
                encode_jpeg(&raw, cw, ch, q.clamp(1, 100) as u8)?,
                "image/jpeg",
            )
        };

        let b64 = base64::engine::general_purpose::STANDARD.encode(&encoded);
        Ok(serde_json::json!({
            "base64": b64,
            "width": cw, "height": ch,
            "mimeType": mime,
        }))
    }
}

/// 7.7.0 (K4): `take_screenshot` on a worker thread. A capture with its encode takes tens to hundreds of milliseconds;
/// the JavaScript thread is not held for it. `display_id` is used on Windows only, as in the synchronous call.
#[napi_derive::napi]
pub fn take_screenshot_async(
    width: Option<u32>,
    target_app: Option<String>,
    quality: Option<u32>,
    previous_hash: Option<String>,
    window_id: Option<u32>,
    display_id: Option<u32>,
) -> napi::bindgen_prelude::AsyncTask<crate::async_task::JsonTask> {
    crate::async_task::spawn(move || {
        #[cfg(target_os = "windows")]
        {
            win::take_screenshot(width, target_app, quality, previous_hash, window_id, display_id)
        }
        #[cfg(target_os = "macos")]
        {
            let _ = display_id;
            macos::take_screenshot(width, target_app, quality, previous_hash, window_id)
        }
        #[cfg(target_os = "linux")]
        {
            let _ = display_id;
            linux::take_screenshot(width, target_app, quality, previous_hash, window_id)
        }
    })
}
