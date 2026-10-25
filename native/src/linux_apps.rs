//! Launching Linux applications from their desktop entries (7.7.x).
//!
//! `open_application` on Linux could only focus an app that already had a window, so "open Firefox" with Firefox closed
//! failed with `not_running`. An installed app is described by a `.desktop` file in the XDG data directories (snap and
//! Flatpak add their own), and `gio launch` starts one the way the desktop does: the entry's own command, environment and
//! startup notification, never a command line built from the model's text.
//!
//! The parsing and matching are plain functions compiled on every platform so their tests run everywhere.

#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::path::{Path, PathBuf};

/// The fields of a desktop entry's `[Desktop Entry]` group that launching needs.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DesktopEntry {
    pub id: String,
    pub name: String,
    pub exec: String,
    pub hidden: bool,
    pub no_display: bool,
    pub application: bool,
}

impl DesktopEntry {
    /// The program the entry runs, as a process name: the basename of the first word of `Exec`, past `env VAR=…`.
    pub fn program(&self) -> Option<String> {
        let mut words = self.exec.split_whitespace();
        let mut first = words.next()?;
        if Path::new(first).file_name().and_then(|n| n.to_str()) == Some("env") {
            first = words.find(|word| !word.contains('='))?;
        }
        let name = Path::new(first.trim_matches('"')).file_name()?.to_str()?.to_string();
        (!name.is_empty()).then_some(name)
    }
}

/// Parse the `[Desktop Entry]` group; other groups (actions) are ignored, and so are localised keys.
pub fn parse_desktop_entry(id: &str, text: &str) -> DesktopEntry {
    let mut entry = DesktopEntry { id: id.to_string(), ..Default::default() };
    let mut in_main = false;
    for line in text.lines().map(str::trim) {
        if line.starts_with('[') {
            in_main = line == "[Desktop Entry]";
            continue;
        }
        if !in_main {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        let value = value.trim();
        match key.trim() {
            "Name" => entry.name = value.to_string(),
            "Exec" => entry.exec = value.to_string(),
            "Type" => entry.application = value == "Application",
            "Hidden" => entry.hidden = value.eq_ignore_ascii_case("true"),
            "NoDisplay" => entry.no_display = value.eq_ignore_ascii_case("true"),
            _ => {}
        }
    }
    entry
}

/// How well an entry matches what the caller asked for; lower is better, `None` is no match. In order: the desktop id
/// (`firefox`, `firefox.desktop`), the id's last part (snap `firefox_firefox`, Flatpak `org.mozilla.firefox`), the
/// program it runs, its name. An entry hidden from menus ranks after a visible one.
pub fn match_rank(entry: &DesktopEntry, query: &str) -> Option<u32> {
    if !entry.application || entry.hidden || entry.exec.is_empty() {
        return None;
    }
    let query = query.trim().trim_end_matches(".desktop").to_lowercase();
    if query.is_empty() {
        return None;
    }
    let id = entry.id.to_lowercase();
    let rank = if id == query {
        0
    } else if id.rsplit(['_', '.']).next() == Some(query.as_str()) {
        1
    } else if entry.program().map(|program| program.to_lowercase()) == Some(query.clone()) {
        2
    } else if entry.name.to_lowercase() == query {
        3
    } else {
        return None;
    };
    Some(rank * 2 + u32::from(entry.no_display))
}

/// The `applications` directories, most specific first: `XDG_DATA_HOME`, then `XDG_DATA_DIRS`, then where snap and
/// Flatpak export entries when the session did not list them.
pub fn application_dirs(data_home: Option<&str>, data_dirs: Option<&str>, home: Option<&str>) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    match data_home.filter(|value| !value.is_empty()) {
        Some(value) => roots.push(PathBuf::from(value)),
        None => roots.extend(home.map(|home| Path::new(home).join(".local/share"))),
    }
    let dirs = data_dirs.filter(|value| !value.is_empty()).unwrap_or("/usr/local/share:/usr/share");
    roots.extend(dirs.split(':').filter(|dir| !dir.is_empty()).map(PathBuf::from));
    roots.push(PathBuf::from("/var/lib/snapd/desktop"));
    roots.push(PathBuf::from("/var/lib/flatpak/exports/share"));
    roots.extend(home.map(|home| Path::new(home).join(".local/share/flatpak/exports/share")));
    let mut seen = Vec::new();
    roots
        .into_iter()
        .map(|root| root.join("applications"))
        .filter(|dir| {
            let key = dir.to_string_lossy().trim_end_matches('/').to_string();
            let fresh = !seen.contains(&key);
            seen.push(key);
            fresh
        })
        .collect()
}

