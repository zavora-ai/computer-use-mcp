// ── macOS implementation ──────────────────────────────────────────────────────
#[cfg(target_os = "macos")]
#[path = "spaces_macos.rs"]
mod platform;

// ── Windows implementation — Virtual Desktop Manager ─────────────────────────
#[cfg(target_os = "windows")]
mod platform {
    use napi_derive::napi;
    use std::sync::Mutex;
    use windows::core::{Interface, GUID};
    use windows::Win32::Foundation::*;
    use windows::Win32::System::Com::*;
    use windows::Win32::UI::Shell::*;

    // ── COM interface definitions ────────────────────────────────────────
    //
    // IVirtualDesktopManager is the public, stable COM interface.
    // IVirtualDesktopManagerInternal is undocumented with build-dependent GUIDs.

    // Public stable interface
    const CLSID_VIRTUAL_DESKTOP_MANAGER: GUID =
        GUID::from_u128(0xaa509086_5ca9_4c25_8f95_589d3c07b48a);

    // ImmersiveShell for accessing internal manager
    const CLSID_IMMERSIVE_SHELL: GUID =
        GUID::from_u128(0xC2F03A33_21F5_47FA_B4BB_156362A2F239);

    // Build-dependent GUIDs for IVirtualDesktopManagerInternal
    fn get_internal_iid() -> GUID {
        let build = unsafe {
            let mut info = windows::Win32::System::SystemInformation::OSVERSIONINFOW::default();
            info.dwOSVersionInfoSize = std::mem::size_of_val(&info) as u32;
            // Use RtlGetVersion which works without manifest
            #[link(name = "ntdll")]
            extern "system" {
                fn RtlGetVersion(info: *mut windows::Win32::System::SystemInformation::OSVERSIONINFOW) -> i32;
            }
            RtlGetVersion(&mut info);
            info.dwBuildNumber
        };

        if build >= 26100 {
            // Windows 11 24H2+
            GUID::from_u128(0x53F5CA0B_158F_4124_900C_057158060B27)
        } else if build >= 22621 {
            // Windows 11 22H2+
            GUID::from_u128(0xA3175F2D_239C_4BD2_8AA0_EEBA8B0B138E)
        } else {
            // Windows 10 / Server 2022
            GUID::from_u128(0xF31574D6_B682_4CDC_BD56_1827860ABEC6)
        }
    }

    // ── Desktop info via registry ────────────────────────────────────────

    fn get_desktop_name_from_registry(guid_str: &str) -> Option<String> {
        use windows::Win32::System::Registry::*;
        let path = format!(
            "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VirtualDesktops\\Desktops\\{}",
            guid_str
        );
        let wide_path: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let wide_name: Vec<u16> = "Name".encode_utf16().chain(std::iter::once(0)).collect();

        unsafe {
            let mut key = HKEY::default();
            let status = RegOpenKeyExW(
                HKEY_CURRENT_USER,
                windows::core::PCWSTR(wide_path.as_ptr()),
                0,
                KEY_READ,
                &mut key,
            );
            if status.is_err() {
                return None;
            }

            let mut buf = [0u16; 256];
            let mut size = (buf.len() * 2) as u32;
            let mut kind = REG_VALUE_TYPE::default();
            let status = RegQueryValueExW(
                key,
                windows::core::PCWSTR(wide_name.as_ptr()),
                None,
                Some(&mut kind),
                Some(buf.as_mut_ptr() as *mut u8),
                Some(&mut size),
            );
            let _ = RegCloseKey(key);

            if status.is_err() || kind != REG_SZ {
                return None;
            }
            let len = (size as usize / 2).saturating_sub(1); // exclude null
            let s = String::from_utf16_lossy(&buf[..len]);
            if s.is_empty() { None } else { Some(s) }
        }
    }

    // ── Enumerate desktops via PowerShell fallback ───────────────────────
    // When COM internal interfaces fail (Server editions), we can still
    // enumerate from the registry.

