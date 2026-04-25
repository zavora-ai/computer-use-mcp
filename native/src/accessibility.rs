//! Accessibility-based UI automation primitives.
//!
//! Exposes AX tree traversal, element search, and semantic actions on top
//! of the AXUIElement APIs. Shares the CG→AX window resolution logic with
//! `windows.rs` — extended here to walk the tree and mutate elements.
//!
//! All permissions errors (`kAXErrorNotAuthorized`, `kAXErrorAPIDisabled`)
//! surface as a single structured NAPI error so the session layer can
//! render a consistent remediation hint.

use core_foundation::array::CFArrayRef;
use core_foundation::base::{CFRelease, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionaryRef;
use core_foundation::number::CFNumber;
use core_foundation::string::{CFString, CFStringRef};
use napi_derive::napi;
use objc::runtime::{Class, Object};
use objc::{msg_send, sel, sel_impl};
use std::ffi::CStr;

// ---------------------------------------------------------------------------
// CoreGraphics FFI (duplicated from windows.rs for CG→AX resolution)
// ---------------------------------------------------------------------------

type CGWindowID = u32;
const K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY: u32 = 1 << 0;
const K_CG_NULL_WINDOW_ID: CGWindowID = 0;

extern "C" {
    fn CGWindowListCopyWindowInfo(option: u32, relativeToWindow: CGWindowID) -> CFArrayRef;
    fn CFArrayGetCount(array: CFArrayRef) -> isize;
    fn CFArrayGetValueAtIndex(array: CFArrayRef, idx: isize) -> RawCFTypeRef;
    fn CFDictionaryGetValue(dict: CFDictionaryRef, key: RawCFTypeRef) -> RawCFTypeRef;
}

// ---------------------------------------------------------------------------
// AXUIElement FFI
// ---------------------------------------------------------------------------

type AXUIElementRef = *mut std::ffi::c_void;
type AXError = i32;
type RawCFTypeRef = *const std::ffi::c_void;

const K_AX_ERROR_SUCCESS: AXError = 0;
const K_AX_ERROR_NOT_AUTHORIZED: AXError = -25211;
const K_AX_ERROR_API_DISABLED: AXError = -25212;
const K_AX_ERROR_ATTRIBUTE_UNSUPPORTED: AXError = -25205;
const K_AX_ERROR_ACTION_UNSUPPORTED: AXError = -25206;

extern "C" {
    fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut RawCFTypeRef,
    ) -> AXError;
    fn AXUIElementCopyActionNames(
        element: AXUIElementRef,
        names: *mut CFArrayRef,
    ) -> AXError;
    fn AXUIElementPerformAction(element: AXUIElementRef, action: CFStringRef) -> AXError;
    fn AXUIElementSetAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: RawCFTypeRef,
    ) -> AXError;
    fn AXUIElementIsAttributeSettable(
        element: AXUIElementRef,
        attribute: CFStringRef,
        settable: *mut bool,
    ) -> AXError;
    fn AXValueGetValue(
        value: RawCFTypeRef,
        value_type: u32,
        value_ptr: *mut std::ffi::c_void,
    ) -> bool;

    // CoreFoundation type introspection
    fn CFGetTypeID(cf: RawCFTypeRef) -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFNumberGetTypeID() -> usize;
    fn CFBooleanGetTypeID() -> usize;
    fn CFCopyDescription(cf: RawCFTypeRef) -> CFStringRef;
}

// AX value type tags
const K_AX_VALUE_CG_POINT_TYPE: u32 = 1;
const K_AX_VALUE_CG_SIZE_TYPE: u32 = 2;

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

fn ax_error_to_reason(err: AXError) -> String {
    match err {
        K_AX_ERROR_NOT_AUTHORIZED | K_AX_ERROR_API_DISABLED => {
            "accessibility_permission_denied: Grant Accessibility permission in System Settings > Privacy & Security > Accessibility".to_string()
        }
        _ => format!("ax_error:{err}"),
    }
}

fn is_permission_error(err: AXError) -> bool {
    err == K_AX_ERROR_NOT_AUTHORIZED || err == K_AX_ERROR_API_DISABLED
}

// ---------------------------------------------------------------------------
// NSRunningApplication helpers
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

fn pid_for_bundle(bundle_id: &str) -> Option<i32> {
    unsafe {
        let cls = Class::get("NSWorkspace").unwrap();
        let ws: *mut Object = msg_send![cls, sharedWorkspace];
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
        None
    }
}

// ---------------------------------------------------------------------------
// CFDictionary helpers (duplicated intentionally — windows.rs versions are
// file-local). Tiny and stable.
// ---------------------------------------------------------------------------

unsafe fn dict_raw_get(dict: CFDictionaryRef, key: &str) -> Option<RawCFTypeRef> {
    let cf_key = CFString::new(key);
    let val = CFDictionaryGetValue(dict, cf_key.as_concrete_TypeRef() as RawCFTypeRef);
    if val.is_null() {
        None
    } else {
        Some(val)
    }
}

fn dict_get_i64(dict: CFDictionaryRef, key: &str) -> Option<i64> {
    unsafe {
        let val = dict_raw_get(dict, key)?;
        let cf_num: CFNumber = TCFType::wrap_under_get_rule(val as *const _);
        cf_num.to_i64()
    }
}

fn dict_get_f64(dict: CFDictionaryRef, key: &str) -> Option<f64> {
    unsafe {
        let val = dict_raw_get(dict, key)?;
        let cf_num: CFNumber = TCFType::wrap_under_get_rule(val as *const _);
        cf_num.to_f64().or_else(|| cf_num.to_i64().map(|n| n as f64))
    }
}