/// The best entry for `query` in `dirs` (and one level of subdirectories, whose ids join with `-`), with its path.
pub fn find_entry(query: &str, dirs: &[PathBuf]) -> Option<(PathBuf, DesktopEntry)> {
    let mut best: Option<(u32, PathBuf, DesktopEntry)> = None;
    let mut consider = |path: PathBuf, id: String| {
        let Ok(text) = std::fs::read_to_string(&path) else { return };
        if text.len() > 65_536 {
            return;
        }
        let entry = parse_desktop_entry(&id, &text);
        if let Some(rank) = match_rank(&entry, query) {
            if best.as_ref().map(|(current, _, _)| rank < *current).unwrap_or(true) {
                best = Some((rank, path, entry));
            }
        }
    };
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        for item in entries.flatten().take(5_000) {
            let path = item.path();
            let name = item.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                let Ok(inner) = std::fs::read_dir(&path) else { continue };
                for nested in inner.flatten().take(1_000) {
                    let nested_name = nested.file_name().to_string_lossy().to_string();
                    if let Some(stem) = nested_name.strip_suffix(".desktop") {
                        consider(nested.path(), format!("{name}-{stem}"));
                    }
                }
            } else if let Some(stem) = name.strip_suffix(".desktop") {
                consider(path, stem.to_string());
            }
        }
    }
    best.map(|(_, path, entry)| (path, entry))
}

#[cfg(target_os = "linux")]
mod live {
    use super::{application_dirs, find_entry};
    use napi_derive::napi;
    use std::process::{Command, Stdio};

    /// Start an installed app from its desktop entry. Returns at once (it does not wait for a window): the entry used,
    /// and the process name to look for. An app with no entry is `not_installed`.
    #[napi]
    pub fn launch_app(bundle_id: String) -> napi::Result<serde_json::Value> {
        crate::activity::ensure_not_emergency_stopped()?;
        let dirs = application_dirs(
            std::env::var("XDG_DATA_HOME").ok().as_deref(),
            std::env::var("XDG_DATA_DIRS").ok().as_deref(),
            std::env::var("HOME").ok().as_deref(),
        );
        let Some((path, entry)) = find_entry(&bundle_id, &dirs) else {
            return Ok(serde_json::json!({
                "launched": false, "reason": "not_installed", "bundleId": bundle_id,
                "searched": dirs.iter().map(|dir| dir.to_string_lossy().to_string()).collect::<Vec<_>>(),
            }));
        };
        // No pipes: the app inherits whatever the launcher has, and a pipe it held open would keep this call waiting
        // for the app to exit. stdout must never be inherited, because it is the MCP channel.
        let quiet = |command: &mut Command| {
            command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status()
        };
        let launcher = if crate::linux_tools::available("gio") {
            ("gio", quiet(Command::new("gio").arg("launch").arg(&path)))
        } else {
            ("gtk-launch", quiet(Command::new("gtk-launch").arg(&entry.id)))
        };
        match launcher.1 {
            Ok(status) if status.success() => Ok(serde_json::json!({
                "launched": true, "bundleId": bundle_id, "desktopEntry": path.to_string_lossy(), "desktopId": entry.id,
                "name": entry.name, "process": entry.program(), "launcher": launcher.0,
            })),
            Ok(status) => Err(napi::Error::from_reason(format!(
                "{} could not start {} ({status})", launcher.0, path.to_string_lossy()
            ))),
            Err(error) => Err(napi::Error::from_reason(format!(
                "cannot launch {}: neither gio (libglib2.0-bin) nor gtk-launch could run ({error})", entry.id
            ))),
        }
    }