    fn enumerate_desktops_from_registry() -> Vec<serde_json::Value> {
        use windows::Win32::System::Registry::*;

        // On Server 2022 and some Win10/11 builds, desktops are stored as
        // concatenated 16-byte GUIDs in the VirtualDesktopIDs binary value.
        let path = "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VirtualDesktops";
        let wide_path: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let wide_ids: Vec<u16> = "VirtualDesktopIDs".encode_utf16().chain(std::iter::once(0)).collect();

        let mut desktops = Vec::new();
        unsafe {
            let mut key = HKEY::default();
            let status = RegOpenKeyExW(
                HKEY_CURRENT_USER,
                windows::core::PCWSTR(wide_path.as_ptr()),
                0,
                KEY_READ,
                &mut key,
            );
            if status.is_err() {
                return desktops;
            }

            // Read VirtualDesktopIDs binary value (concatenated 16-byte GUIDs)
            let mut buf = [0u8; 1024]; // up to 64 desktops
            let mut size = buf.len() as u32;
            let mut kind = REG_VALUE_TYPE::default();
            let status = RegQueryValueExW(
                key,
                windows::core::PCWSTR(wide_ids.as_ptr()),
                None,
                Some(&mut kind),
                Some(buf.as_mut_ptr()),
                Some(&mut size),
            );

            if status.is_ok() && kind == REG_BINARY && size >= 16 {
                let count = size as usize / 16;
                for i in 0..count {
                    let offset = i * 16;
                    let b = &buf[offset..offset + 16];
                    // Format as GUID: {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}
                    // Windows GUID binary layout: Data1(4 LE) Data2(2 LE) Data3(2 LE) Data4(8 BE)
                    let guid_str = format!(
                        "{{{:02X}{:02X}{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}{:02X}{:02X}{:02X}{:02X}}}",
                        b[3], b[2], b[1], b[0], // Data1 LE
                        b[5], b[4],             // Data2 LE
                        b[7], b[6],             // Data3 LE
                        b[8], b[9],             // Data4[0..1]
                        b[10], b[11], b[12], b[13], b[14], b[15], // Data4[2..7]
                    );
                    let display_name = get_desktop_name_from_registry(&guid_str)
                        .unwrap_or_else(|| format!("Desktop {}", i + 1));
                    desktops.push(serde_json::json!({
                        "id": guid_str,
                        "name": display_name,
                    }));
                }
            }

            // Fallback: try Desktops subkey (some Win11 builds use this)
            if desktops.is_empty() {
                let desktops_path = format!("{}\\Desktops", path);
                let wide_dp: Vec<u16> = desktops_path.encode_utf16().chain(std::iter::once(0)).collect();
                let mut dk = HKEY::default();
                let status = RegOpenKeyExW(
                    HKEY_CURRENT_USER,
                    windows::core::PCWSTR(wide_dp.as_ptr()),
                    0,
                    KEY_READ,
                    &mut dk,
                );
                if status.is_ok() {
                    let mut index = 0u32;
                    loop {
                        let mut name_buf = [0u16; 256];
                        let mut name_len = name_buf.len() as u32;
                        let status = RegEnumKeyExW(
                            dk,
                            index,
                            windows::core::PWSTR(name_buf.as_mut_ptr()),
                            &mut name_len,
                            None,
                            windows::core::PWSTR::null(),
                            None,
                            None,
                        );
                        if status.is_err() { break; }
                        let guid_str = String::from_utf16_lossy(&name_buf[..name_len as usize]);
                        let display_name = get_desktop_name_from_registry(&guid_str)
                            .unwrap_or_else(|| format!("Desktop {}", index + 1));
                        desktops.push(serde_json::json!({
                            "id": guid_str,
                            "name": display_name,
                        }));
                        index += 1;
                    }
                    let _ = RegCloseKey(dk);
                }
            }

            let _ = RegCloseKey(key);
        }
        desktops
    }

    // ── Get current desktop ID from registry ─────────────────────────────