fn dict_get_string(dict: CFDictionaryRef, key: &str) -> Option<String> {
    unsafe {
        let val = dict_raw_get(dict, key)?;
        let cf_str: CFString = TCFType::wrap_under_get_rule(val as CFStringRef);
        Some(cf_str.to_string())
    }
}

fn dict_get_dict(dict: CFDictionaryRef, key: &str) -> Option<CFDictionaryRef> {
    unsafe {
        let val = dict_raw_get(dict, key)?;
        Some(val as CFDictionaryRef)
    }
}

// ---------------------------------------------------------------------------
// AX attribute readers
// ---------------------------------------------------------------------------

/// Copy a string attribute; returns `None` if missing / not a CFString.
fn ax_copy_string(elem: AXUIElementRef, attr: &str) -> Option<String> {
    let key = CFString::new(attr);
    let mut val: RawCFTypeRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyAttributeValue(elem, key.as_concrete_TypeRef(), &mut val) };
    if err != K_AX_ERROR_SUCCESS || val.is_null() {
        return None;
    }
    let tid = unsafe { CFGetTypeID(val) };
    if tid != unsafe { CFStringGetTypeID() } {
        unsafe { CFRelease(val) };
        return None;
    }
    unsafe {
        let s: CFString = TCFType::wrap_under_create_rule(val as CFStringRef);
        Some(s.to_string())
    }
}

/// Copy an AXValue attribute and render a representative string.
/// Handles CFString (text fields, titles), CFNumber (sliders, counts),
/// CFBoolean (checkboxes), and AXValue-wrapped structs (points/sizes).
/// Returns `None` when the attribute is missing or unrenderable.
fn ax_copy_value_as_string(elem: AXUIElementRef, attr: &str) -> Option<String> {
    let key = CFString::new(attr);
    let mut val: RawCFTypeRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyAttributeValue(elem, key.as_concrete_TypeRef(), &mut val) };
    if err != K_AX_ERROR_SUCCESS || val.is_null() {
        return None;
    }

    let tid = unsafe { CFGetTypeID(val) };

    if tid == unsafe { CFStringGetTypeID() } {
        let s: CFString = unsafe { TCFType::wrap_under_create_rule(val as CFStringRef) };
        return Some(s.to_string());
    }

    if tid == unsafe { CFNumberGetTypeID() } {
        let n: CFNumber = unsafe { TCFType::wrap_under_create_rule(val as *const _) };
        if let Some(f) = n.to_f64() {
            // Format integer-looking numbers without trailing ".0".
            if f.fract() == 0.0 && f.is_finite() {
                return Some(format!("{}", f as i64));
            }
            return Some(format!("{f}"));
        }
        return None;
    }

    if tid == unsafe { CFBooleanGetTypeID() } {
        extern "C" {
            fn CFBooleanGetValue(b: RawCFTypeRef) -> u8;
        }
        let b = unsafe { CFBooleanGetValue(val) != 0 };
        unsafe { CFRelease(val) };
        return Some(if b { "true".into() } else { "false".into() });
    }

    // Fallback: use CFCopyDescription for anything else (AXValueRef, CFArray, ...).
    let desc = unsafe { CFCopyDescription(val) };
    unsafe { CFRelease(val) };
    if desc.is_null() {
        return None;
    }
    let d: CFString = unsafe { TCFType::wrap_under_create_rule(desc) };
    Some(d.to_string())
}

/// Copy an AXValue-wrapped CGPoint (AXPosition).
fn ax_copy_point(elem: AXUIElementRef) -> Option<(f64, f64)> {
    let key = CFString::new("AXPosition");
    let mut val: RawCFTypeRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyAttributeValue(elem, key.as_concrete_TypeRef(), &mut val) };
    if err != K_AX_ERROR_SUCCESS || val.is_null() {
        return None;
    }
    let mut point = core_graphics::geometry::CGPoint::new(0.0, 0.0);
    let got = unsafe {
        AXValueGetValue(
            val,
            K_AX_VALUE_CG_POINT_TYPE,
            &mut point as *mut _ as *mut std::ffi::c_void,
        )
    };
    unsafe { CFRelease(val) };
    if got {
        Some((point.x, point.y))
    } else {
        None
    }
}

/// Copy an AXValue-wrapped CGSize (AXSize).
fn ax_copy_size(elem: AXUIElementRef) -> Option<(f64, f64)> {
    let key = CFString::new("AXSize");
    let mut val: RawCFTypeRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyAttributeValue(elem, key.as_concrete_TypeRef(), &mut val) };
    if err != K_AX_ERROR_SUCCESS || val.is_null() {
        return None;
    }
    let mut size = core_graphics::geometry::CGSize::new(0.0, 0.0);
    let got = unsafe {
        AXValueGetValue(
            val,
            K_AX_VALUE_CG_SIZE_TYPE,
            &mut size as *mut _ as *mut std::ffi::c_void,
        )
    };
    unsafe { CFRelease(val) };
    if got {
        Some((size.width, size.height))
    } else {
        None
    }
}

/// Copy a bool attribute (AXEnabled, AXMain, etc.).
fn ax_copy_bool(elem: AXUIElementRef, attr: &str) -> Option<bool> {
    let key = CFString::new(attr);
    let mut val: RawCFTypeRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyAttributeValue(elem, key.as_concrete_TypeRef(), &mut val) };
    if err != K_AX_ERROR_SUCCESS || val.is_null() {
        return None;
    }
    let b = unsafe {
        extern "C" {
            fn CFBooleanGetValue(b: RawCFTypeRef) -> u8;
        }
        CFBooleanGetValue(val) != 0
    };
    unsafe { CFRelease(val) };
    Some(b)
}

