//! Linux windows and the backends behind them (7.7.0, L1, L2, K7).
//!
//! Window listing was GNOME Shell's `Eval` (disabled since GNOME 41 unless the shell runs in unsafe mode) with a
//! `wmctrl -l -p` fallback that reported every window at 0,0 sized 0x0 and returned an empty list when wmctrl was
//! missing. Now each session type has its own backend: `swaymsg` on sway, `hyprctl` on Hyprland, `Eval` where GNOME
//! still allows it, and `wmctrl -l -p -G` on X11 (and XWayland), with real geometry. A missing tool is a named error.
//! Every shell-out goes through `linux_tools`, so no child writes to the MCP channel.
//!
//! The parsers are plain functions compiled on every platform so their tests run everywhere.

#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use serde_json::{json, Value};

/// One window as every backend reports it: the shape `list_windows` returns.
#[derive(Debug, Clone, PartialEq)]
pub struct LinuxWindow {
    pub id: u32,
    pub app: String,
    pub pid: i32,
    pub title: String,
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
    pub on_screen: bool,
    pub focused: bool,
    /// Hyprland addresses are 64-bit; `id` is their low 32 bits and this is the whole address.
    pub address: Option<String>,
}

impl LinuxWindow {
    pub fn to_json(&self) -> Value {
        json!({
            "windowId": self.id,
            "bundleId": self.app,
            "displayName": self.app,
            "pid": self.pid,
            "title": self.title,
            "bounds": { "x": self.x, "y": self.y, "width": self.width, "height": self.height },
            "isOnScreen": self.on_screen,
            "isFocused": self.focused,
            "displayId": 0,
        })
    }
}

/// `wmctrl -l -p -G`: `0x03a00007  0 2345   10   52   1280 720  host Title with  spaces`. The title is everything after
/// the eighth field, spacing kept. Desktop -1 is a sticky window (on every desktop).
pub fn parse_wmctrl_geometry(line: &str) -> Option<(u32, i64, i32, i64, i64, i64, i64, String)> {
    let mut rest = line;
    let mut fields: Vec<&str> = Vec::with_capacity(8);
    while fields.len() < 8 {
        rest = rest.trim_start();
        if rest.is_empty() {
            return None;
        }
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        fields.push(&rest[..end]);
        rest = &rest[end..];
    }
    let id = u32::from_str_radix(fields[0].trim_start_matches("0x"), 16).ok()?;
    let desktop = fields[1].parse::<i64>().ok()?;
    let pid = fields[2].parse::<i32>().unwrap_or(0);
    let x = fields[3].parse::<i64>().ok()?;
    let y = fields[4].parse::<i64>().ok()?;
    let width = fields[5].parse::<i64>().ok()?;
    let height = fields[6].parse::<i64>().ok()?;
    let title = rest.trim().to_string();
    Some((id, desktop, pid, x, y, width, height, title))
}

/// Why `wmctrl -l` failed.
#[derive(Debug, PartialEq, Eq)]
pub enum WmctrlFailure {
    /// The window manager runs but has not published a client list: some (xfwm4) publish it only once they manage a
    /// window, so this is an empty desktop, not an error.
    NoWindowsYet,
    /// No EWMH window manager answers on this display.
    NoWindowManager,
    Other,
}

pub fn classify_wmctrl_failure(output: &str, manager_running: bool) -> WmctrlFailure {
    if output.contains("Cannot get client list properties") {
        if manager_running {
            WmctrlFailure::NoWindowsYet
        } else {
            WmctrlFailure::NoWindowManager
        }
    } else {
        WmctrlFailure::Other
    }
}

/// `wmctrl -d`: the line whose second field is `*` is the current desktop.
pub fn parse_current_desktop(listing: &str) -> Option<i64> {
    listing.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let id = parts.next()?.parse::<i64>().ok()?;
        (parts.next() == Some("*")).then_some(id)
    })
}

