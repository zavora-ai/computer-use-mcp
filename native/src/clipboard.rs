// ── macOS: clipboard handled in session layer via pbcopy/pbpaste ─────────────
// No native clipboard functions needed on macOS.

// ── Windows implementation ───────────────────────────────────────────────────
#[cfg(target_os = "windows")]
mod win {
    use napi_derive::napi;
    use windows::Win32::Foundation::*;
    use windows::Win32::System::DataExchange::*;
    use windows::Win32::System::Memory::*;
    use windows::Win32::System::Ole::CF_UNICODETEXT;

    const MAX_RETRIES: u32 = 3;
    const RETRY_DELAY_MS: u64 = 50;

    #[napi]
    pub fn read_clipboard() -> napi::Result<String> {
        unsafe {
            for attempt in 0..MAX_RETRIES {
                if OpenClipboard(HWND::default()).is_ok() {
                    let handle = GetClipboardData(CF_UNICODETEXT.0 as u32);
                    let text = match handle {
                        Ok(h) if !h.0.is_null() => {
                            let ptr = GlobalLock(HGLOBAL(h.0)) as *const u16;
                            if ptr.is_null() {
                                String::new()
                            } else {
                                let mut len = 0;
                                while *ptr.add(len) != 0 {
                                    len += 1;
                                }
                                let slice = std::slice::from_raw_parts(ptr, len);
                                let s = String::from_utf16_lossy(slice);
                                let _ = GlobalUnlock(HGLOBAL(h.0));
                                s
                            }
                        }
                        _ => String::new(),
                    };
                    let _ = CloseClipboard();
                    return Ok(text);
                }
                if attempt < MAX_RETRIES - 1 {
                    std::thread::sleep(std::time::Duration::from_millis(RETRY_DELAY_MS));
                }
            }
            Err(napi::Error::from_reason(
                "clipboard_locked: could not open clipboard after 3 retries",
            ))
        }
    }

    #[napi]
    pub fn write_clipboard(text: String) -> napi::Result<()> {
        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let byte_len = wide.len() * 2;

        unsafe {
            for attempt in 0..MAX_RETRIES {
                if OpenClipboard(HWND::default()).is_ok() {
                    let _ = EmptyClipboard();
                    let hmem = GlobalAlloc(GMEM_MOVEABLE, byte_len)
                        .map_err(|e| napi::Error::from_reason(format!("GlobalAlloc: {e}")))?;
                    let ptr = GlobalLock(hmem) as *mut u16;
                    if ptr.is_null() {
                        let _ = GlobalFree(hmem);
                        let _ = CloseClipboard();
                        return Err(napi::Error::from_reason("GlobalLock returned null"));
                    }
                    std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr, wide.len());
                    let _ = GlobalUnlock(hmem);
                    let _ = SetClipboardData(CF_UNICODETEXT.0 as u32, HANDLE(hmem.0));
                    let _ = CloseClipboard();
                    return Ok(());
                }
                if attempt < MAX_RETRIES - 1 {
                    std::thread::sleep(std::time::Duration::from_millis(RETRY_DELAY_MS));
                }
            }
            Err(napi::Error::from_reason(
                "clipboard_locked: could not open clipboard after 3 retries",
            ))
        }
    }
}