/// Copy the `AXChildren` array — returns raw AXUIElementRef pointers.
/// Caller must release the array when done via `CFRelease` on the returned ref.
fn ax_copy_children(elem: AXUIElementRef) -> Option<(RawCFTypeRef, Vec<AXUIElementRef>)> {
    let key = CFString::new("AXChildren");
    let mut val: RawCFTypeRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyAttributeValue(elem, key.as_concrete_TypeRef(), &mut val) };
    if err != K_AX_ERROR_SUCCESS || val.is_null() {
        return None;
    }
    let arr = val as CFArrayRef;
    let count = unsafe { CFArrayGetCount(arr) };
    let mut out = Vec::with_capacity(count as usize);
    for i in 0..count {
        let child = unsafe { CFArrayGetValueAtIndex(arr, i) } as AXUIElementRef;
        if !child.is_null() {
            out.push(child);
        }
    }
    Some((val, out))
}

/// Copy the actions-names array for an element.
fn ax_copy_actions(elem: AXUIElementRef) -> Vec<String> {
    let mut arr: CFArrayRef = std::ptr::null_mut();
    let err = unsafe { AXUIElementCopyActionNames(elem, &mut arr) };
    if err != K_AX_ERROR_SUCCESS || arr.is_null() {
        return Vec::new();
    }
    let count = unsafe { CFArrayGetCount(arr) };
    let mut out = Vec::with_capacity(count as usize);
    for i in 0..count {
        let s_ref = unsafe { CFArrayGetValueAtIndex(arr, i) } as CFStringRef;
        if s_ref.is_null() {
            continue;
        }
        let s: CFString = unsafe { TCFType::wrap_under_get_rule(s_ref) };
        out.push(s.to_string());
    }
    unsafe { CFRelease(arr as *const _) };
    out
}

// ---------------------------------------------------------------------------
// CG window → AX window resolver
// ---------------------------------------------------------------------------

/// Match an on-screen `CGWindowID` to its `AXUIElement` counterpart.
///
/// Returns the AX app element and the matched AX window element. Both refs
/// are `create`-owned (caller must `CFRelease`).
fn ax_app_and_window_for_cg_window(
    window_id: u32,
) -> napi::Result<Option<(AXUIElementRef, AXUIElementRef)>> {
    // Step 1: look up PID, title, bounds via CG.
    let (pid, title, bounds) = {
        let array_ref = unsafe {
            CGWindowListCopyWindowInfo(
                K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY,
                K_CG_NULL_WINDOW_ID,
            )
        };
        if array_ref.is_null() {
            return Err(napi::Error::from_reason("CGWindowListCopyWindowInfo returned null"));
        }
        let count = unsafe { CFArrayGetCount(array_ref) } as usize;

        let mut pid: Option<i32> = None;
        let mut title: Option<String> = None;
        let mut bounds: Option<(f64, f64, f64, f64)> = None;

        for i in 0..count {
            let dict = unsafe { CFArrayGetValueAtIndex(array_ref, i as isize) } as CFDictionaryRef;
            if dict_get_i64(dict, "kCGWindowNumber") == Some(window_id as i64) {
                pid = dict_get_i64(dict, "kCGWindowOwnerPID").map(|v| v as i32);
                title = dict_get_string(dict, "kCGWindowName");
                if let Some(b) = dict_get_dict(dict, "kCGWindowBounds") {
                    let x = dict_get_f64(b, "X").unwrap_or(0.0);
                    let y = dict_get_f64(b, "Y").unwrap_or(0.0);
                    let w = dict_get_f64(b, "Width").unwrap_or(0.0);
                    let h = dict_get_f64(b, "Height").unwrap_or(0.0);
                    bounds = Some((x, y, w, h));
                }
                break;
            }
        }
        unsafe { CFRelease(array_ref as *const _) };

        match pid {
            Some(p) => (p, title, bounds),
            None => return Ok(None),
        }
    };

    // Step 2: AXApp + enumerate AXWindows.
    let ax_app = unsafe { AXUIElementCreateApplication(pid) };
    if ax_app.is_null() {
        return Ok(None);
    }

    let windows_key = CFString::new("AXWindows");
    let mut windows_val: RawCFTypeRef = std::ptr::null();
    let err = unsafe {
        AXUIElementCopyAttributeValue(ax_app, windows_key.as_concrete_TypeRef(), &mut windows_val)
    };
    if err != K_AX_ERROR_SUCCESS || windows_val.is_null() {
        unsafe { CFRelease(ax_app as *const _) };
        if is_permission_error(err) {
            return Err(napi::Error::from_reason(ax_error_to_reason(err)));
        }
        return Ok(None);
    }

    let arr = windows_val as CFArrayRef;
    let count = unsafe { CFArrayGetCount(arr) } as usize;

    let mut matched: Option<AXUIElementRef> = None;
    for i in 0..count {
        let w = unsafe { CFArrayGetValueAtIndex(arr, i as isize) } as AXUIElementRef;
        if w.is_null() {
            continue;
        }

        // Prefer title match
        if let Some(ref t) = title {
            if let Some(ax_t) = ax_copy_string(w, "AXTitle") {
                if ax_t == *t {
                    matched = Some(w);
                    break;
                }
            }
        }

        // Fall back to bounds match
        if matched.is_none() {
            if let Some((ex, ey, ew, eh)) = bounds {
                let pos = ax_copy_point(w);
                let size = ax_copy_size(w);
                if let (Some((x, y)), Some((w2, h2))) = (pos, size) {
                    if (x - ex).abs() < 2.0
                        && (y - ey).abs() < 2.0
                        && (w2 - ew).abs() < 2.0
                        && (h2 - eh).abs() < 2.0
                    {
                        matched = Some(w);
                        break;
                    }
                }
            }
        }
    }

    // Fallback: if exactly one AXWindow exists, use it.
    if matched.is_none() && count == 1 {
        let only = unsafe { CFArrayGetValueAtIndex(arr, 0) } as AXUIElementRef;
        if !only.is_null() {
            matched = Some(only);
        }
    }

    // AXChildren is wrap_under_get_rule above, but the *array* itself was
    // allocated via Copy — we need to CFRetain the chosen element before
    // releasing the array.
    let retained = matched.map(|w| unsafe {
        extern "C" {
            fn CFRetain(r: RawCFTypeRef) -> RawCFTypeRef;
        }
        CFRetain(w as RawCFTypeRef) as AXUIElementRef
    });

    unsafe { CFRelease(windows_val) };

    match retained {
        Some(w) => Ok(Some((ax_app, w))),
        None => {
            unsafe { CFRelease(ax_app as *const _) };
            Ok(None)
        }
    }
}

