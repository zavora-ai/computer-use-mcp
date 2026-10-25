//! External tools on Linux (7.7.0, L1 and L2).
//!
//! Every shell-out goes through here so that a child never inherits this process's stdout, which is the MCP channel
//! (a tool that prints would corrupt JSON-RPC), and so that a missing tool is a named error with the package to install
//! rather than an empty result or a silent success.

use std::io::{ErrorKind, Read};
use std::process::{Child, Command, ExitStatus, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

/// How long any tool may run before it is stopped (7.7.0). None of these tools legitimately takes this long; the
/// limit is there so one that waits for something that never comes cannot hold the server forever.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);

/// What to install for a tool, for the error message.
pub fn install_hint(tool: &str) -> &'static str {
    match tool {
        "xdotool" => "install xdotool (apt install xdotool / dnf install xdotool)",
        "ydotool" => "install ydotool and start its daemon (ydotoold) with access to /dev/uinput",
        "wmctrl" => "install wmctrl (apt install wmctrl / dnf install wmctrl)",
        "xclip" => "install xclip (apt install xclip), or wl-clipboard on Wayland",
        "wl-copy" | "wl-paste" => "install wl-clipboard (apt install wl-clipboard)",
        "scrot" => "install scrot (apt install scrot), or use an X11 session",
        "grim" => "install grim (wlroots compositors such as sway)",
        "gnome-screenshot" => "install gnome-screenshot",
        _ => "install it with your package manager",
    }
}

/// Run `tool args…` with stdin closed and output captured. A tool that is not installed is an error naming it.
pub fn output(tool: &str, args: &[&str]) -> napi::Result<Output> {
    output_within(tool, args, DEFAULT_TIMEOUT)
}

/// `output`, stopping the tool if it has not finished within `limit` (7.7.0). ImageMagick's `import -window root`
/// never returned under xfwm4 on Xvfb, and the CI job sat on it for hours until a later push cancelled the run.
pub fn output_within(tool: &str, args: &[&str], limit: Duration) -> napi::Result<Output> {
    let mut child = Command::new(tool)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            if error.kind() == ErrorKind::NotFound {
                napi::Error::from_reason(format!("{tool} is not installed: {}", install_hint(tool)))
            } else {
                napi::Error::from_reason(format!("{tool} could not start: {error}"))
            }
        })?;
    // Drain both pipes while waiting, so a tool that writes more than a pipe holds cannot block on a full pipe.
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    let status = wait_within(&mut child, limit).map_err(|error| napi::Error::from_reason(format!("{tool}: {error}")))?;
    let Some(status) = status else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(napi::Error::from_reason(format!(
            "{tool} did not finish within {} s and was stopped",
            limit.as_secs()
        )));
    };
    Ok(Output { status, stdout: stdout.join().unwrap_or_default(), stderr: stderr.join().unwrap_or_default() })
}

fn drain(pipe: Option<impl Read + Send + 'static>) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut bytes);
        }
        bytes
    })
}

/// The exit status, or None if the child is still running when `limit` has passed.
fn wait_within(child: &mut Child, limit: Duration) -> std::io::Result<Option<ExitStatus>> {
    let deadline = Instant::now() + limit;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        thread::sleep(Duration::from_millis(10));
    }
}

/// Run a tool that must succeed; a non-zero exit is an error carrying its stderr.
pub fn run(tool: &str, args: &[&str]) -> napi::Result<Output> {
    run_within(tool, args, DEFAULT_TIMEOUT)
}

/// `run` with its own time limit.
pub fn run_within(tool: &str, args: &[&str], limit: Duration) -> napi::Result<Output> {
    let result = output_within(tool, args, limit)?;
    if result.status.success() {
        Ok(result)
    } else {
        let stderr = String::from_utf8_lossy(&result.stderr);
        let detail = stderr.trim();
        Err(napi::Error::from_reason(format!(
            "{tool} failed ({}){}",
            result.status,
            if detail.is_empty() { String::new() } else { format!(": {}", detail.chars().take(300).collect::<String>()) }
        )))
    }
}

/// Is the tool on PATH (it can be started)?
pub fn available(tool: &str) -> bool {
    Command::new(tool)
        .arg("--help")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::{install_hint, output, output_within, run};
    use std::time::{Duration, Instant};

    #[test]
    fn a_tool_that_never_finishes_is_stopped_at_its_limit() {
        let started = Instant::now();
        let error = output_within("sleep", &["30"], Duration::from_millis(300)).unwrap_err();
        assert!(error.reason.contains("did not finish within"), "{}", error.reason);
        assert!(started.elapsed() < Duration::from_secs(5), "stopped after {:?}", started.elapsed());
    }

    #[test]
    fn a_missing_tool_is_named_with_what_to_install() {
        let error = output("computer-use-mcp-no-such-tool", &[]).unwrap_err();
        assert!(error.reason.contains("computer-use-mcp-no-such-tool is not installed"));
        assert!(install_hint("xdotool").contains("xdotool"));
    }

    #[test]
    fn a_failing_tool_is_an_error_and_its_output_never_reaches_our_stdout() {
        let error = run("sh", &["-c", "echo not-on-our-stdout; echo broke >&2; exit 3"]).unwrap_err();
        assert!(error.reason.contains("broke"), "{}", error.reason);
        let ok = run("sh", &["-c", "echo captured"]).unwrap();
        assert_eq!(String::from_utf8_lossy(&ok.stdout).trim(), "captured");
    }
}
