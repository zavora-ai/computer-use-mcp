// ── macOS: clipboard handled in session layer via pbcopy/pbpaste ─────────────
// No native clipboard functions needed on macOS.

// ── Linux implementation ─────────────────────────────────────────────────────
#[cfg(target_os = "linux")]
mod linux {
    use napi_derive::napi;
    use std::process::Command;
    use std::sync::OnceLock;

    static IS_WAYLAND: OnceLock<bool> = OnceLock::new();

    fn is_wayland() -> bool {
        *IS_WAYLAND.get_or_init(|| {
            std::env::var("XDG_SESSION_TYPE").map(|v| v == "wayland").unwrap_or(false)
        })
    }

    #[napi]
    pub fn read_clipboard() -> napi::Result<String> {
        let output = if is_wayland() {
            Command::new("wl-paste").args(["--no-newline"]).output()
                .or_else(|_| Command::new("xclip").args(["-selection", "clipboard", "-o"]).output())
        } else {
            Command::new("xclip").args(["-selection", "clipboard", "-o"]).output()
                .or_else(|_| Command::new("xsel").args(["--clipboard", "--output"]).output())
        };
        let output = output.map_err(|e| napi::Error::from_reason(
            format!("clipboard read failed (install wl-clipboard or xclip): {e}")))?;
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    #[napi]
    pub fn write_clipboard(text: String) -> napi::Result<()> {
        if is_wayland() {
            // wl-copy works best with text as argument
            let status = Command::new("wl-copy").arg(&text).status()
                .map_err(|e| napi::Error::from_reason(format!("wl-copy failed: {e}")))?;
            if status.success() { return Ok(()); }
        }
        // X11 fallback: pipe to xclip
        use std::io::Write;
        let child = Command::new("xclip").args(["-selection", "clipboard"])
            .stdin(std::process::Stdio::piped()).spawn()
            .or_else(|_| Command::new("xsel").args(["--clipboard", "--input"]).stdin(std::process::Stdio::piped()).spawn());
        let mut child = child.map_err(|e| napi::Error::from_reason(
            format!("clipboard write failed (install wl-clipboard or xclip): {e}")))?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(text.as_bytes()).map_err(|e| napi::Error::from_reason(format!("write: {e}")))?;
        }
        child.wait().map_err(|e| napi::Error::from_reason(format!("wait: {e}")))?;
        Ok(())
    }
}

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