// ---------------------------------------------------------------------------
// Tree walker
// ---------------------------------------------------------------------------

const DEFAULT_MAX_DEPTH: i32 = 10;
const MAX_MAX_DEPTH: i32 = 20;
const NODE_LIMIT: usize = 500;
const VALUE_TRUNCATE_LEN: usize = 500;

struct WalkState {
    node_count: usize,
    truncated_at_cap: bool,
}

fn node_value_of(elem: AXUIElementRef) -> Option<String> {
    let s = ax_copy_value_as_string(elem, "AXValue")?;
    if s.len() > VALUE_TRUNCATE_LEN {
        // Truncate on a char boundary to avoid panics on multi-byte characters.
        let mut end = VALUE_TRUNCATE_LEN;
        while !s.is_char_boundary(end) && end > 0 {
            end -= 1;
        }
        Some(format!("{}…", &s[..end]))
    } else {
        Some(s)
    }
}

fn build_node(
    elem: AXUIElementRef,
    depth: i32,
    max_depth: i32,
    state: &mut WalkState,
) -> serde_json::Value {
    if state.node_count >= NODE_LIMIT {
        state.truncated_at_cap = true;
        return serde_json::json!({ "truncated": true });
    }
    state.node_count += 1;

    let role = ax_copy_string(elem, "AXRole").unwrap_or_else(|| "AXUnknown".into());
    let label = ax_copy_string(elem, "AXTitle")
        .or_else(|| ax_copy_string(elem, "AXDescription"));
    let value = node_value_of(elem);

    let (x, y) = ax_copy_point(elem).unwrap_or((0.0, 0.0));
    let (w, h) = ax_copy_size(elem).unwrap_or((0.0, 0.0));
    let actions = ax_copy_actions(elem);

    // Recurse into children, applying pruning rules.
    let mut children_json: Vec<serde_json::Value> = Vec::new();
    let mut hit_depth_cap = false;

    if depth < max_depth {
        if let Some((arr_ref, kids)) = ax_copy_children(elem) {
            // Pruning: skip unknown-role subtrees.
            if role == "AXUnknown" {
                // Discard children entirely.
            } else {
                for child in &kids {
                    if state.node_count >= NODE_LIMIT {
                        state.truncated_at_cap = true;
                        break;
                    }
                    let node = build_node(*child, depth + 1, max_depth, state);
                    children_json.push(node);
                }
            }
            unsafe { CFRelease(arr_ref) };
        }
    } else if ax_copy_children(elem).map(|(r, kids)| {
        let had = !kids.is_empty();
        unsafe { CFRelease(r) };
        had
    }).unwrap_or(false) {
        hit_depth_cap = true;
    }

    // Pruning: collapse an unlabeled single-child AXGroup.
    if role == "AXGroup" && label.is_none() && children_json.len() == 1 {
        return children_json.into_iter().next().unwrap();
    }

    let mut node = serde_json::json!({
        "role": role,
        "label": label,
        "value": value,
        "bounds": { "x": x, "y": y, "width": w, "height": h },
        "actions": actions,
        "children": children_json,
    });

    if hit_depth_cap {
        node["truncated"] = serde_json::Value::Bool(true);
    }

    node
}

// ---------------------------------------------------------------------------
// Flat finder
// ---------------------------------------------------------------------------

fn label_matches(actual: Option<&str>, expected: &str) -> bool {
    // Exact match first (case-insensitive), then substring.
    // Empty expected string matches null label and empty label.
    if expected.is_empty() {
        return actual.map(|s| s.is_empty()).unwrap_or(true);
    }
    let Some(a) = actual else { return false };
    let al = a.to_lowercase();
    let el = expected.to_lowercase();
    al == el || al.contains(&el)
}

fn value_matches(actual: Option<&str>, expected: &str) -> bool {
    if expected.is_empty() {
        return actual.map(|s| s.is_empty()).unwrap_or(true);
    }
    let Some(a) = actual else { return false };
    a.to_lowercase().contains(&expected.to_lowercase())
}

