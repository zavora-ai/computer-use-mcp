//! Agent Space management — best-effort, private-API based.
//!
//! macOS Mission Control Spaces have no public API. The private
//! `CGS`/`SkyLight` symbols (`CGSCopyManagedDisplaySpaces`,
//! `CGSGetActiveSpace`, `CGSSpaceCreate`, `CGSAddWindowsToSpaces`) are
//! reachable on every recent macOS, but the mutating ones (`CGSSpaceCreate`,
//! `CGSAddWindowsToSpaces`) require elevated entitlements to affect windows
//! owned by another process. Without those (the default on a SIP-enabled
//! Mac), window-move is a silent no-op.
//!
//! This module exposes:
//!
//! - `list_spaces()` — read-only inventory of user Spaces (always works).
//! - `get_active_space()` — current Space ID (always works).
//! - `create_agent_space()` — attempts `CGSSpaceCreate`. Returns the new ID
//!   on success, but marks `attached: false` because orphan Spaces don't
//!   appear in Mission Control on SIP-enabled Macs. Callers should treat
//!   the result as "probe only" and verify with `list_spaces`.
//! - `move_window_to_space()` — attempts `CGSAddWindowsToSpaces`. Reports
//!   `verified: false` when the window stays visible after the call (the
//!   typical SIP-blocked outcome), so the session layer can degrade.

use core_foundation::array::CFArrayRef;
use core_foundation::base::{CFRelease, TCFType};
use core_foundation::dictionary::CFDictionaryRef;
use core_foundation::number::CFNumber;
use core_foundation::string::{CFString, CFStringRef};
use napi_derive::napi;
use std::ffi::{c_void, CString};
use std::sync::OnceLock;

// ---------------------------------------------------------------------------
// dlsym glue
// ---------------------------------------------------------------------------

extern "C" {
    fn dlopen(path: *const i8, mode: i32) -> *mut c_void;
    fn dlsym(handle: *mut c_void, name: *const i8) -> *mut c_void;
}

const RTLD_LAZY: i32 = 0x1;

fn load_lib(path: &str) -> *mut c_void {
    let Ok(c) = CString::new(path) else { return std::ptr::null_mut() };
    unsafe { dlopen(c.as_ptr(), RTLD_LAZY) }
}

fn sym(handle: *mut c_void, name: &str) -> *mut c_void {
    if handle.is_null() {
        return std::ptr::null_mut();
    }
    let Ok(c) = CString::new(name) else { return std::ptr::null_mut() };
    unsafe { dlsym(handle, c.as_ptr()) }
}

// ---------------------------------------------------------------------------
// CGS type aliases + function-pointer table
// ---------------------------------------------------------------------------

type CGSConnection = u32;
type CGSSpaceId = u64;

type FnMainConnectionId = unsafe extern "C" fn() -> CGSConnection;
type FnGetActiveSpace = unsafe extern "C" fn(CGSConnection) -> CGSSpaceId;
type FnCopyManagedDisplaySpaces = unsafe extern "C" fn(CGSConnection) -> CFArrayRef;
type FnSpaceCreate = unsafe extern "C" fn(CGSConnection, i32, CFDictionaryRef) -> CGSSpaceId;
type FnSpaceDestroy = unsafe extern "C" fn(CGSConnection, CGSSpaceId);
type FnAddWindowsToSpaces =
    unsafe extern "C" fn(CGSConnection, CFArrayRef /* spaces */, CFArrayRef /* windows */);
type FnRemoveWindowsFromSpaces =
    unsafe extern "C" fn(CGSConnection, CFArrayRef /* spaces */, CFArrayRef /* windows */);

struct Cgs {
    main_conn: Option<FnMainConnectionId>,
    get_active: Option<FnGetActiveSpace>,
    copy_display_spaces: Option<FnCopyManagedDisplaySpaces>,
    space_create: Option<FnSpaceCreate>,
    space_destroy: Option<FnSpaceDestroy>,
    add_wins: Option<FnAddWindowsToSpaces>,
    rem_wins: Option<FnRemoveWindowsFromSpaces>,
    /// True iff every read-only symbol (main_conn, get_active, copy_display_spaces) resolved.
    reads_ok: bool,
    /// True iff every mutating symbol (space_create, add_wins) resolved.
    mutates_ok: bool,
}

static CGS: OnceLock<Cgs> = OnceLock::new();