/// `swaymsg -t get_tree -r`: every node with a pid is a window (tiled, floating or in the scratchpad).
pub fn parse_sway_tree(tree: &Value) -> Vec<LinuxWindow> {
    fn walk(node: &Value, out: &mut Vec<LinuxWindow>) {
        if let Some(pid) = node.get("pid").and_then(Value::as_i64) {
            let rect = &node["rect"];
            let app = node
                .get("app_id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .or_else(|| node["window_properties"]["class"].as_str())
                .unwrap_or("")
                .to_string();
            out.push(LinuxWindow {
                id: node["id"].as_u64().unwrap_or(0) as u32,
                app,
                pid: pid as i32,
                title: node["name"].as_str().unwrap_or("").to_string(),
                x: rect["x"].as_i64().unwrap_or(0),
                y: rect["y"].as_i64().unwrap_or(0),
                width: rect["width"].as_i64().unwrap_or(0),
                height: rect["height"].as_i64().unwrap_or(0),
                on_screen: node["visible"].as_bool().unwrap_or(false),
                focused: node["focused"].as_bool().unwrap_or(false),
                address: None,
            });
        }
        for key in ["nodes", "floating_nodes"] {
            if let Some(children) = node.get(key).and_then(Value::as_array) {
                for child in children {
                    walk(child, out);
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(tree, &mut out);
    out
}

/// `hyprctl clients -j`: `address` is a 64-bit hex string; the window id is its low 32 bits.
/// One monitor as a Wayland compositor reports it, in logical pixels (7.7.x: a Wayland session without XWayland has
/// no X display to ask for its size).
#[derive(Debug, Clone, PartialEq)]
pub struct Output {
    pub name: String,
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
    pub scale: f64,
}

/// `swaymsg -t get_outputs -r`: active outputs, `rect` already logical.
pub fn parse_sway_outputs(outputs: &Value) -> Vec<Output> {
    outputs
        .as_array()
        .into_iter()
        .flatten()
        .filter(|output| output["active"].as_bool().unwrap_or(true))
        .filter_map(|output| {
            let rect = &output["rect"];
            Some(Output {
                name: output["name"].as_str().unwrap_or_default().to_string(),
                x: rect["x"].as_i64()?,
                y: rect["y"].as_i64()?,
                width: rect["width"].as_i64()?,
                height: rect["height"].as_i64()?,
                scale: output["scale"].as_f64().filter(|scale| *scale > 0.0).unwrap_or(1.0),
            })
        })
        .collect()
}

/// `hyprctl monitors -j`: sizes are physical pixels, so divide by the scale for logical ones.
pub fn parse_hyprland_monitors(monitors: &Value) -> Vec<Output> {
    monitors
        .as_array()
        .into_iter()
        .flatten()
        .filter(|monitor| !monitor["disabled"].as_bool().unwrap_or(false))
        .filter_map(|monitor| {
            let scale = monitor["scale"].as_f64().filter(|scale| *scale > 0.0).unwrap_or(1.0);
            Some(Output {
                name: monitor["name"].as_str().unwrap_or_default().to_string(),
                x: monitor["x"].as_i64()?,
                y: monitor["y"].as_i64()?,
                width: (monitor["width"].as_f64()? / scale).round() as i64,
                height: (monitor["height"].as_f64()? / scale).round() as i64,
                scale,
            })
        })
        .collect()
}

/// The whole desktop the outputs span (the X11 answer is the same: the root window covers every monitor).
pub fn desktop_bounds(outputs: &[Output]) -> Option<(i64, i64, f64)> {
    let width = outputs.iter().map(|o| o.x + o.width).max()?;
    let height = outputs.iter().map(|o| o.y + o.height).max()?;
    let scale = outputs.iter().map(|o| o.scale).fold(1.0, f64::max);
    Some((width, height, scale))
}

pub fn parse_hyprland_clients(clients: &Value) -> Vec<LinuxWindow> {
    clients
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|client| {
                    let address = client["address"].as_str()?.to_string();
                    let full = u64::from_str_radix(address.trim_start_matches("0x"), 16).ok()?;
                    let at = client["at"].as_array();
                    let size = client["size"].as_array();
                    let coordinate = |list: Option<&Vec<Value>>, index: usize| {
                        list.and_then(|values| values.get(index)).and_then(Value::as_i64).unwrap_or(0)
                    };
                    Some(LinuxWindow {
                        id: (full & 0xffff_ffff) as u32,
                        app: client["class"].as_str().unwrap_or("").to_string(),
                        pid: client["pid"].as_i64().unwrap_or(0) as i32,
                        title: client["title"].as_str().unwrap_or("").to_string(),
                        x: coordinate(at, 0),
                        y: coordinate(at, 1),
                        width: coordinate(size, 0),
                        height: coordinate(size, 1),
                        on_screen: !client["hidden"].as_bool().unwrap_or(false) && client["mapped"].as_bool().unwrap_or(true),
                        focused: client["focusHistoryID"].as_i64() == Some(0),
                        address: Some(address),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// GNOME Shell `Eval` replies `(true, '<json>')`; anything else (GNOME 41+ answers `(false, '')`) is no answer.
pub fn parse_gdbus_eval(reply: &str) -> Option<String> {
    let text = reply.trim();
    if !text.starts_with("(true,") {
        return None;
    }
    let start = text.find('\'')?;
    let end = text.rfind('\'')?;
    (start < end).then(|| text[start + 1..end].replace("\\'", "'"))
}

/// Keep windows of one app (case-insensitive), or all of them.
pub fn filter_app(windows: Vec<LinuxWindow>, app: &Option<String>) -> Vec<LinuxWindow> {
    match app {
        Some(wanted) => windows.into_iter().filter(|window| window.app.eq_ignore_ascii_case(wanted)).collect(),
        None => windows,
    }
}

#[cfg(target_os = "linux")]
pub use live::*;

#[cfg(target_os = "linux")]
mod live {
    use super::*;
    use crate::linux_tools;
    use std::time::{Duration, Instant};

    pub fn is_wayland() -> bool {
        std::env::var("XDG_SESSION_TYPE").map(|value| value == "wayland").unwrap_or(false)
            || std::env::var_os("WAYLAND_DISPLAY").is_some()
    }

    /// Which compositor this is, from the variables each one sets.
    pub fn compositor() -> &'static str {
        if std::env::var_os("SWAYSOCK").is_some() {
            return "sway";
        }
        if std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some() {
            return "hyprland";
        }
        let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default().to_lowercase();
        if desktop.contains("gnome") {
            "gnome"
        } else if desktop.contains("kde") {
            "kde"
        } else if is_wayland() {
            "wayland"
        } else {
            "x11"
        }
    }

    pub fn gnome_eval(js: &str) -> Option<String> {
        let output = linux_tools::output(
            "gdbus",
            &["call", "--session", "--dest", "org.gnome.Shell", "--object-path", "/org/gnome/Shell", "--method", "org.gnome.Shell.Eval", js],
        )
        .ok()?;
        parse_gdbus_eval(&String::from_utf8_lossy(&output.stdout))
    }

    const GNOME_WINDOWS: &str = r#"JSON.stringify(global.get_window_actors().map(a=>{let w=a.meta_window;let r=w.get_frame_rect();return{id:w.get_id(),app:w.get_wm_class()||'',pid:w.get_pid(),title:w.get_title()||'',x:r.x,y:r.y,width:r.width,height:r.height,onScreen:!w.minimized,focused:w.has_focus()}}))"#;

    fn gnome_windows() -> Option<Vec<LinuxWindow>> {
        let parsed: Value = serde_json::from_str(&gnome_eval(GNOME_WINDOWS)?).ok()?;
        Some(
            parsed
                .as_array()?
                .iter()
                .map(|w| LinuxWindow {
                    id: w["id"].as_u64().unwrap_or(0) as u32,
                    app: w["app"].as_str().unwrap_or("").to_string(),
                    pid: w["pid"].as_i64().unwrap_or(0) as i32,
                    title: w["title"].as_str().unwrap_or("").to_string(),
                    x: w["x"].as_i64().unwrap_or(0),
                    y: w["y"].as_i64().unwrap_or(0),
                    width: w["width"].as_i64().unwrap_or(0),
                    height: w["height"].as_i64().unwrap_or(0),
                    on_screen: w["onScreen"].as_bool().unwrap_or(true),
                    focused: w["focused"].as_bool().unwrap_or(false),
                    address: None,
                })
                .collect(),
        )
    }

    /// The monitors of a Wayland compositor that can report them (sway, Hyprland).
    pub fn outputs() -> napi::Result<Vec<Output>> {
        let outputs = match compositor() {
            "sway" => parse_sway_outputs(&json_from("swaymsg", &["-t", "get_outputs", "-r"])?),
            "hyprland" => parse_hyprland_monitors(&json_from("hyprctl", &["monitors", "-j"])?),
            other => {
                return Err(napi::Error::from_reason(format!(
                    "Cannot open the X display, and the screen size of this {other} session cannot be read without one \
                     (sway and Hyprland can report it; elsewhere XWayland is needed)"
                )))
            }
        };
        if outputs.is_empty() {
            return Err(napi::Error::from_reason("The compositor reports no active output"));
        }
        Ok(outputs)
    }

    fn json_from(tool: &str, args: &[&str]) -> napi::Result<Value> {
        let output = linux_tools::run(tool, args)?;
        serde_json::from_slice(&output.stdout)
            .map_err(|error| napi::Error::from_reason(format!("{tool} returned unreadable JSON: {error}")))
    }

    fn sway_windows() -> napi::Result<Vec<LinuxWindow>> {
        let output = linux_tools::run("swaymsg", &["-t", "get_tree", "-r"])?;
        let tree: Value = serde_json::from_slice(&output.stdout)
            .map_err(|error| napi::Error::from_reason(format!("swaymsg returned unreadable JSON: {error}")))?;
        Ok(parse_sway_tree(&tree))
    }

    fn hyprland_windows() -> napi::Result<Vec<LinuxWindow>> {
        let output = linux_tools::run("hyprctl", &["clients", "-j"])?;
        let clients: Value = serde_json::from_slice(&output.stdout)
            .map_err(|error| napi::Error::from_reason(format!("hyprctl returned unreadable JSON: {error}")))?;
        Ok(parse_hyprland_clients(&clients))
    }

    fn process_name(pid: i32) -> String {
        std::fs::read_to_string(format!("/proc/{pid}/comm")).unwrap_or_default().trim().to_string()
    }

    /// X11, or XWayland windows on a Wayland session: `wmctrl -l -p -G` with real geometry. The app is the process
    /// name, as before.
    fn wmctrl_windows() -> napi::Result<Vec<LinuxWindow>> {
        let listing = linux_tools::output("wmctrl", &["-l", "-p", "-G"])?;
        if !listing.status.success() {
            let said = format!("{}{}", String::from_utf8_lossy(&listing.stdout), String::from_utf8_lossy(&listing.stderr));
            let manager_running = linux_tools::output("wmctrl", &["-m"]).map(|o| o.status.success()).unwrap_or(false);
            return match classify_wmctrl_failure(&said, manager_running) {
                WmctrlFailure::NoWindowsYet => Ok(Vec::new()),
                WmctrlFailure::NoWindowManager => Err(napi::Error::from_reason(
                    "No window manager is running on this display: window listing (wmctrl) needs one that follows EWMH",
                )),
                WmctrlFailure::Other => Err(napi::Error::from_reason(format!(
                    "wmctrl failed ({}): {}",
                    listing.status,
                    said.trim().chars().take(300).collect::<String>()
                ))),
            };
        }
        let current = linux_tools::output("wmctrl", &["-d"])
            .ok()
            .and_then(|output| parse_current_desktop(&String::from_utf8_lossy(&output.stdout)));
        let active = linux_tools::output("xdotool", &["getactivewindow"])
            .ok()
            .and_then(|output| String::from_utf8_lossy(&output.stdout).trim().parse::<u32>().ok())
            .unwrap_or(0);
        Ok(String::from_utf8_lossy(&listing.stdout)
            .lines()
            .filter_map(parse_wmctrl_geometry)
            .map(|(id, desktop, pid, x, y, width, height, title)| LinuxWindow {
                id,
                app: process_name(pid),
                pid,
                title,
                x,
                y,
                width,
                height,
                on_screen: desktop == -1 || current.map(|current| current == desktop).unwrap_or(true),
                focused: id == active,
                address: None,
            })
            .collect())
    }

    /// The windows, and the backend that listed them (for `doctor`).
    pub fn list(app: &Option<String>) -> napi::Result<(Vec<LinuxWindow>, &'static str)> {
        let windows = match compositor() {
            "sway" => (sway_windows()?, "swaymsg"),
            "hyprland" => (hyprland_windows()?, "hyprctl"),
            "gnome" => match gnome_windows() {
                Some(windows) => (windows, "gnome-shell-eval"),
                // GNOME 41 and later refuse Eval: XWayland windows are what is left to list.
                None if is_wayland() => (wmctrl_windows().map_err(|error| {
                    napi::Error::from_reason(format!(
                        "{} (GNOME on Wayland no longer lets other programs list its windows through Shell.Eval, so only XWayland windows can be listed)",
                        error.reason
                    ))
                })?, "wmctrl-xwayland"),
                None => (wmctrl_windows()?, "wmctrl"),
            },
            _ if is_wayland() => (wmctrl_windows()?, "wmctrl-xwayland"),
            _ => (wmctrl_windows()?, "wmctrl"),
        };
        Ok((filter_app(windows.0, app), windows.1))
    }

    pub fn find(window_id: u32) -> napi::Result<Option<LinuxWindow>> {
        Ok(list(&None)?.0.into_iter().find(|window| window.id == window_id))
    }

    fn focused_id() -> Option<u32> {
        list(&None).ok()?.0.into_iter().find(|window| window.focused).map(|window| window.id)
    }

    /// Bring a window to the front and wait (up to `timeout`) until it is focused.
    pub fn activate(window_id: u32, timeout: Duration) -> napi::Result<bool> {
        let window = find(window_id)?;
        match compositor() {
            "sway" => {
                linux_tools::run("swaymsg", &[&format!("[con_id={window_id}]"), "focus"])?;
            }
            "hyprland" => {
                let Some(address) = window.as_ref().and_then(|window| window.address.clone()) else { return Ok(false) };
                linux_tools::run("hyprctl", &["dispatch", "focuswindow", &format!("address:{address}")])?;
            }
            "gnome" if is_wayland() && gnome_eval("'ok'").is_some() => {
                let js = format!(
                    "let w=global.get_window_actors().map(a=>a.meta_window).find(w=>w.get_id()==={window_id});if(w){{w.activate(global.get_current_time());'true'}}else{{'false'}}"
                );
                return Ok(gnome_eval(&js).as_deref() == Some("true"));
            }
            _ => {
                // No --sync: it waits for ever on a window manager that does not comply. The poll below bounds it.
                linux_tools::run("xdotool", &["windowactivate", &window_id.to_string()])?;
            }
        }
        let deadline = Instant::now() + timeout;
        loop {
            if focused_id() == Some(window_id) {
                return Ok(true);
            }
            if Instant::now() >= deadline {
                return Ok(false);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// The window and screenshot backends this session would use, for `doctor`.
    pub fn backends() -> Value {
        // The order screenshot.rs tries them in: grim only works on Wayland (wlroots), scrot and import only on X11.
        let tools: &[&str] = if is_wayland() { &["grim", "gnome-screenshot"] } else { &["scrot", "gnome-screenshot", "import"] };
        let screenshot = tools.iter().copied().find(|tool| linux_tools::available(tool));
        // 7.7.x: the route input really takes (libei, ydotool, XTEST), not just which tools are installed.
        let route = crate::linux_ei::route();
        let input = match route {
            crate::linux_ei::Route::Unavailable(_) => None,
            ref route => Some(route.name()),
        };
        json!({
            "session": if is_wayland() { "wayland" } else { "x11" },
            "compositor": compositor(),
            "windowList": list(&None).map(|(_, backend)| Value::from(backend)).unwrap_or_else(|error| json!({ "error": error.reason })),
            "screenshot": screenshot,
            "screenshotPortal": is_wayland() && linux_tools::available("python3"),
            "input": input,
            "inputDetail": crate::linux_ei::describe(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wmctrl_geometry_lines_keep_their_titles_and_real_bounds() {
        let parsed = parse_wmctrl_geometry("0x03a00007  0 2345   10   52   1280 720  host  Untitled  -  Text Editor").unwrap();
        assert_eq!(parsed, (0x03a00007, 0, 2345, 10, 52, 1280, 720, " Untitled  -  Text Editor".trim_start().to_string()));
        let sticky = parse_wmctrl_geometry("0x01e00003 -1 811    0    0    1920 32   host Top Bar").unwrap();
        assert_eq!(sticky.1, -1);
        assert_eq!(sticky.7, "Top Bar");
        let untitled = parse_wmctrl_geometry("0x01e00004  1 812 5 6 7 8 host").unwrap();
        assert_eq!(untitled.7, "");
        assert!(parse_wmctrl_geometry("0x01e00004  1 812").is_none());
        assert!(parse_wmctrl_geometry("").is_none());
    }

    #[test]
    fn wayland_outputs_give_the_screen_size_without_an_x_display() {
        let sway = serde_json::json!([
            { "name": "HEADLESS-1", "active": true, "scale": 1.0, "rect": { "x": 0, "y": 0, "width": 1600, "height": 1000 } },
            { "name": "DP-2", "active": true, "scale": 2.0, "rect": { "x": 1600, "y": 0, "width": 1280, "height": 720 } },
            { "name": "off", "active": false, "rect": { "x": 0, "y": 0, "width": 9999, "height": 9999 } },
        ]);
        let outputs = parse_sway_outputs(&sway);
        assert_eq!(outputs.len(), 2);
        assert_eq!(desktop_bounds(&outputs), Some((2880, 1000, 2.0)));
        let hyprland = serde_json::json!([
            { "name": "eDP-1", "x": 0, "y": 0, "width": 2880, "height": 1800, "scale": 2.0, "disabled": false },
        ]);
        let monitors = parse_hyprland_monitors(&hyprland);
        assert_eq!((monitors[0].width, monitors[0].height), (1440, 900));
        assert_eq!(desktop_bounds(&[]), None);
    }

    #[test]
    fn an_empty_desktop_lists_no_windows_and_a_missing_window_manager_says_so() {
        let said = "Cannot get client list properties. \n(_NET_CLIENT_LIST or _WIN_CLIENT_LIST)\n";
        assert_eq!(classify_wmctrl_failure(said, true), WmctrlFailure::NoWindowsYet);
        assert_eq!(classify_wmctrl_failure(said, false), WmctrlFailure::NoWindowManager);
        assert_eq!(classify_wmctrl_failure("Cannot open display.", true), WmctrlFailure::Other);
    }

    #[test]
    fn the_current_desktop_is_the_starred_line() {
        assert_eq!(parse_current_desktop("0  - DG: 1920x1080  VP: 0,0  WA: 0,0 1920x1080  One\n1  * DG: 1920x1080  VP: 0,0  WA: 0,0 1920x1080  Two\n"), Some(1));
        assert_eq!(parse_current_desktop(""), None);
    }

    #[test]
    fn sway_windows_come_from_tiled_and_floating_nodes() {
        let tree = serde_json::json!({
            "id": 1, "type": "root", "nodes": [{ "id": 2, "type": "output", "nodes": [{ "id": 3, "type": "workspace",
                "nodes": [{ "id": 10, "pid": 400, "app_id": "foot", "name": "~", "focused": true, "visible": true,
                    "rect": { "x": 0, "y": 30, "width": 960, "height": 1050 } }],
                "floating_nodes": [{ "id": 11, "pid": 401, "app_id": null, "window_properties": { "class": "Firefox" },
                    "name": "Mozilla Firefox", "focused": false, "visible": false,
                    "rect": { "x": 100, "y": 100, "width": 800, "height": 600 } }] }] }],
        });
        let windows = parse_sway_tree(&tree);
        assert_eq!(windows.len(), 2);
        assert_eq!((windows[0].id, windows[0].app.as_str(), windows[0].focused, windows[0].width), (10, "foot", true, 960));
        assert_eq!((windows[1].app.as_str(), windows[1].on_screen, windows[1].x), ("Firefox", false, 100));
    }

    #[test]
    fn hyprland_addresses_become_32_bit_ids_and_keep_the_address() {
        let clients = serde_json::json!([
            { "address": "0x55d5c2f1a2b0", "class": "kitty", "title": "zsh", "pid": 900, "at": [10, 40], "size": [800, 600],
              "hidden": false, "mapped": true, "focusHistoryID": 0 },
            { "address": "0x55d5c2f1c3d0", "class": "firefox", "title": "Home", "pid": 901, "at": [820, 40], "size": [1080, 1000],
              "hidden": true, "mapped": true, "focusHistoryID": 1 },
            { "class": "broken" },
        ]);
        let windows = parse_hyprland_clients(&clients);
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].id, 0xc2f1_a2b0);
        assert_eq!(windows[0].address.as_deref(), Some("0x55d5c2f1a2b0"));
        assert!(windows[0].focused && windows[0].on_screen);
        assert!(!windows[1].focused && !windows[1].on_screen);
        assert_eq!((windows[1].x, windows[1].height), (820, 1000));
    }

    #[test]
    fn gnome_eval_answers_only_when_the_shell_allows_it() {
        assert_eq!(parse_gdbus_eval("(true, '[{\"id\":1}]')\n").as_deref(), Some("[{\"id\":1}]"));
        assert_eq!(parse_gdbus_eval("(false, '')"), None);
        assert_eq!(parse_gdbus_eval(""), None);
    }

    #[test]
    fn the_app_filter_ignores_case() {
        let window = LinuxWindow {
            id: 1, app: "Gedit".into(), pid: 1, title: String::new(), x: 0, y: 0, width: 1, height: 1,
            on_screen: true, focused: false, address: None,
        };
        assert_eq!(filter_app(vec![window.clone()], &Some("gedit".into())).len(), 1);
        assert_eq!(filter_app(vec![window], &Some("kate".into())).len(), 0);
    }
}