fn find_visit(
    elem: AXUIElementRef,
    role: Option<&str>,
    label: Option<&str>,
    value: Option<&str>,
    max_results: usize,
    path: &mut Vec<usize>,
    out: &mut Vec<serde_json::Value>,
    depth: i32,
) {
    if out.len() >= max_results {
        return;
    }
    let actual_role = ax_copy_string(elem, "AXRole").unwrap_or_else(|| "AXUnknown".into());
    let actual_label = ax_copy_string(elem, "AXTitle")
        .or_else(|| ax_copy_string(elem, "AXDescription"));
    let actual_value = node_value_of(elem);

    let role_ok = role.map(|r| r.eq_ignore_ascii_case(&actual_role)).unwrap_or(true);
    let label_ok = label.map(|l| label_matches(actual_label.as_deref(), l)).unwrap_or(true);
    let value_ok = value.map(|v| value_matches(actual_value.as_deref(), v)).unwrap_or(true);

    if role_ok && label_ok && value_ok {
        let (x, y) = ax_copy_point(elem).unwrap_or((0.0, 0.0));
        let (w, h) = ax_copy_size(elem).unwrap_or((0.0, 0.0));
        let actions = ax_copy_actions(elem);
        out.push(serde_json::json!({
            "role": actual_role,
            "label": actual_label,
            "value": actual_value,
            "bounds": { "x": x, "y": y, "width": w, "height": h },
            "actions": actions,
            "path": path.clone(),
        }));
    }

    if out.len() >= max_results || depth >= MAX_MAX_DEPTH {
        return;
    }

    // Always descend (we want to find anywhere in the subtree).
    if let Some((arr_ref, kids)) = ax_copy_children(elem) {
        for (i, c) in kids.iter().enumerate() {
            if out.len() >= max_results {
                break;
            }
            path.push(i);
            find_visit(*c, role, label, value, max_results, path, out, depth + 1);
            path.pop();
        }
        unsafe { CFRelease(arr_ref) };
    }
}

// ---------------------------------------------------------------------------
// First-match visitor (used by perform_action / set_element_value)
// ---------------------------------------------------------------------------

fn first_match_visit(
    elem: AXUIElementRef,
    role: &str,
    label: &str,
    depth: i32,
    hits: &mut Vec<AXUIElementRef>,
) {
    if !hits.is_empty() {
        return;
    }
    let actual_role = ax_copy_string(elem, "AXRole").unwrap_or_else(|| "AXUnknown".into());
    let actual_label = ax_copy_string(elem, "AXTitle")
        .or_else(|| ax_copy_string(elem, "AXDescription"));

    let role_ok = role.eq_ignore_ascii_case(&actual_role);
    let label_ok = label_matches(actual_label.as_deref(), label);

    if role_ok && label_ok {
        extern "C" {
            fn CFRetain(r: RawCFTypeRef) -> RawCFTypeRef;
        }
        let retained = unsafe { CFRetain(elem as RawCFTypeRef) } as AXUIElementRef;
        hits.push(retained);
        return;
    }

    if depth >= MAX_MAX_DEPTH {
        return;
    }
    if let Some((arr_ref, kids)) = ax_copy_children(elem) {
        for c in kids.iter() {
            first_match_visit(*c, role, label, depth + 1, hits);
            if !hits.is_empty() {
                break;
            }
        }
        unsafe { CFRelease(arr_ref) };
    }
}

// ---------------------------------------------------------------------------
// Public NAPI functions
// ---------------------------------------------------------------------------

/// Return a depth-limited JSON tree of the window's AX hierarchy.
#[napi]
pub fn get_ui_tree(window_id: u32, max_depth: Option<i32>) -> napi::Result<serde_json::Value> {
    let max_depth = max_depth.unwrap_or(DEFAULT_MAX_DEPTH).clamp(1, MAX_MAX_DEPTH);

    let Some((ax_app, ax_win)) = ax_app_and_window_for_cg_window(window_id)? else {
        return Err(napi::Error::from_reason(format!("window_not_found:{window_id}")));
    };

    let mut state = WalkState {
        node_count: 0,
        truncated_at_cap: false,
    };
    let mut node = build_node(ax_win, 0, max_depth, &mut state);

    if state.truncated_at_cap {
        node["truncated"] = serde_json::Value::Bool(true);
    }

    unsafe {
        CFRelease(ax_win as *const _);
        CFRelease(ax_app as *const _);
    }

    Ok(node)
}

/// Return the currently focused AX element or null.
#[napi]
pub fn get_focused_element() -> napi::Result<serde_json::Value> {
    let sys = unsafe { AXUIElementCreateSystemWide() };
    if sys.is_null() {
        return Ok(serde_json::Value::Null);
    }

    let key = CFString::new("AXFocusedUIElement");
    let mut val: RawCFTypeRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyAttributeValue(sys, key.as_concrete_TypeRef(), &mut val) };
    unsafe { CFRelease(sys as *const _) };
    if is_permission_error(err) {
        return Err(napi::Error::from_reason(ax_error_to_reason(err)));
    }
    if err != K_AX_ERROR_SUCCESS || val.is_null() {
        return Ok(serde_json::Value::Null);
    }

    let elem = val as AXUIElementRef;
    let role = ax_copy_string(elem, "AXRole").unwrap_or_else(|| "AXUnknown".into());
    let label = ax_copy_string(elem, "AXTitle")
        .or_else(|| ax_copy_string(elem, "AXDescription"));
    let value = node_value_of(elem);
    let (x, y) = ax_copy_point(elem).unwrap_or((0.0, 0.0));
    let (w, h) = ax_copy_size(elem).unwrap_or((0.0, 0.0));
    let actions = ax_copy_actions(elem);

    unsafe { CFRelease(val) };

    Ok(serde_json::json!({
        "role": role,
        "label": label,
        "value": value,
        "bounds": { "x": x, "y": y, "width": w, "height": h },
        "actions": actions,
    }))
}