fn load_cgs() -> &'static Cgs {
    CGS.get_or_init(|| {
        let cg = load_lib("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics");
        let sl = load_lib("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight");

        let pick = |n: &str| -> *mut c_void {
            let p = sym(sl, n);
            if !p.is_null() {
                return p;
            }
            sym(cg, n)
        };

        unsafe {
            let main_conn_p = pick("CGSMainConnectionID");
            let get_active_p = pick("CGSGetActiveSpace");
            let copy_display_spaces_p = pick("CGSCopyManagedDisplaySpaces");
            let space_create_p = pick("CGSSpaceCreate");
            let space_destroy_p = pick("CGSSpaceDestroy");
            let add_wins_p = pick("CGSAddWindowsToSpaces");
            let rem_wins_p = pick("CGSRemoveWindowsFromSpaces");

            let reads_ok = !main_conn_p.is_null()
                && !get_active_p.is_null()
                && !copy_display_spaces_p.is_null();
            let mutates_ok = reads_ok && !space_create_p.is_null() && !add_wins_p.is_null();

            Cgs {
                main_conn: if main_conn_p.is_null() {
                    None
                } else {
                    Some(std::mem::transmute::<*mut c_void, FnMainConnectionId>(main_conn_p))
                },
                get_active: if get_active_p.is_null() {
                    None
                } else {
                    Some(std::mem::transmute::<*mut c_void, FnGetActiveSpace>(get_active_p))
                },
                copy_display_spaces: if copy_display_spaces_p.is_null() {
                    None
                } else {
                    Some(std::mem::transmute::<*mut c_void, FnCopyManagedDisplaySpaces>(
                        copy_display_spaces_p,
                    ))
                },
                space_create: if space_create_p.is_null() {
                    None
                } else {
                    Some(std::mem::transmute::<*mut c_void, FnSpaceCreate>(space_create_p))
                },
                space_destroy: if space_destroy_p.is_null() {
                    None
                } else {
                    Some(std::mem::transmute::<*mut c_void, FnSpaceDestroy>(space_destroy_p))
                },
                add_wins: if add_wins_p.is_null() {
                    None
                } else {
                    Some(std::mem::transmute::<*mut c_void, FnAddWindowsToSpaces>(add_wins_p))
                },
                rem_wins: if rem_wins_p.is_null() {
                    None
                } else {
                    Some(std::mem::transmute::<*mut c_void, FnRemoveWindowsFromSpaces>(rem_wins_p))
                },
                reads_ok,
                mutates_ok,
            }
        }
    })
}

// ---------------------------------------------------------------------------
// CoreFoundation plumbing
// ---------------------------------------------------------------------------

type RawCFTypeRef = *const c_void;

extern "C" {
    fn CFArrayGetCount(array: CFArrayRef) -> isize;
    fn CFArrayGetValueAtIndex(array: CFArrayRef, idx: isize) -> RawCFTypeRef;
    fn CFDictionaryGetValue(dict: CFDictionaryRef, key: RawCFTypeRef) -> RawCFTypeRef;
    fn CFArrayCreate(
        allocator: RawCFTypeRef,
        values: *const RawCFTypeRef,
        count: isize,
        callbacks: RawCFTypeRef,
    ) -> CFArrayRef;
    static kCFTypeArrayCallBacks: c_void;
    fn CGWindowListCopyWindowInfo(option: u32, relativeToWindow: u32) -> CFArrayRef;
}

const K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY: u32 = 1 << 0;

fn dict_get(dict: CFDictionaryRef, key: &str) -> Option<RawCFTypeRef> {
    unsafe {
        let cf_key = CFString::new(key);
        let v = CFDictionaryGetValue(dict, cf_key.as_concrete_TypeRef() as RawCFTypeRef);
        if v.is_null() {
            None
        } else {
            Some(v)
        }
    }
}

fn dict_get_i64(dict: CFDictionaryRef, key: &str) -> Option<i64> {
    unsafe {
        let v = dict_get(dict, key)?;
        let n: CFNumber = TCFType::wrap_under_get_rule(v as *const _);
        n.to_i64()
    }
}

fn dict_get_string(dict: CFDictionaryRef, key: &str) -> Option<String> {
    unsafe {
        let v = dict_get(dict, key)?;
        let s: CFString = TCFType::wrap_under_get_rule(v as CFStringRef);
        Some(s.to_string())
    }
}

