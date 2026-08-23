//! Host-only macOS Keychain primitives for durable remote authorization state.
//!
//! These exports are never MCP tools. Values enter through N-API memory and
//! Security.framework directly, avoiding command-line and environment leakage.

use napi_derive::napi;

fn bounded(value: &str, name: &str, maximum: usize) -> napi::Result<()> {
    if value.is_empty()
        || value.len() > maximum
        || value.bytes().any(|byte| matches!(byte, 0 | b'\r' | b'\n'))
    {
        return Err(napi::Error::from_reason(format!(
            "{name} must be a bounded single-line string"
        )));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
mod platform {
    use core_foundation::base::{CFType, CFTypeRef, TCFType};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::data::CFData;
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::string::CFStringRef;
    use std::ptr;

    type OSStatus = i32;
    const ERR_SEC_SUCCESS: OSStatus = 0;
    const ERR_SEC_DUPLICATE_ITEM: OSStatus = -25299;
    const ERR_SEC_ITEM_NOT_FOUND: OSStatus = -25300;

    #[link(name = "Security", kind = "framework")]
    extern "C" {
        static kSecClass: CFStringRef;
        static kSecClassGenericPassword: CFStringRef;
        static kSecAttrService: CFStringRef;
        static kSecAttrAccount: CFStringRef;
        static kSecValueData: CFStringRef;
        static kSecReturnData: CFStringRef;
        static kSecMatchLimit: CFStringRef;
        static kSecMatchLimitOne: CFStringRef;
        fn SecItemCopyMatching(query: CFDictionaryRef, result: *mut CFTypeRef) -> OSStatus;
        fn SecItemAdd(attributes: CFDictionaryRef, result: *mut CFTypeRef) -> OSStatus;
        fn SecItemUpdate(query: CFDictionaryRef, attributes: CFDictionaryRef) -> OSStatus;
    }

    unsafe fn constant(value: CFStringRef) -> CFType {
        CFType::wrap_under_get_rule(value as CFTypeRef)
    }

    unsafe fn query(service: &str, account: &str) -> CFDictionary<CFType, CFType> {
        CFDictionary::from_CFType_pairs(&[
            (constant(kSecClass), constant(kSecClassGenericPassword)),
            (
                constant(kSecAttrService),
                core_foundation::string::CFString::new(service).as_CFType(),
            ),
            (
                constant(kSecAttrAccount),
                core_foundation::string::CFString::new(account).as_CFType(),
            ),
        ])
    }

    pub fn get(service: &str, account: &str) -> napi::Result<Option<String>> {
        unsafe {
            let base = query(service, account);
            let mut pairs = base
                .get_keys_and_values()
                .0
                .iter()
                .zip(base.get_keys_and_values().1.iter())
                .map(|(key, value)| {
                    (
                        CFType::wrap_under_get_rule(*key),
                        CFType::wrap_under_get_rule(*value),
                    )
                })
                .collect::<Vec<_>>();
            pairs.push((
                constant(kSecReturnData),
                CFBoolean::true_value().as_CFType(),
            ));
            pairs.push((constant(kSecMatchLimit), constant(kSecMatchLimitOne)));
            let full = CFDictionary::from_CFType_pairs(&pairs);
            let mut result: CFTypeRef = ptr::null();
            let status = SecItemCopyMatching(full.as_concrete_TypeRef(), &mut result);
            if status == ERR_SEC_ITEM_NOT_FOUND {
                return Ok(None);
            }
            if status != ERR_SEC_SUCCESS || result.is_null() {
                return Err(napi::Error::from_reason(format!(
                    "Keychain read failed with OSStatus {status}"
                )));
            }
            let value = CFType::wrap_under_create_rule(result)
                .downcast::<CFData>()
                .ok_or_else(|| napi::Error::from_reason("Keychain returned non-data content"))?;
            String::from_utf8(value.to_vec())
                .map(Some)
                .map_err(|_| napi::Error::from_reason("Keychain value is not valid UTF-8"))
        }
    }

    pub fn set(service: &str, account: &str, value: &str) -> napi::Result<()> {
        unsafe {
            let base = query(service, account);
            let data = CFData::from_buffer(value.as_bytes());
            let update =
                CFDictionary::from_CFType_pairs(&[(constant(kSecValueData), data.as_CFType())]);
            let mut status =
                SecItemUpdate(base.as_concrete_TypeRef(), update.as_concrete_TypeRef());
            if status == ERR_SEC_ITEM_NOT_FOUND {
                let (keys, values) = base.get_keys_and_values();
                let mut pairs = keys
                    .iter()
                    .zip(values.iter())
                    .map(|(key, existing)| {
                        (
                            CFType::wrap_under_get_rule(*key),
                            CFType::wrap_under_get_rule(*existing),
                        )
                    })
                    .collect::<Vec<_>>();
                pairs.push((constant(kSecValueData), data.as_CFType()));
                let add = CFDictionary::from_CFType_pairs(&pairs);
                status = SecItemAdd(add.as_concrete_TypeRef(), ptr::null_mut());
                if status == ERR_SEC_DUPLICATE_ITEM {
                    status =
                        SecItemUpdate(base.as_concrete_TypeRef(), update.as_concrete_TypeRef());
                }
            }
            if status != ERR_SEC_SUCCESS {
                return Err(napi::Error::from_reason(format!(
                    "Keychain write failed with OSStatus {status}"
                )));
            }
            Ok(())
        }
    }
}

#[napi]
pub fn keychain_get_generic_password(
    service: String,
    account: String,
) -> napi::Result<Option<String>> {
    bounded(&service, "Keychain service", 256)?;
    bounded(&account, "Keychain account", 512)?;
    #[cfg(target_os = "macos")]
    return platform::get(&service, &account);
    #[cfg(not(target_os = "macos"))]
    Err(napi::Error::from_reason(
        "native Keychain is only available on macOS",
    ))
}

#[napi]
pub fn keychain_set_generic_password(
    service: String,
    account: String,
    value: String,
) -> napi::Result<()> {
    bounded(&service, "Keychain service", 256)?;
    bounded(&account, "Keychain account", 512)?;
    bounded(&value, "Keychain value", 8 * 1024 * 1024)?;
    #[cfg(target_os = "macos")]
    return platform::set(&service, &account, &value);
    #[cfg(not(target_os = "macos"))]
    Err(napi::Error::from_reason(
        "native Keychain is only available on macOS",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keychain_inputs_are_bounded() {
        assert!(bounded("service", "service", 10).is_ok());
        assert!(bounded("", "service", 10).is_err());
        assert!(bounded("line\nbreak", "service", 20).is_err());
        assert!(bounded("too-long", "service", 3).is_err());
    }
}