/// Depth-first search within a window.
#[napi]
pub fn find_element(
    window_id: u32,
    role: Option<String>,
    label: Option<String>,
    value: Option<String>,
    max_results: Option<i32>,
) -> napi::Result<serde_json::Value> {
    let max_results = max_results.unwrap_or(25).clamp(1, 100) as usize;

    let Some((ax_app, ax_win)) = ax_app_and_window_for_cg_window(window_id)? else {
        return Err(napi::Error::from_reason(format!("window_not_found:{window_id}")));
    };

    let mut out: Vec<serde_json::Value> = Vec::new();
    let mut path: Vec<usize> = Vec::new();
    find_visit(
        ax_win,
        role.as_deref(),
        label.as_deref(),
        value.as_deref(),
        max_results,
        &mut path,
        &mut out,
        0,
    );

    unsafe {
        CFRelease(ax_win as *const _);
        CFRelease(ax_app as *const _);
    }

    Ok(serde_json::Value::Array(out))
}

/// Perform an AX action on the first element matching (role, label).
#[napi]
pub fn perform_action(
    window_id: u32,
    role: String,
    label: String,
    action: String,
) -> napi::Result<serde_json::Value> {
    let Some((ax_app, ax_win)) = ax_app_and_window_for_cg_window(window_id)? else {
        return Err(napi::Error::from_reason(format!("window_not_found:{window_id}")));
    };

    let mut hits: Vec<AXUIElementRef> = Vec::new();
    first_match_visit(ax_win, &role, &label, 0, &mut hits);

    let Some(target) = hits.into_iter().next() else {
        unsafe {
            CFRelease(ax_win as *const _);
            CFRelease(ax_app as *const _);
        }
        return Ok(serde_json::json!({ "performed": false, "reason": "not_found" }));
    };

    // Check AXEnabled before acting.
    let enabled = ax_copy_bool(target, "AXEnabled").unwrap_or(true);
    if !enabled {
        let (x, y) = ax_copy_point(target).unwrap_or((0.0, 0.0));
        let (w, h) = ax_copy_size(target).unwrap_or((0.0, 0.0));
        unsafe {
            CFRelease(target as *const _);
            CFRelease(ax_win as *const _);
            CFRelease(ax_app as *const _);
        }
        return Ok(serde_json::json!({
            "performed": false,
            "reason": "disabled",
            "bounds": { "x": x, "y": y, "width": w, "height": h },
        }));
    }

    // Check action availability.
    let actions = ax_copy_actions(target);
    if !actions.iter().any(|a| a == &action) {
        let (x, y) = ax_copy_point(target).unwrap_or((0.0, 0.0));
        let (w, h) = ax_copy_size(target).unwrap_or((0.0, 0.0));
        unsafe {
            CFRelease(target as *const _);
            CFRelease(ax_win as *const _);
            CFRelease(ax_app as *const _);
        }
        return Ok(serde_json::json!({
            "performed": false,
            "reason": "unsupported_action",
            "bounds": { "x": x, "y": y, "width": w, "height": h },
        }));
    }

    let action_key = CFString::new(&action);
    let err = unsafe { AXUIElementPerformAction(target, action_key.as_concrete_TypeRef()) };

    let (x, y) = ax_copy_point(target).unwrap_or((0.0, 0.0));
    let (w, h) = ax_copy_size(target).unwrap_or((0.0, 0.0));

    unsafe {
        CFRelease(target as *const _);
        CFRelease(ax_win as *const _);
        CFRelease(ax_app as *const _);
    }

    if is_permission_error(err) {
        return Err(napi::Error::from_reason(ax_error_to_reason(err)));
    }

    if err == K_AX_ERROR_SUCCESS {
        Ok(serde_json::json!({
            "performed": true,
            "bounds": { "x": x, "y": y, "width": w, "height": h },
        }))
    } else {
        Ok(serde_json::json!({
            "performed": false,
            "reason": ax_error_to_reason(err),
            "bounds": { "x": x, "y": y, "width": w, "height": h },
        }))
    }
}

/// Set AXValue on the first element matching (role, label).
#[napi]
pub fn set_element_value(
    window_id: u32,
    role: String,
    label: String,
    value: String,
) -> napi::Result<serde_json::Value> {
    let Some((ax_app, ax_win)) = ax_app_and_window_for_cg_window(window_id)? else {
        return Err(napi::Error::from_reason(format!("window_not_found:{window_id}")));
    };

    let mut hits: Vec<AXUIElementRef> = Vec::new();
    first_match_visit(ax_win, &role, &label, 0, &mut hits);

    let Some(target) = hits.into_iter().next() else {
        unsafe {
            CFRelease(ax_win as *const _);
            CFRelease(ax_app as *const _);
        }
        return Ok(serde_json::json!({ "set": false, "reason": "not_found" }));
    };

    let value_key = CFString::new("AXValue");
    let mut settable = false;
    let check = unsafe {
        AXUIElementIsAttributeSettable(target, value_key.as_concrete_TypeRef(), &mut settable)
    };
    if check != K_AX_ERROR_SUCCESS || !settable {
        unsafe {
            CFRelease(target as *const _);
            CFRelease(ax_win as *const _);
            CFRelease(ax_app as *const _);
        }
        if is_permission_error(check) {
            return Err(napi::Error::from_reason(ax_error_to_reason(check)));
        }
        return Ok(serde_json::json!({ "set": false, "reason": "read_only" }));
    }

    let cf_val = CFString::new(&value);
    let err = unsafe {
        AXUIElementSetAttributeValue(
            target,
            value_key.as_concrete_TypeRef(),
            cf_val.as_concrete_TypeRef() as RawCFTypeRef,
        )
    };

    unsafe {
        CFRelease(target as *const _);
        CFRelease(ax_win as *const _);
        CFRelease(ax_app as *const _);
    }

    if is_permission_error(err) {
        return Err(napi::Error::from_reason(ax_error_to_reason(err)));
    }

    if err == K_AX_ERROR_SUCCESS {
        Ok(serde_json::json!({ "set": true }))
    } else if err == K_AX_ERROR_ATTRIBUTE_UNSUPPORTED || err == K_AX_ERROR_ACTION_UNSUPPORTED {
        Ok(serde_json::json!({ "set": false, "reason": "read_only" }))
    } else {
        Ok(serde_json::json!({ "set": false, "reason": ax_error_to_reason(err) }))
    }
}