fn window_is_on_screen(window_id: u32) -> Option<bool> {
    unsafe {
        let arr = CGWindowListCopyWindowInfo(
            K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY,
            0,
        );
        if arr.is_null() {
            return None;
        }
        let count = CFArrayGetCount(arr) as usize;
        let mut found = false;
        for i in 0..count {
            let dict = CFArrayGetValueAtIndex(arr, i as isize) as CFDictionaryRef;
            if dict_get_i64(dict, "kCGWindowNumber") == Some(window_id as i64) {
                found = true;
                break;
            }
        }
        CFRelease(arr as *const _);
        Some(found)
    }
}

// ---------------------------------------------------------------------------
// Public NAPI surface
// ---------------------------------------------------------------------------

/// List the user's Spaces grouped by display, plus the active Space ID.
///
/// Always returns structured data on modern macOS. Unlike `create_agent_space`,
/// this does not require elevated entitlements — it's a pure read.
#[napi]
pub fn list_spaces() -> napi::Result<serde_json::Value> {
    let cgs = load_cgs();
    if !cgs.reads_ok {
        return Ok(serde_json::json!({
            "supported": false,
            "reason": "cgs_read_symbols_unavailable",
            "active_space_id": null,
            "displays": [],
        }));
    }

    unsafe {
        let cid = (cgs.main_conn.unwrap())();
        let active = (cgs.get_active.unwrap())(cid);
        let displays_arr = (cgs.copy_display_spaces.unwrap())(cid);
        if displays_arr.is_null() {
            return Ok(serde_json::json!({
                "supported": true,
                "active_space_id": active,
                "displays": [],
            }));
        }

        let mut displays_out: Vec<serde_json::Value> = Vec::new();
        let count = CFArrayGetCount(displays_arr) as usize;
        for i in 0..count {
            let disp = CFArrayGetValueAtIndex(displays_arr, i as isize) as CFDictionaryRef;
            let did = dict_get_string(disp, "Display Identifier").unwrap_or_default();

            let mut spaces_out: Vec<serde_json::Value> = Vec::new();
            if let Some(spaces_ref) = dict_get(disp, "Spaces") {
                let spaces_arr = spaces_ref as CFArrayRef;
                let n = CFArrayGetCount(spaces_arr) as usize;
                for j in 0..n {
                    let sp = CFArrayGetValueAtIndex(spaces_arr, j as isize) as CFDictionaryRef;
                    let id64 = dict_get_i64(sp, "id64").unwrap_or(0);
                    let ty = dict_get_i64(sp, "type").unwrap_or(0);
                    let uuid = dict_get_string(sp, "uuid").unwrap_or_default();
                    spaces_out.push(serde_json::json!({
                        "id": id64,
                        "type": ty,
                        "uuid": uuid,
                    }));
                }
            }

            displays_out.push(serde_json::json!({
                "display_id": did,
                "spaces": spaces_out,
            }));
        }

        CFRelease(displays_arr as *const _);

        Ok(serde_json::json!({
            "supported": true,
            "active_space_id": active,
            "displays": displays_out,
        }))
    }
}

/// Return the active Space ID (or null if CGS is unreachable).
#[napi]
pub fn get_active_space() -> napi::Result<serde_json::Value> {
    let cgs = load_cgs();
    if !cgs.reads_ok {
        return Ok(serde_json::json!(null));
    }
    let id = unsafe {
        let cid = (cgs.main_conn.unwrap())();
        (cgs.get_active.unwrap())(cid)
    };
    Ok(serde_json::json!(id))
}

