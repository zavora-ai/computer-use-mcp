use core_graphics::display::CGDisplay;
use napi_derive::napi;

extern "C" {
    fn CGMainDisplayID() -> u32;
    fn CGGetActiveDisplayList(max: u32, displays: *mut u32, count: *mut u32) -> i32;
}

#[napi]
pub fn get_display_size(display_id: Option<u32>) -> napi::Result<serde_json::Value> {
    let did = display_id.unwrap_or_else(|| unsafe { CGMainDisplayID() });
    let display = CGDisplay::new(did);
    let w = display.pixels_wide();
    let h = display.pixels_high();
    let (pw, ph, scale) = match display.display_mode() {
        Some(mode) => {
            let pw = mode.pixel_width();
            let ph = mode.pixel_height();
            (pw, ph, if w > 0 { pw as f64 / w as f64 } else { 1.0 })
        }
        None => (w as u64, h as u64, 1.0),
    };
    Ok(serde_json::json!({
        "width": w, "height": h,
        "pixelWidth": pw, "pixelHeight": ph,
        "scaleFactor": scale,
        "displayId": did,
    }))
}

#[napi]
pub fn list_displays() -> napi::Result<serde_json::Value> {
    let mut displays = [0u32; 16];
    let mut count = 0u32;
    let err = unsafe { CGGetActiveDisplayList(16, displays.as_mut_ptr(), &mut count) };
    if err != 0 {
        return Err(napi::Error::from_reason(format!("CGGetActiveDisplayList error: {err}")));
    }
    let mut result = Vec::new();
    for i in 0..count as usize {
        let did = displays[i];
        let display = CGDisplay::new(did);
        let w = display.pixels_wide();
        let h = display.pixels_high();
        let (pw, ph, scale) = match display.display_mode() {
            Some(mode) => {
                let pw = mode.pixel_width();
                let ph = mode.pixel_height();
                (pw, ph, if w > 0 { pw as f64 / w as f64 } else { 1.0 })
            }
            None => (w as u64, h as u64, 1.0),
        };
        result.push(serde_json::json!({
            "width": w, "height": h,
            "pixelWidth": pw, "pixelHeight": ph,
            "scaleFactor": scale,
            "displayId": did,
        }));
    }
    Ok(serde_json::json!(result))
}