// ---------------------------------------------------------------------------
// Menu bar
// ---------------------------------------------------------------------------

fn menu_item_to_json(item: AXUIElementRef, depth: i32) -> serde_json::Value {
    let title = ax_copy_string(item, "AXTitle").unwrap_or_default();
    let enabled = ax_copy_bool(item, "AXEnabled").unwrap_or(true);
    let cmd_char = ax_copy_string(item, "AXMenuItemCmdChar");

    let mut j = serde_json::json!({
        "title": title,
        "enabled": enabled,
    });
    if let Some(c) = cmd_char {
        j["shortcut"] = serde_json::Value::String(c);
    }

    if depth < 4 {
        // Look for a submenu: AXMenuItem typically has one AXMenu child.
        if let Some((arr_ref, kids)) = ax_copy_children(item) {
            let mut sub: Vec<serde_json::Value> = Vec::new();
            for k in &kids {
                let role = ax_copy_string(*k, "AXRole").unwrap_or_default();
                if role == "AXMenu" {
                    if let Some((sub_arr, sub_kids)) = ax_copy_children(*k) {
                        for s in &sub_kids {
                            sub.push(menu_item_to_json(*s, depth + 1));
                        }
                        unsafe { CFRelease(sub_arr) };
                    }
                }
            }
            unsafe { CFRelease(arr_ref) };
            if !sub.is_empty() {
                j["submenu"] = serde_json::Value::Array(sub);
            }
        }
    }

    j
}

/// Walk the app's AXMenuBar and return the nested menu structure.
#[napi]
pub fn get_menu_bar(bundle_id: String) -> napi::Result<serde_json::Value> {
    let Some(pid) = pid_for_bundle(&bundle_id) else {
        return Err(napi::Error::from_reason(format!("app_not_running:{bundle_id}")));
    };

    let ax_app = unsafe { AXUIElementCreateApplication(pid) };
    if ax_app.is_null() {
        return Err(napi::Error::from_reason("AXUIElementCreateApplication failed"));
    }

    let mb_key = CFString::new("AXMenuBar");
    let mut mb_val: RawCFTypeRef = std::ptr::null();
    let err = unsafe {
        AXUIElementCopyAttributeValue(ax_app, mb_key.as_concrete_TypeRef(), &mut mb_val)
    };
    if is_permission_error(err) {
        unsafe { CFRelease(ax_app as *const _) };
        return Err(napi::Error::from_reason(ax_error_to_reason(err)));
    }
    if err != K_AX_ERROR_SUCCESS || mb_val.is_null() {
        unsafe { CFRelease(ax_app as *const _) };
        return Ok(serde_json::json!([]));
    }

    let menu_bar = mb_val as AXUIElementRef;
    let mut out: Vec<serde_json::Value> = Vec::new();

    if let Some((arr_ref, kids)) = ax_copy_children(menu_bar) {
        // Skip index 0 (Apple menu) when enumerating — but include it; agents
        // may want to reach it. Keep it in.
        for item in &kids {
            let title = ax_copy_string(*item, "AXTitle").unwrap_or_default();
            let enabled = ax_copy_bool(*item, "AXEnabled").unwrap_or(true);
            let mut items: Vec<serde_json::Value> = Vec::new();

            if let Some((sub_arr, sub_kids)) = ax_copy_children(*item) {
                for sk in &sub_kids {
                    let role = ax_copy_string(*sk, "AXRole").unwrap_or_default();
                    if role == "AXMenu" {
                        if let Some((m_arr, m_kids)) = ax_copy_children(*sk) {
                            for mi in &m_kids {
                                items.push(menu_item_to_json(*mi, 1));
                            }
                            unsafe { CFRelease(m_arr) };
                        }
                    }
                }
                unsafe { CFRelease(sub_arr) };
            }

            out.push(serde_json::json!({
                "title": title,
                "enabled": enabled,
                "items": items,
            }));
        }
        unsafe { CFRelease(arr_ref) };
    }

    unsafe {
        CFRelease(mb_val);
        CFRelease(ax_app as *const _);
    }

    Ok(serde_json::Value::Array(out))
}