/// Attempt to create an agent Space.
///
/// On SIP-enabled Macs, `CGSSpaceCreate` returns a Space ID but the new Space
/// does not appear in `CGSCopyManagedDisplaySpaces` — it's orphaned and not
/// reachable by the user. We still return the ID so tools can reference it,
/// but mark `attached: false` so callers know it's not a user-visible Space.
#[napi]
pub fn create_agent_space() -> napi::Result<serde_json::Value> {
    let cgs = load_cgs();
    if !cgs.mutates_ok {
        return Ok(serde_json::json!({
            "supported": false,
            "reason": "cgs_mutate_symbols_unavailable",
        }));
    }

    unsafe {
        // Build options dict: { "type": 0, "uuid": <fresh UUID> }
        extern "C" {
            fn CFUUIDCreate(alloc: RawCFTypeRef) -> RawCFTypeRef;
            fn CFUUIDCreateString(alloc: RawCFTypeRef, uuid: RawCFTypeRef) -> CFStringRef;
            fn CFDictionaryCreateMutable(
                alloc: RawCFTypeRef,
                capacity: isize,
                key_cb: RawCFTypeRef,
                val_cb: RawCFTypeRef,
            ) -> CFDictionaryRef;
            fn CFDictionarySetValue(dict: CFDictionaryRef, key: RawCFTypeRef, value: RawCFTypeRef);
            fn CFNumberCreate(alloc: RawCFTypeRef, ty: i32, value: *const c_void) -> RawCFTypeRef;
            static kCFTypeDictionaryKeyCallBacks: c_void;
            static kCFTypeDictionaryValueCallBacks: c_void;
        }

        let cid = (cgs.main_conn.unwrap())();

        let uuid = CFUUIDCreate(std::ptr::null());
        let uuid_str = CFUUIDCreateString(std::ptr::null(), uuid);

        // kCFNumberIntType = 9
        let zero: i32 = 0;
        let zero_num = CFNumberCreate(std::ptr::null(), 9, &zero as *const _ as *const c_void);

        let dict = CFDictionaryCreateMutable(
            std::ptr::null(),
            0,
            &kCFTypeDictionaryKeyCallBacks as *const _ as RawCFTypeRef,
            &kCFTypeDictionaryValueCallBacks as *const _ as RawCFTypeRef,
        );
        let type_key = CFString::new("type");
        let uuid_key = CFString::new("uuid");
        CFDictionarySetValue(dict, type_key.as_concrete_TypeRef() as RawCFTypeRef, zero_num);
        CFDictionarySetValue(
            dict,
            uuid_key.as_concrete_TypeRef() as RawCFTypeRef,
            uuid_str as RawCFTypeRef,
        );

        let new_space = (cgs.space_create.unwrap())(cid, 1, dict);

        CFRelease(dict as *const _);
        CFRelease(zero_num);
        CFRelease(uuid_str as *const _);
        CFRelease(uuid);

        if new_space == 0 {
            return Ok(serde_json::json!({
                "supported": false,
                "reason": "space_create_returned_zero",
            }));
        }

        // Check whether the new Space shows up in the managed list.
        // If not, it's an orphan — useful as a handle but invisible to the user.
        let mut attached = false;
        let displays_arr = (cgs.copy_display_spaces.unwrap())(cid);
        if !displays_arr.is_null() {
            let dc = CFArrayGetCount(displays_arr) as usize;
            'outer: for i in 0..dc {
                let disp = CFArrayGetValueAtIndex(displays_arr, i as isize) as CFDictionaryRef;
                if let Some(sref) = dict_get(disp, "Spaces") {
                    let sa = sref as CFArrayRef;
                    let n = CFArrayGetCount(sa) as usize;
                    for j in 0..n {
                        let sp = CFArrayGetValueAtIndex(sa, j as isize) as CFDictionaryRef;
                        if dict_get_i64(sp, "id64") == Some(new_space as i64) {
                            attached = true;
                            break 'outer;
                        }
                    }
                }
            }
            CFRelease(displays_arr as *const _);
        }

        Ok(serde_json::json!({
            "supported": true,
            "spaceId": new_space,
            "attached": attached,
            "note": if attached {
                "Space is visible in Mission Control."
            } else {
                "Space created but orphaned (not visible in Mission Control). \
                 On SIP-enabled Macs, user-visible Space creation requires \
                 elevated entitlements; treat this as a handle for window \
                 assignment only."
            },
        }))
    }
}

