//! Host-only operating-system permission status and request primitives.
//!
//! These exports are deliberately not MCP tools. A trusted desktop host may
//! invoke them from an explicit onboarding gesture. Unsupported platforms and
//! permissions return capability facts instead of manufacturing success.

use napi_derive::napi;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Permission {
    Accessibility,
    DisplayCapture,
}

fn parse_permission(value: &str) -> napi::Result<Permission> {
    match value {
        "accessibility" => Ok(Permission::Accessibility),
        "display_capture" => Ok(Permission::DisplayCapture),
        _ => Err(napi::Error::from_reason(format!(
            "unsupported native permission: {value}"
        ))),
    }
}

fn permission_name(permission: Permission) -> &'static str {
    match permission {
        Permission::Accessibility => "accessibility",
        Permission::DisplayCapture => "display_capture",
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::Permission;
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::string::{CFString, CFStringRef};

    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
        static kAXTrustedCheckOptionPrompt: CFStringRef;
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    pub fn status(permission: Permission) -> bool {
        unsafe {
            match permission {
                Permission::Accessibility => AXIsProcessTrusted(),
                Permission::DisplayCapture => CGPreflightScreenCaptureAccess(),
            }
        }
    }

    pub fn request(permission: Permission) -> bool {
        unsafe {
            match permission {
                Permission::Accessibility => {
                    let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
                    let options: CFDictionary<CFString, CFBoolean> =
                        CFDictionary::from_CFType_pairs(&[(key, CFBoolean::true_value())]);
                    AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef())
                }
                Permission::DisplayCapture => CGRequestScreenCaptureAccess(),
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::Permission;
    pub fn status(_permission: Permission) -> bool {
        false
    }
    pub fn request(_permission: Permission) -> bool {
        false
    }
}

/// Why synthesized input is refused rather than posted when the process is not
/// trusted for Accessibility. macOS discards `CGEventPost` from an untrusted
/// process without any error, so a click or keystroke "succeeds" and nothing
/// happens on screen; naming it is the only way an agent can act on it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) const INPUT_UNTRUSTED_REASON: &str = "accessibility_permission_denied: macOS discards synthesized mouse and keyboard events from a process that is not trusted for Accessibility, so this input was not delivered. Enable your terminal, IDE or agent host in System Settings > Privacy & Security > Accessibility, then restart it.";

/// Refuse to post input that macOS would silently drop.
#[cfg(target_os = "macos")]
pub(crate) fn ensure_input_trusted() -> napi::Result<()> {
    if platform::status(Permission::Accessibility) {
        Ok(())
    } else {
        Err(napi::Error::from_reason(INPUT_UNTRUSTED_REASON))
    }
}

/// Whether this process may capture the screen. Consulted when a capture fails
/// so the failure can name the permission instead of the tool.
#[cfg(target_os = "macos")]
pub(crate) fn screen_capture_granted() -> bool {
    platform::status(Permission::DisplayCapture)
}

fn response(permission: Permission, requested: bool, granted: bool) -> serde_json::Value {
    let supported = cfg!(target_os = "macos");
    serde_json::json!({
        "permission": permission_name(permission),
        "supported": supported,
        "canPrompt": supported,
        "granted": granted,
        "promptRequested": requested && supported,
        "backend": if supported { "macos_tcc" } else { "unsupported" },
        "restartMayBeRequired": supported,
        "reason": if supported { serde_json::Value::Null } else {
            serde_json::Value::String("native permission prompting is only available on macOS".into())
        },
    })
}

#[napi]
pub fn get_native_permission_status(permission: String) -> napi::Result<serde_json::Value> {
    let permission = parse_permission(&permission)?;
    Ok(response(permission, false, platform::status(permission)))
}

#[napi]
pub fn request_native_permission(permission: String) -> napi::Result<serde_json::Value> {
    let permission = parse_permission(&permission)?;
    Ok(response(permission, true, platform::request(permission)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_names_are_closed_and_stable() {
        assert_eq!(
            parse_permission("accessibility").unwrap(),
            Permission::Accessibility
        );
        assert_eq!(
            parse_permission("display_capture").unwrap(),
            Permission::DisplayCapture
        );
        assert!(parse_permission("automation").is_err());
        assert!(parse_permission("https://attacker.invalid").is_err());
    }

    #[test]
    fn untrusted_input_reason_is_nameable_and_actionable() {
        assert!(INPUT_UNTRUSTED_REASON.starts_with("accessibility_permission_denied:"));
        assert!(INPUT_UNTRUSTED_REASON.contains("Privacy & Security > Accessibility"));
        assert!(INPUT_UNTRUSTED_REASON.contains("not delivered"));
    }

    #[test]
    fn unsupported_platform_never_claims_a_prompt() {
        if !cfg!(target_os = "macos") {
            let value = request_native_permission("accessibility".into()).unwrap();
            assert_eq!(value["supported"], false);
            assert_eq!(value["promptRequested"], false);
            assert_eq!(value["granted"], false);
        }
    }
}