/// Find menu item by (menu, [submenu], item) and AXPress it.
#[napi]
pub fn press_menu_item(
    bundle_id: String,
    menu: String,
    item: String,
    submenu: Option<String>,
) -> napi::Result<serde_json::Value> {
    let Some(pid) = pid_for_bundle(&bundle_id) else {
        return Ok(serde_json::json!({ "pressed": false, "reason": "app_not_running" }));
    };

    let ax_app = unsafe { AXUIElementCreateApplication(pid) };
    if ax_app.is_null() {
        return Ok(serde_json::json!({ "pressed": false, "reason": "ax_app_failed" }));
    }

    let mb_key = CFString::new("AXMenuBar");
    let mut mb_val: RawCFTypeRef = std::ptr::null();
    let err = unsafe {
        AXUIElementCopyAttributeValue(ax_app, mb_key.as_concrete_TypeRef(), &mut mb_val)
    };
    if is_permission_error(err) {
        unsafe { CFRelease(ax_app as *const _) };
        return Err(napi::Error::from_reason(ax_error_to_reason(err)));
    }
    if err != K_AX_ERROR_SUCCESS || mb_val.is_null() {
        unsafe { CFRelease(ax_app as *const _) };
        return Ok(serde_json::json!({ "pressed": false, "reason": "no_menu_bar" }));
    }

    let menu_bar = mb_val as AXUIElementRef;

    // Find top-level menu.
    let target_menu_item = {
        let mut result: Option<AXUIElementRef> = None;
        if let Some((arr_ref, kids)) = ax_copy_children(menu_bar) {
            for it in &kids {
                if ax_copy_string(*it, "AXTitle").as_deref() == Some(menu.as_str()) {
                    extern "C" {
                        fn CFRetain(r: RawCFTypeRef) -> RawCFTypeRef;
                    }
                    result = Some(unsafe { CFRetain(*it as RawCFTypeRef) } as AXUIElementRef);
                    break;
                }
            }
            unsafe { CFRelease(arr_ref) };
        }
        result
    };

    let Some(top_menu_item) = target_menu_item else {
        unsafe {
            CFRelease(mb_val);
            CFRelease(ax_app as *const _);
        }
        return Ok(serde_json::json!({ "pressed": false, "reason": "menu_not_found" }));
    };

    // Descend: top_menu_item → AXMenu child → items
    let descend_into_menu = |parent: AXUIElementRef| -> Option<AXUIElementRef> {
        let (arr, kids) = ax_copy_children(parent)?;
        let mut menu_child: Option<AXUIElementRef> = None;
        for k in &kids {
            if ax_copy_string(*k, "AXRole").as_deref() == Some("AXMenu") {
                extern "C" {
                    fn CFRetain(r: RawCFTypeRef) -> RawCFTypeRef;
                }
                menu_child = Some(unsafe { CFRetain(*k as RawCFTypeRef) } as AXUIElementRef);
                break;
            }
        }
        unsafe { CFRelease(arr) };
        menu_child
    };

    let Some(menu_el) = descend_into_menu(top_menu_item) else {
        unsafe {
            CFRelease(top_menu_item as *const _);
            CFRelease(mb_val);
            CFRelease(ax_app as *const _);
        }
        return Ok(serde_json::json!({ "pressed": false, "reason": "menu_empty" }));
    };

    // Find (submenu?) then item
    let find_item_in = |parent_menu: AXUIElementRef, target_title: &str| -> Option<AXUIElementRef> {
        let (arr, kids) = ax_copy_children(parent_menu)?;
        let mut hit: Option<AXUIElementRef> = None;
        for k in &kids {
            if ax_copy_string(*k, "AXTitle").as_deref() == Some(target_title) {
                extern "C" {
                    fn CFRetain(r: RawCFTypeRef) -> RawCFTypeRef;
                }
                hit = Some(unsafe { CFRetain(*k as RawCFTypeRef) } as AXUIElementRef);
                break;
            }
        }
        unsafe { CFRelease(arr) };
        hit
    };

    let target_item = if let Some(sub) = submenu.as_deref() {
        let Some(sub_item) = find_item_in(menu_el, sub) else {
            unsafe {
                CFRelease(menu_el as *const _);
                CFRelease(top_menu_item as *const _);
                CFRelease(mb_val);
                CFRelease(ax_app as *const _);
            }
            return Ok(serde_json::json!({ "pressed": false, "reason": "submenu_not_found" }));
        };
        let Some(sub_menu) = descend_into_menu(sub_item) else {
            unsafe {
                CFRelease(sub_item as *const _);
                CFRelease(menu_el as *const _);
                CFRelease(top_menu_item as *const _);
                CFRelease(mb_val);
                CFRelease(ax_app as *const _);
            }
            return Ok(serde_json::json!({ "pressed": false, "reason": "submenu_empty" }));
        };
        let hit = find_item_in(sub_menu, &item);
        unsafe {
            CFRelease(sub_menu as *const _);
            CFRelease(sub_item as *const _);
        }
        hit
    } else {
        find_item_in(menu_el, &item)
    };

    unsafe {
        CFRelease(menu_el as *const _);
        CFRelease(top_menu_item as *const _);
    }

    let Some(target) = target_item else {
        unsafe {
            CFRelease(mb_val);
            CFRelease(ax_app as *const _);
        }
        return Ok(serde_json::json!({ "pressed": false, "reason": "item_not_found" }));
    };

    // Check enabled.
    let enabled = ax_copy_bool(target, "AXEnabled").unwrap_or(true);
    if !enabled {
        unsafe {
            CFRelease(target as *const _);
            CFRelease(mb_val);
            CFRelease(ax_app as *const _);
        }
        return Ok(serde_json::json!({ "pressed": false, "reason": "item_disabled" }));
    }

    let press = CFString::new("AXPress");
    let press_err = unsafe { AXUIElementPerformAction(target, press.as_concrete_TypeRef()) };

    unsafe {
        CFRelease(target as *const _);
        CFRelease(mb_val);
        CFRelease(ax_app as *const _);
    }

    if is_permission_error(press_err) {
        return Err(napi::Error::from_reason(ax_error_to_reason(press_err)));
    }
    if press_err == K_AX_ERROR_SUCCESS {
        Ok(serde_json::json!({ "pressed": true }))
    } else {
        Ok(serde_json::json!({
            "pressed": false,
            "reason": ax_error_to_reason(press_err),
        }))
    }
}

// Suppress unused warning; CFBoolean used via transitively-wrapped helpers.
#[allow(dead_code)]
fn _unused_cf_boolean() -> CFBoolean {
    CFBoolean::true_value()
}