/// Attempt to move a window into a Space.
///
/// Returns `{ moved: true, verified: bool }`. `verified: false` means the
/// CGS call did not raise an error but the window is still on-screen after
/// the move — the typical outcome on SIP-enabled Macs where the call
/// silently no-ops for windows we don't own.
#[napi]
pub fn move_window_to_space(
    window_id: u32,
    space_id: i64,
) -> napi::Result<serde_json::Value> {
    let cgs = load_cgs();
    if !cgs.mutates_ok {
        return Ok(serde_json::json!({
            "moved": false,
            "reason": "cgs_mutate_symbols_unavailable",
        }));
    }

    let before = window_is_on_screen(window_id).unwrap_or(true);

    unsafe {
        let cid = (cgs.main_conn.unwrap())();

        extern "C" {
            fn CFNumberCreate(alloc: RawCFTypeRef, ty: i32, value: *const c_void) -> RawCFTypeRef;
        }

        // kCFNumberSInt32Type = 3, kCFNumberSInt64Type = 4
        let wid: i32 = window_id as i32;
        let wid_num = CFNumberCreate(std::ptr::null(), 3, &wid as *const _ as *const c_void);
        let sid: i64 = space_id;
        let sid_num = CFNumberCreate(std::ptr::null(), 4, &sid as *const _ as *const c_void);

        let windows = CFArrayCreate(
            std::ptr::null(),
            &wid_num as *const RawCFTypeRef,
            1,
            &kCFTypeArrayCallBacks as *const _ as RawCFTypeRef,
        );
        let spaces = CFArrayCreate(
            std::ptr::null(),
            &sid_num as *const RawCFTypeRef,
            1,
            &kCFTypeArrayCallBacks as *const _ as RawCFTypeRef,
        );

        (cgs.add_wins.unwrap())(cid, spaces, windows);

        // Small settle window for the WindowServer to apply the move.
        std::thread::sleep(std::time::Duration::from_millis(150));

        let after = window_is_on_screen(window_id).unwrap_or(true);

        CFRelease(windows as *const _);
        CFRelease(spaces as *const _);
        CFRelease(wid_num);
        CFRelease(sid_num);

        let verified = before && !after;

        Ok(serde_json::json!({
            "moved": true,
            "verified": verified,
            "window_on_screen_before": before,
            "window_on_screen_after": after,
            "note": if verified {
                "Window was visibly moved off the current Space."
            } else {
                "CGSAddWindowsToSpaces was called but the window remains visible. \
                 On SIP-enabled Macs, moving windows owned by other processes \
                 requires elevated entitlements and silently no-ops without them."
            },
        }))
    }
}

/// Remove a window from a Space (companion to `move_window_to_space`).
#[napi]
pub fn remove_window_from_space(
    window_id: u32,
    space_id: i64,
) -> napi::Result<serde_json::Value> {
    let cgs = load_cgs();
    if !cgs.mutates_ok {
        return Ok(serde_json::json!({
            "removed": false,
            "reason": "cgs_mutate_symbols_unavailable",
        }));
    }

    unsafe {
        let cid = (cgs.main_conn.unwrap())();

        extern "C" {
            fn CFNumberCreate(alloc: RawCFTypeRef, ty: i32, value: *const c_void) -> RawCFTypeRef;
        }

        let wid: i32 = window_id as i32;
        let wid_num = CFNumberCreate(std::ptr::null(), 3, &wid as *const _ as *const c_void);
        let sid: i64 = space_id;
        let sid_num = CFNumberCreate(std::ptr::null(), 4, &sid as *const _ as *const c_void);

        let windows = CFArrayCreate(
            std::ptr::null(),
            &wid_num as *const RawCFTypeRef,
            1,
            &kCFTypeArrayCallBacks as *const _ as RawCFTypeRef,
        );
        let spaces = CFArrayCreate(
            std::ptr::null(),
            &sid_num as *const RawCFTypeRef,
            1,
            &kCFTypeArrayCallBacks as *const _ as RawCFTypeRef,
        );

        if let Some(rem) = cgs.rem_wins {
            rem(cid, spaces, windows);
        }

        CFRelease(windows as *const _);
        CFRelease(spaces as *const _);
        CFRelease(wid_num);
        CFRelease(sid_num);
    }

    Ok(serde_json::json!({ "removed": true }))
}

/// Destroy an agent Space created via `create_agent_space`.
#[napi]
pub fn destroy_space(space_id: i64) -> napi::Result<serde_json::Value> {
    let cgs = load_cgs();
    if !cgs.mutates_ok || cgs.space_destroy.is_none() {
        return Ok(serde_json::json!({
            "destroyed": false,
            "reason": "cgs_mutate_symbols_unavailable",
        }));
    }
    unsafe {
        let cid = (cgs.main_conn.unwrap())();
        (cgs.space_destroy.unwrap())(cid, space_id as CGSSpaceId);
    }
    Ok(serde_json::json!({ "destroyed": true }))
}