    /// Is a process with this name running (its `comm`, or the basename of its first argument)?
    #[napi]
    pub fn linux_process_running(name: String) -> bool {
        let Ok(entries) = std::fs::read_dir("/proc") else { return false };
        let short: String = name.chars().take(15).collect();
        entries.flatten().any(|entry| {
            let path = entry.path();
            if !entry.file_name().to_string_lossy().chars().all(|c| c.is_ascii_digit()) {
                return false;
            }
            let comm = std::fs::read_to_string(path.join("comm")).unwrap_or_default();
            if comm.trim() == short {
                return true;
            }
            let cmdline = std::fs::read(path.join("cmdline")).unwrap_or_default();
            let first = cmdline.split(|byte| *byte == 0).next().unwrap_or_default();
            std::path::Path::new(&*String::from_utf8_lossy(first)).file_name().and_then(|n| n.to_str()) == Some(name.as_str())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIREFOX_SNAP: &str = "[Desktop Entry]\nVersion=1.0\nName=Firefox\nName[de]=Firefox\nExec=/snap/bin/firefox %u\nType=Application\n\n[Desktop Action new-window]\nName=New Window\nExec=/snap/bin/firefox --new-window %u\n";

    #[test]
    fn the_main_group_is_read_and_actions_are_not() {
        let entry = parse_desktop_entry("firefox_firefox", FIREFOX_SNAP);
        assert_eq!((entry.name.as_str(), entry.exec.as_str(), entry.application), ("Firefox", "/snap/bin/firefox %u", true));
        assert_eq!(entry.program().as_deref(), Some("firefox"));
        let env = parse_desktop_entry("x", "[Desktop Entry]\nType=Application\nExec=env GDK_BACKEND=x11 /usr/bin/gedit %U\n");
        assert_eq!(env.program().as_deref(), Some("gedit"));
    }

    #[test]
    fn ids_snap_and_flatpak_names_programs_and_names_all_match_in_that_order() {
        let snap = parse_desktop_entry("firefox_firefox", FIREFOX_SNAP);
        assert_eq!(match_rank(&snap, "firefox"), Some(2));
        assert_eq!(match_rank(&snap, "firefox_firefox.desktop"), Some(0));
        assert_eq!(match_rank(&snap, "Firefox"), Some(2));
        let flatpak = parse_desktop_entry("org.mozilla.firefox", "[Desktop Entry]\nType=Application\nName=Firefox Web Browser\nExec=/usr/bin/flatpak run org.mozilla.firefox\n");
        assert_eq!(match_rank(&flatpak, "firefox"), Some(2));
        let named = parse_desktop_entry("org.gnome.TextEditor", "[Desktop Entry]\nType=Application\nName=Text Editor\nExec=gnome-text-editor %U\n");
        assert_eq!(match_rank(&named, "gnome-text-editor"), Some(4));
        assert_eq!(match_rank(&named, "text editor"), Some(6));
        assert_eq!(match_rank(&named, "editor"), None);
    }

    #[test]
    fn hidden_links_and_commandless_entries_never_match_and_nodisplay_ranks_later() {
        assert_eq!(match_rank(&parse_desktop_entry("a", "[Desktop Entry]\nType=Link\nName=a\nExec=a\n"), "a"), None);
        assert_eq!(match_rank(&parse_desktop_entry("a", "[Desktop Entry]\nType=Application\nHidden=true\nExec=a\n"), "a"), None);
        assert_eq!(match_rank(&parse_desktop_entry("a", "[Desktop Entry]\nType=Application\nName=a\n"), "a"), None);
        assert_eq!(match_rank(&parse_desktop_entry("a", "[Desktop Entry]\nType=Application\nNoDisplay=true\nExec=a\n"), "a"), Some(1));
    }

    #[test]
    #[cfg_attr(target_os = "windows", ignore = "PathBuf joins with backslashes on Windows; the discovery runs on Linux only")]
    fn application_dirs_follow_xdg_and_add_snap_and_flatpak_once() {
        let dirs = application_dirs(None, Some("/usr/share/ubuntu:/usr/share/:/var/lib/snapd/desktop"), Some("/home/p"));
        let dirs: Vec<String> = dirs.iter().map(|d| d.to_string_lossy().to_string()).collect();
        assert_eq!(dirs[0], "/home/p/.local/share/applications");
        assert!(dirs.contains(&"/usr/share/applications".to_string()) || dirs.contains(&"/usr/share//applications".to_string()));
        assert_eq!(dirs.iter().filter(|d| d.starts_with("/var/lib/snapd/desktop")).count(), 1);
        assert!(dirs.contains(&"/home/p/.local/share/flatpak/exports/share/applications".to_string()));
        assert_eq!(application_dirs(Some("/x"), None, None)[0], PathBuf::from("/x/applications"));
    }

    #[test]
    fn the_best_entry_wins_across_directories() {
        let root = tempfile::tempdir().unwrap();
        let apps = root.path().join("applications");
        std::fs::create_dir_all(apps.join("kde")).unwrap();
        std::fs::write(apps.join("firefox_firefox.desktop"), FIREFOX_SNAP).unwrap();
        std::fs::write(apps.join("browser.desktop"), "[Desktop Entry]\nType=Application\nName=firefox\nExec=other\n").unwrap();
        std::fs::write(apps.join("kde").join("kate.desktop"), "[Desktop Entry]\nType=Application\nName=Kate\nExec=kate\n").unwrap();
        let (path, entry) = find_entry("firefox", &[apps.clone()]).unwrap();
        assert!(path.ends_with("firefox_firefox.desktop"), "{path:?}");
        assert_eq!(entry.id, "firefox_firefox");
        assert_eq!(find_entry("kde-kate", &[apps.clone()]).unwrap().1.name, "Kate");
        assert!(find_entry("nothing-here", &[apps]).is_none());
    }
}
