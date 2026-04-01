use core_graphics::event::{
    CGEvent, CGEventTapLocation, CGEventType, CGMouseButton, EventField,
};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use core_graphics::geometry::CGPoint;
use napi_derive::napi;

fn source() -> CGEventSource {
    CGEventSource::new(CGEventSourceStateID::HIDSystemState).unwrap()
}

fn post(event: CGEvent) {
    event.post(CGEventTapLocation::HID);
}

#[napi]
pub fn mouse_move(x: f64, y: f64) {
    let point = CGPoint::new(x, y);
    let event = CGEvent::new_mouse_event(
        source(), CGEventType::MouseMoved, point, CGMouseButton::Left,
    ).unwrap();
    post(event);
}

#[napi]
pub fn mouse_click(x: f64, y: f64, button: String, count: i32) {
    let point = CGPoint::new(x, y);
    let (btn, down_type, up_type) = match button.as_str() {
        "right" => (CGMouseButton::Right, CGEventType::RightMouseDown, CGEventType::RightMouseUp),
        "middle" => (CGMouseButton::Center, CGEventType::OtherMouseDown, CGEventType::OtherMouseUp),
        _ => (CGMouseButton::Left, CGEventType::LeftMouseDown, CGEventType::LeftMouseUp),
    };

    // Move first
    let move_evt = CGEvent::new_mouse_event(source(), CGEventType::MouseMoved, point, CGMouseButton::Left).unwrap();
    post(move_evt);
    std::thread::sleep(std::time::Duration::from_millis(15));

    for i in 1..=count {
        let down = CGEvent::new_mouse_event(source(), down_type, point, btn).unwrap();
        down.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, i as i64);
        post(down);
        let up = CGEvent::new_mouse_event(source(), up_type, point, btn).unwrap();
        up.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, i as i64);
        post(up);
        if i < count {
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
    }
}

#[napi]
pub fn mouse_button(action: String, x: f64, y: f64) {
    let point = CGPoint::new(x, y);
    let evt_type = if action == "press" { CGEventType::LeftMouseDown } else { CGEventType::LeftMouseUp };
    let event = CGEvent::new_mouse_event(source(), evt_type, point, CGMouseButton::Left).unwrap();
    post(event);
}

#[napi]
pub fn mouse_scroll(dy: i32, dx: i32) {
    // Use raw CGEventCreateScrollWheelEvent via FFI
    extern "C" {
        fn CGEventCreateScrollWheelEvent2(
            source: *const std::ffi::c_void,
            units: u32,
            wheel_count: u32,
            wheel1: i32,
            wheel2: i32,
            wheel3: i32,
        ) -> *mut std::ffi::c_void;
        fn CGEventPost(tap: u32, event: *mut std::ffi::c_void);
    }
    unsafe {
        let event = CGEventCreateScrollWheelEvent2(
            std::ptr::null(), 0, // kCGScrollEventUnitLine = 0
            2, dy, dx, 0,
        );
        if !event.is_null() {
            CGEventPost(0, event); // kCGHIDEventTap = 0
            core_foundation::base::CFRelease(event as *const _);
        }
    }
}

#[napi]
pub fn mouse_drag(x: f64, y: f64) {
    let point = CGPoint::new(x, y);
    let event = CGEvent::new_mouse_event(
        source(), CGEventType::LeftMouseDragged, point, CGMouseButton::Left,
    ).unwrap();
    post(event);
}

#[napi]
pub fn cursor_position() -> napi::Result<serde_json::Value> {
    let event = CGEvent::new(source()).unwrap();
    let loc = event.location();
    Ok(serde_json::json!({ "x": loc.x as i32, "y": loc.y as i32 }))
}