    fn get_current_desktop_id_from_registry() -> Option<String> {
        use windows::Win32::System::Registry::*;
        let path = "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VirtualDesktops";
        let wide_path: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let wide_name: Vec<u16> = "CurrentVirtualDesktop".encode_utf16().chain(std::iter::once(0)).collect();

        unsafe {
            let mut key = HKEY::default();
            let status = RegOpenKeyExW(
                HKEY_CURRENT_USER,
                windows::core::PCWSTR(wide_path.as_ptr()),
                0,
                KEY_READ,
                &mut key,
            );
            if status.is_err() {
                return None;
            }

            // CurrentVirtualDesktop is a REG_BINARY containing a 16-byte GUID
            let mut buf = [0u8; 16];
            let mut size = 16u32;
            let mut kind = REG_VALUE_TYPE::default();
            let status = RegQueryValueExW(
                key,
                windows::core::PCWSTR(wide_name.as_ptr()),
                None,
                Some(&mut kind),
                Some(buf.as_mut_ptr()),
                Some(&mut size),
            );
            let _ = RegCloseKey(key);

            if status.is_err() || size < 16 {
                return None;
            }

            // Format as GUID string {xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}
            let guid = format!(
                "{{{:02X}{:02X}{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}{:02X}{:02X}{:02X}{:02X}}}",
                buf[3], buf[2], buf[1], buf[0],
                buf[5], buf[4],
                buf[7], buf[6],
                buf[8], buf[9],
                buf[10], buf[11], buf[12], buf[13], buf[14], buf[15],
            );
            Some(guid)
        }
    }

    // ── Public NAPI functions ────────────────────────────────────────────

    #[napi]
    pub fn list_spaces() -> napi::Result<serde_json::Value> {
        let desktops = enumerate_desktops_from_registry();
        let current_id = get_current_desktop_id_from_registry();

        if desktops.is_empty() {
            // Single desktop fallback (Server or no VD configured)
            return Ok(serde_json::json!({
                "supported": true,
                "active_space_id": current_id,
                "displays": [{
                    "display_id": "main",
                    "spaces": [{ "id": 0, "type": 0, "uuid": current_id.unwrap_or_default(), "name": "Desktop 1" }],
                }],
            }));
        }

        let spaces: Vec<serde_json::Value> = desktops.iter().enumerate().map(|(i, d)| {
            serde_json::json!({
                "id": i,
                "type": 0,
                "uuid": d.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                "name": d.get("name").and_then(|v| v.as_str()).unwrap_or(""),
            })
        }).collect();

        Ok(serde_json::json!({
            "supported": true,
            "active_space_id": current_id,
            "displays": [{
                "display_id": "main",
                "spaces": spaces,
            }],
        }))
    }

    #[napi]
    pub fn get_active_space() -> napi::Result<serde_json::Value> {
        match get_current_desktop_id_from_registry() {
            Some(id) => Ok(serde_json::json!(id)),
            None => Ok(serde_json::json!(null)),
        }
    }

    #[napi]
    pub fn create_agent_space() -> napi::Result<serde_json::Value> {
        Ok(serde_json::json!({
            "supported": false,
            "reason": "virtual_desktop_creation_requires_internal_com_interface",
        }))
    }

    #[napi]
    pub fn move_window_to_space(_window_id: u32, _space_id: i64) -> napi::Result<serde_json::Value> {
        Ok(serde_json::json!({
            "moved": false,
            "reason": "virtual_desktop_window_move_requires_internal_com_interface",
        }))
    }

    #[napi]
    pub fn remove_window_from_space(_window_id: u32, _space_id: i64) -> napi::Result<serde_json::Value> {
        Ok(serde_json::json!({ "removed": false, "reason": "not_supported_on_windows" }))
    }

    #[napi]
    pub fn destroy_space(_space_id: i64) -> napi::Result<serde_json::Value> {
        Ok(serde_json::json!({ "destroyed": false, "reason": "not_supported_on_windows" }))
    }
}
