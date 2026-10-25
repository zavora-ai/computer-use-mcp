//! Input on Wayland through the RemoteDesktop portal and libei (GNOME 46 and later, KDE Plasma 6.1 and later).
//!
//! `ydotool` writes to `/dev/uinput`, which needs a root daemon or a device opened to the user: either way any program
//! can then type anywhere, the lock screen included, and the compositor cannot tell its input from the person's. The
//! supported route asks the compositor instead. `org.freedesktop.portal.RemoteDesktop` shows the person a dialog once,
//! and `ConnectToEIS` hands back a socket that speaks the libei protocol: a seat with absolute pointer, button, scroll
//! and keyboard devices. The person's choice is remembered with a restore token, so later sessions do not ask again,
//! and GNOME shows that the desktop is being controlled while the session is open.
//!
//! One thread owns the D-Bus connection (closing it ends the portal session) and the EIS socket (pings are answered
//! there). Input calls send it a batch of actions and wait for the answer. `reis` is a pure Rust implementation of the
//! protocol, so there is no C library to link and nothing changes for hosts without a portal: they keep ydotool or
//! XTEST.
//!
//! The routing and keymap helpers are plain functions compiled on every platform so their tests run everywhere.

#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

/// Which path Linux input takes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// The RemoteDesktop portal and libei.
    Ei,
    /// `ydotool`, which needs its daemon or write access to `/dev/uinput`.
    Ydotool,
    /// XTEST: an X11 session, or XWayland windows only on Wayland.
    Xtest,
    /// Nothing usable; the reason names the fix.
    Unavailable(String),
}

impl Route {
    pub fn name(&self) -> &'static str {
        match self {
            Route::Ei => "libei",
            Route::Ydotool => "ydotool",
            Route::Xtest => "xtest",
            Route::Unavailable(_) => "none",
        }
    }
}

/// What the session offers, for [`choose_route`].
#[derive(Debug, Clone, Copy, Default)]
pub struct InputProbe {
    pub wayland: bool,
    /// The RemoteDesktop portal can hand out a libei connection (`ConnectToEIS`, portal version 2 or later).
    pub portal_eis: bool,
    /// `ydotool` is installed and can reach its daemon or `/dev/uinput`.
    pub ydotool_usable: bool,
    /// `LIBEI_SOCKET` names an EIS socket to connect to directly, without the portal (a compositor that offers one, or
    /// a test server).
    pub eis_socket: bool,
}

/// `COMPUTER_USE_LINUX_INPUT` (`auto`, `libei`, `ydotool`, `xtest`) and the session decide the route. A named route
/// is used as asked; `auto` prefers libei on Wayland, then a working ydotool, and refuses rather than sending XTEST
/// events that only XWayland windows would receive.
pub fn choose_route(preference: Option<&str>, probe: InputProbe) -> Route {
    match preference.map(|value| value.trim().to_ascii_lowercase()).as_deref() {
        Some("libei") | Some("ei") | Some("portal") => return Route::Ei,
        Some("ydotool") => return Route::Ydotool,
        Some("xtest") | Some("x11") | Some("xdotool") => return Route::Xtest,
        _ => {}
    }
    if probe.eis_socket {
        return Route::Ei;
    }
    if !probe.wayland {
        return Route::Xtest;
    }
    if probe.portal_eis {
        return Route::Ei;
    }
    if probe.ydotool_usable {
        return Route::Ydotool;
    }
    Route::Unavailable(
        "No input route on this Wayland session: the desktop has no RemoteDesktop portal with ConnectToEIS \
         (GNOME 46 or KDE Plasma 6.1 and later have one), and ydotool is missing or cannot reach ydotoold or /dev/uinput. \
         Use an X11 session, or set COMPUTER_USE_LINUX_INPUT=xtest to drive XWayland windows only."
            .into(),
    )
}

/// An evdev key code and whether Shift is needed, for one character on a US layout. libei sends key codes, not
/// characters, so typing maps each character to the key that produces it.
pub fn us_key_for_char(c: char) -> Option<(u32, bool)> {
    const LETTERS: [u32; 26] = [
        30, 48, 46, 32, 18, 33, 34, 35, 23, 36, 37, 38, 50, 49, 24, 25, 16, 19, 31, 20, 22, 47, 17, 45, 21, 44,
    ];
    const DIGITS: [u32; 10] = [11, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    let plain = |code: u32| Some((code, false));
    let shifted = |code: u32| Some((code, true));
    match c {
        'a'..='z' => plain(LETTERS[(c as u8 - b'a') as usize]),
        'A'..='Z' => shifted(LETTERS[(c as u8 - b'A') as usize]),
        '0'..='9' => plain(DIGITS[(c as u8 - b'0') as usize]),
        ' ' => plain(57),
        '\n' => plain(28),
        '\t' => plain(15),
        '-' => plain(12),
        '=' => plain(13),
        '[' => plain(26),
        ']' => plain(27),
        '\\' => plain(43),
        ';' => plain(39),
        '\'' => plain(40),
        '`' => plain(41),
        ',' => plain(51),
        '.' => plain(52),
        '/' => plain(53),
        '!' => shifted(2),
        '@' => shifted(3),
        '#' => shifted(4),
        '$' => shifted(5),
        '%' => shifted(6),
        '^' => shifted(7),
        '&' => shifted(8),
        '*' => shifted(9),
        '(' => shifted(10),
        ')' => shifted(11),
        '_' => shifted(12),
        '+' => shifted(13),
        '{' => shifted(26),
        '}' => shifted(27),
        '|' => shifted(43),
        ':' => shifted(39),
        '"' => shifted(40),
        '~' => shifted(41),
        '<' => shifted(51),
        '>' => shifted(52),
        '?' => shifted(53),
        _ => None,
    }
}

/// evdev KEY_LEFTSHIFT and KEY_LEFTCTRL.
pub const KEY_LEFTSHIFT: u32 = 42;
pub const KEY_LEFTCTRL: u32 = 29;

/// The key actions that type `text`, or the characters a US layout cannot type (`\r` is skipped).
pub fn type_actions(text: &str) -> Result<Vec<Action>, String> {
    let mut actions = Vec::with_capacity(text.len() * 2);
    let mut missing: Vec<char> = Vec::new();
    for c in text.chars().filter(|c| *c != '\r') {
        match us_key_for_char(c) {
            Some((code, shift)) => {
                if shift {
                    actions.push(Action::Key { code: KEY_LEFTSHIFT, press: true });
                }
                actions.push(Action::Key { code, press: true });
                actions.push(Action::Key { code, press: false });
                if shift {
                    actions.push(Action::Key { code: KEY_LEFTSHIFT, press: false });
                }
            }
            None if !missing.contains(&c) => missing.push(c),
            None => {}
        }
    }
    if missing.is_empty() {
        Ok(actions)
    } else {
        Err(format!(
            "libei input types through key codes on a US layout and cannot type {}; put the text on the clipboard and paste it",
            missing.iter().take(5).map(|c| format!("{c:?}")).collect::<Vec<_>>().join(", ")
        ))
    }
}

/// One input event to emulate.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Action {
    /// Absolute pointer motion, in logical desktop pixels.
    Move { x: f64, y: f64 },
    /// An evdev button code (BTN_LEFT 0x110, BTN_RIGHT 0x111, BTN_MIDDLE 0x112).
    Button { code: u32, press: bool },
    /// Wheel detents; positive `dy` scrolls down, positive `dx` right.
    Scroll { dx: i32, dy: i32 },
    /// An evdev key code.
    Key { code: u32, press: bool },
}

/// evdev button code for the X11 button numbers the rest of the module uses (1 left, 2 middle, 3 right).
pub fn evdev_button(x11_button: u32) -> u32 {
    match x11_button {
        2 => 0x112,
        3 => 0x111,
        _ => 0x110,
    }
}

/// Is the point inside one of the device's regions (logical pixels)? A device without regions accepts any point.
pub fn point_in_regions(x: f64, y: f64, regions: &[(u32, u32, u32, u32)]) -> bool {
    regions.is_empty()
        || regions.iter().any(|&(rx, ry, w, h)| {
            x >= rx as f64 && y >= ry as f64 && x < rx as f64 + w as f64 && y < ry as f64 + h as f64
        })
}

#[cfg(target_os = "linux")]
pub use live::*;

#[cfg(target_os = "linux")]
mod live {
    use super::{choose_route, point_in_regions, Action, InputProbe, Route};
    use reis::ei;
    use reis::event::{Device, DeviceCapability, EiEvent, EiEventConverter};
    use reis::handshake::EiHandshaker;
    use reis::PendingRequestResult;
    use std::collections::HashMap;
    use std::os::fd::{AsRawFd, OwnedFd};
    use std::os::unix::net::UnixStream;
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::sync::{Condvar, Mutex, OnceLock};
    use std::time::{Duration, Instant};
    use zbus::blocking::{Connection, Proxy};
    use zbus::zvariant::{ObjectPath, OwnedObjectPath, OwnedValue, Value};

    const PORTAL: &str = "org.freedesktop.portal.Desktop";
    const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";
    const REMOTE_DESKTOP: &str = "org.freedesktop.portal.RemoteDesktop";
    /// How long an input call waits for the portal (the first time, for the person to answer the dialog);
    /// `COMPUTER_USE_PORTAL_WAIT_MS` changes it.
    fn connect_wait() -> Duration {
        std::env::var("COMPUTER_USE_PORTAL_WAIT_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .map(Duration::from_millis)
            .unwrap_or(Duration::from_secs(25))
    }

    /// `COMPUTER_USE_DEBUG_LIBEI=true` traces the portal and libei steps to stderr (never stdout, the MCP channel).
    fn trace(step: &str) {
        static ON: OnceLock<bool> = OnceLock::new();
        if *ON.get_or_init(|| std::env::var("COMPUTER_USE_DEBUG_LIBEI").map(|v| v == "true" || v == "1").unwrap_or(false)) {
            eprintln!("[libei] {step}");
        }
    }
    /// How long a batch waits for the devices it needs to appear and be resumed.
    const DEVICE_WAIT: Duration = Duration::from_secs(3);

    fn is_wayland() -> bool {
        std::env::var("XDG_SESSION_TYPE").map(|value| value == "wayland").unwrap_or(false)
            || std::env::var_os("WAYLAND_DISPLAY").is_some()
    }

    /// The RemoteDesktop portal's version, or `None` when there is no portal.
    fn portal_version() -> Option<u32> {
        let connection = Connection::session().ok()?;
        let proxy = Proxy::new(&connection, PORTAL, PORTAL_PATH, REMOTE_DESKTOP).ok()?;
        proxy.get_property::<u32>("version").ok()
    }

    fn ydotool_usable() -> bool {
        if !crate::linux_tools::available("ydotool") {
            return false;
        }
        let uid = unsafe { libc::getuid() };
        let sockets = [
            std::env::var("YDOTOOL_SOCKET").ok(),
            Some("/tmp/.ydotool_socket".to_string()),
            Some(format!("/run/user/{uid}/.ydotool_socket")),
        ];
        if sockets.iter().flatten().any(|path| std::path::Path::new(path).exists()) {
            return true;
        }
        let device = std::ffi::CString::new("/dev/uinput").unwrap();
        unsafe { libc::access(device.as_ptr(), libc::W_OK) == 0 }
    }

    static ROUTE: OnceLock<Route> = OnceLock::new();

    /// The route this process uses, decided once.
    pub fn route() -> Route {
        ROUTE
            .get_or_init(|| {
                let preference = std::env::var("COMPUTER_USE_LINUX_INPUT").ok();
                let wayland = is_wayland();
                let probe = InputProbe {
                    wayland,
                    portal_eis: wayland && portal_version().map(|version| version >= 2).unwrap_or(false),
                    ydotool_usable: wayland && ydotool_usable(),
                    eis_socket: std::env::var_os("LIBEI_SOCKET").is_some(),
                };
                choose_route(preference.as_deref(), probe)
            })
            .clone()
    }

    /// What `doctor` reports about input.
    pub fn describe() -> serde_json::Value {
        let route = route();
        let state = match &*shared().status.lock().unwrap_or_else(|p| p.into_inner()) {
            Status::Idle => "not connected yet (the first input asks the person once)",
            Status::Connecting => "waiting for the person to approve the remote desktop request",
            Status::Ready => "connected",
            Status::Failed(_) => "failed",
        };
        serde_json::json!({
            "route": route.name(),
            "detail": match &route {
                Route::Ei => format!("RemoteDesktop portal and libei: {state}"),
                Route::Ydotool => "ydotool".to_string(),
                Route::Xtest => if is_wayland() { "XTEST (XWayland windows only)".to_string() } else { "XTEST".to_string() },
                Route::Unavailable(reason) => reason.clone(),
            },
        })
    }

    // ── The portal session ────────────────────────────────────────────────────────────────────────────────────────

    fn token_path() -> PathBuf {
        let base = std::env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/state")))
            .unwrap_or_else(std::env::temp_dir);
        base.join("computer-use-mcp").join("remote-desktop.token")
    }

    fn load_restore_token() -> Option<String> {
        std::fs::read_to_string(token_path()).ok().map(|token| token.trim().to_string()).filter(|t| !t.is_empty())
    }

    fn save_restore_token(token: &str) {
        use std::os::unix::fs::OpenOptionsExt;
        let path = token_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(mut file) =
            std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&path)
        {
            let _ = std::io::Write::write_all(&mut file, token.as_bytes());
        }
    }

    fn string_value(value: &OwnedValue) -> Option<String> {
        match &**value {
            Value::Str(text) => Some(text.to_string()),
            Value::ObjectPath(path) => Some(path.to_string()),
            _ => None,
        }
    }

    /// Call a portal method that answers through a `Request` object, and wait for its `Response`.
    fn request(
        connection: &Connection,
        portal: &Proxy,
        method: &str,
        token: &str,
        build: impl FnOnce(HashMap<&str, Value>) -> Result<OwnedObjectPath, zbus::Error>,
    ) -> Result<HashMap<String, OwnedValue>, String> {
        let sender = connection
            .unique_name()
            .ok_or("no D-Bus unique name")?
            .trim_start_matches(':')
            .replace('.', "_");
        let path = format!("{PORTAL_PATH}/request/{sender}/{token}");
        // Subscribe before calling, so a fast answer is not missed.
        let request = Proxy::new(connection, PORTAL, path.as_str(), "org.freedesktop.portal.Request")
            .map_err(|error| format!("{method}: {error}"))?;
        let mut responses = request.receive_signal("Response").map_err(|error| format!("{method}: {error}"))?;
        let mut options: HashMap<&str, Value> = HashMap::new();
        options.insert("handle_token", Value::from(token.to_string()));
        trace(&format!("{method}: calling, waiting on {path}"));
        build(options).map_err(|error| format!("{method}: {error}"))?;
        let _ = portal;
        trace(&format!("{method}: called, waiting for Response"));
        let message = responses.next().ok_or_else(|| format!("{method}: the portal closed the request"))?;
        let (code, results): (u32, HashMap<String, OwnedValue>) =
            message.body().deserialize().map_err(|error| format!("{method}: {error}"))?;
        trace(&format!("{method}: response {code}, keys {:?}", results.keys().collect::<Vec<_>>()));
        match code {
            0 => Ok(results),
            1 => Err("remote_desktop_declined: the person declined the remote desktop request, so this server will not \
                      send input. Restart the server to ask again."
                .into()),
            _ => Err(format!("{method} failed in the portal (response {code})")),
        }
    }

    /// Open a RemoteDesktop session with keyboard and pointer, and return the libei socket. The D-Bus connection is
    /// returned too: the session lasts as long as it does.
    fn open_portal_session() -> Result<(Connection, OwnedFd), String> {
        let connection = Connection::session().map_err(|error| format!("D-Bus session bus: {error}"))?;
        let portal = Proxy::new(&connection, PORTAL, PORTAL_PATH, REMOTE_DESKTOP).map_err(|e| e.to_string())?;
        let version = portal.get_property::<u32>("version").map_err(|error| format!("RemoteDesktop portal: {error}"))?;
        if version < 2 {
            return Err(format!(
                "This desktop's RemoteDesktop portal is version {version}; libei input needs version 2 (GNOME 46, KDE Plasma 6.1)"
            ));
        }
        let pid = std::process::id();
        let created = request(&connection, &portal, "CreateSession", &format!("cu_create_{pid}"), |mut options| {
            options.insert("session_handle_token", Value::from(format!("cu_session_{pid}")));
            portal.call("CreateSession", &(options,))
        })?;
        let session = created
            .get("session_handle")
            .and_then(string_value)
            .ok_or("CreateSession: no session_handle in the answer")?;
        let session_path = ObjectPath::try_from(session.as_str()).map_err(|error| error.to_string())?;
        let restore = load_restore_token();
        request(&connection, &portal, "SelectDevices", &format!("cu_select_{pid}"), |mut options| {
            // 1 keyboard | 2 pointer; persist until the person revokes it.
            options.insert("types", Value::U32(3));
            options.insert("persist_mode", Value::U32(2));
            if let Some(token) = &restore {
                options.insert("restore_token", Value::from(token.clone()));
            }
            portal.call("SelectDevices", &(&session_path, options))
        })?;
        let started = request(&connection, &portal, "Start", &format!("cu_start_{pid}"), |options| {
            portal.call("Start", &(&session_path, "", options))
        })?;
        if let Some(token) = started.get("restore_token").and_then(string_value) {
            save_restore_token(&token);
        }
        let options: HashMap<&str, Value> = HashMap::new();
        let fd: zbus::zvariant::OwnedFd =
            portal.call("ConnectToEIS", &(&session_path, options)).map_err(|error| format!("ConnectToEIS: {error}"))?;
        trace("ConnectToEIS: got the socket");
        Ok((connection, fd.into()))
    }

    // ── The EIS connection ───────────────────────────────────────────────────────────────────────────────────────

    #[derive(Debug, Clone, PartialEq)]
    enum Status {
        Idle,
        Connecting,
        Ready,
        Failed(String),
    }

    struct Job {
        actions: Vec<Action>,
        reply: mpsc::Sender<Result<(), String>>,
    }

    struct Shared {
        status: Mutex<Status>,
        changed: Condvar,
        jobs: Mutex<Option<mpsc::Sender<Job>>>,
    }

    fn shared() -> &'static Shared {
        static SHARED: OnceLock<Shared> = OnceLock::new();
        SHARED.get_or_init(|| Shared { status: Mutex::new(Status::Idle), changed: Condvar::new(), jobs: Mutex::new(None) })
    }

    fn set_status(status: Status) {
        let shared = shared();
        *shared.status.lock().unwrap_or_else(|p| p.into_inner()) = status;
        shared.changed.notify_all();
    }

    struct Session {
        context: ei::Context,
        converter: EiEventConverter,
        devices: Vec<Device>,
        resumed: Vec<Device>,
        sequence: u32,
    }

    fn now_us() -> u64 {
        let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
        unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts) };
        ts.tv_sec as u64 * 1_000_000 + ts.tv_nsec as u64 / 1_000
    }

    /// Wait up to `timeout` for the socket to be readable.
    fn readable(context: &ei::Context, timeout: Duration) -> bool {
        let mut fd = libc::pollfd { fd: context.as_raw_fd(), events: libc::POLLIN, revents: 0 };
        unsafe { libc::poll(&mut fd, 1, timeout.as_millis().min(i32::MAX as u128) as i32) > 0 }
    }

    impl Session {
        /// Read and handle whatever the server sent, waiting up to `timeout` for it.
        fn pump(&mut self, timeout: Duration) -> Result<(), String> {
            if readable(&self.context, timeout) {
                // `read` answers Ok(0) when nothing is waiting; a closed socket is an UnexpectedEof error.
                match self.context.read() {
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
                        return Err("the compositor closed the libei connection".into())
                    }
                    Err(error) => return Err(format!("libei connection: {error}")),
                }
            }
            while let Some(result) = self.context.pending_event() {
                match result {
                    PendingRequestResult::Request(event) => {
                        self.converter.handle_event(event).map_err(|error| format!("libei protocol: {error}"))?
                    }
                    PendingRequestResult::ParseError(error) => return Err(format!("libei protocol: {error}")),
                    PendingRequestResult::InvalidObject(_) => {}
                }
            }
            while let Some(event) = self.converter.next_event() {
                match event {
                    EiEvent::SeatAdded(added) => {
                        added.seat.bind_capabilities(
                            DeviceCapability::PointerAbsolute
                                | DeviceCapability::Pointer
                                | DeviceCapability::Button
                                | DeviceCapability::Scroll
                                | DeviceCapability::Keyboard,
                        );
                    }
                    EiEvent::DeviceAdded(added) => {
                        trace(&format!("device added: {:?}", added.device.name()));
                        self.devices.push(added.device)
                    }
                    EiEvent::DeviceRemoved(removed) => {
                        self.devices.retain(|device| *device != removed.device);
                        self.resumed.retain(|device| *device != removed.device);
                    }
                    EiEvent::DeviceResumed(resumed) => {
                        if !self.resumed.contains(&resumed.device) {
                            self.resumed.push(resumed.device);
                        }
                    }
                    EiEvent::DevicePaused(paused) => self.resumed.retain(|device| *device != paused.device),
                    EiEvent::Disconnected(disconnected) => {
                        return Err(format!(
                            "the compositor ended the remote desktop session ({:?}{})",
                            disconnected.reason,
                            disconnected.explanation.map(|text| format!(": {text}")).unwrap_or_default()
                        ))
                    }
                    _ => {}
                }
            }
            let _ = self.context.flush();
            Ok(())
        }

        /// The resumed device for a capability, preferring one that can also move the pointer absolutely.
        fn device_for(&self, capability: DeviceCapability) -> Option<Device> {
            let candidates: Vec<&Device> = self.resumed.iter().filter(|device| device.has_capability(capability)).collect();
            candidates
                .iter()
                .find(|device| device.has_capability(DeviceCapability::PointerAbsolute))
                .or_else(|| candidates.first())
                .map(|device| (*device).clone())
        }

        fn capability(action: &Action) -> DeviceCapability {
            match action {
                Action::Move { .. } => DeviceCapability::PointerAbsolute,
                Action::Button { .. } => DeviceCapability::Button,
                Action::Scroll { .. } => DeviceCapability::Scroll,
                Action::Key { .. } => DeviceCapability::Keyboard,
            }
        }

        fn run(&mut self, actions: &[Action]) -> Result<(), String> {
            // Every device the batch needs, waiting briefly for the compositor to create and resume them.
            let deadline = Instant::now() + DEVICE_WAIT;
            let mut chosen: HashMap<u64, Device> = HashMap::new();
            for action in actions {
                let capability = Self::capability(action);
                if chosen.contains_key(&(capability as u64)) {
                    continue;
                }
                let device = loop {
                    if let Some(device) = self.device_for(capability) {
                        break device;
                    }
                    if Instant::now() >= deadline {
                        return Err(format!(
                            "the remote desktop session has no {capability:?} device (the compositor offered {})",
                            self.devices.iter().map(|d| d.name().unwrap_or("?").to_string()).collect::<Vec<_>>().join(", ")
                        ));
                    }
                    self.pump(Duration::from_millis(50))?;
                };
                chosen.insert(capability as u64, device);
            }
            let serial = self.converter.connection().serial();
            let mut started: Vec<Device> = Vec::new();
            for device in chosen.values() {
                if !started.contains(device) {
                    self.sequence = self.sequence.wrapping_add(1);
                    device.device().start_emulating(serial, self.sequence);
                    started.push(device.clone());
                }
            }
            let mut result = Ok(());
            for action in actions {
                let device = &chosen[&(Self::capability(action) as u64)];
                match *action {
                    Action::Move { x, y } => {
                        let regions: Vec<(u32, u32, u32, u32)> =
                            device.regions().iter().map(|r| (r.x, r.y, r.width, r.height)).collect();
                        if !point_in_regions(x, y, &regions) {
                            result = Err(format!("({x}, {y}) is outside every screen the compositor offered: {regions:?}"));
                            break;
                        }
                        if let Some(pointer) = device.interface::<ei::PointerAbsolute>() {
                            pointer.motion_absolute(x as f32, y as f32);
                        }
                    }
                    Action::Button { code, press } => {
                        if let Some(button) = device.interface::<ei::Button>() {
                            button.button(
                                code,
                                if press { ei::button::ButtonState::Press } else { ei::button::ButtonState::Released },
                            );
                        }
                    }
                    Action::Scroll { dx, dy } => {
                        if let Some(scroll) = device.interface::<ei::Scroll>() {
                            scroll.scroll_discrete(dx * 120, dy * 120);
                        }
                    }
                    Action::Key { code, press } => {
                        if let Some(keyboard) = device.interface::<ei::Keyboard>() {
                            keyboard.key(
                                code,
                                if press { ei::keyboard::KeyState::Press } else { ei::keyboard::KeyState::Released },
                            );
                        }
                    }
                }
                device.device().frame(serial, now_us());
                // Let the compositor see each event as its own frame, as real hardware would send them.
                let _ = self.context.flush();
                std::thread::sleep(Duration::from_millis(2));
            }
            for device in &started {
                device.device().stop_emulating(serial);
            }
            self.context.flush().map_err(|error| format!("libei connection: {error}"))?;
            result
        }
    }

    /// Connect to `LIBEI_SOCKET` when it is set (no portal, no dialog), otherwise through the RemoteDesktop portal. The
    /// D-Bus connection, when there is one, is returned too: the portal session lasts as long as it does.
    fn connect() -> Result<(Option<Connection>, Session), String> {
        if let Some(context) = ei::Context::connect_to_env().map_err(|error| format!("LIBEI_SOCKET: {error}"))? {
            trace("connecting through LIBEI_SOCKET");
            return Ok((None, Session::handshake(context)?));
        }
        let (connection, fd) = open_portal_session()?;
        let context = ei::Context::new(UnixStream::from(fd)).map_err(|error| format!("libei socket: {error}"))?;
        Ok((Some(connection), Session::handshake(context)?))
    }

    impl Session {
        /// The sender side of the libei handshake on a connected socket, then the first seat and devices.
        fn handshake(context: ei::Context) -> Result<Session, String> {
            let mut handshaker = EiHandshaker::new("computer-use-mcp", ei::handshake::ContextType::Sender);
            let deadline = Instant::now() + Duration::from_secs(5);
            let response = 'handshake: loop {
                if Instant::now() >= deadline {
                    return Err("libei handshake timed out".into());
                }
                if readable(&context, Duration::from_millis(100)) {
                    context.read().map_err(|error| format!("libei handshake: {error}"))?;
                }
                while let Some(result) = context.pending_event() {
                    if let PendingRequestResult::Request(event) = result {
                        if let Some(response) =
                            handshaker.handle_event(event).map_err(|error| format!("libei handshake: {error}"))?
                        {
                            break 'handshake response;
                        }
                    }
                }
                let _ = context.flush();
            };
            trace("libei handshake done");
            let converter = EiEventConverter::new(&context, response);
            let mut session = Session { context, converter, devices: Vec::new(), resumed: Vec::new(), sequence: 0 };
            session.pump(Duration::from_millis(200))?;
            Ok(session)
        }
    }

    /// The thread that owns the portal session and the libei socket.
    fn serve(jobs: mpsc::Receiver<Job>) {
        let (_connection, mut session) = match connect() {
            Ok(connected) => connected,
            Err(reason) => {
                set_status(Status::Failed(reason));
                return;
            }
        };
        set_status(Status::Ready);
        loop {
            match jobs.recv_timeout(Duration::from_millis(20)) {
                Ok(job) => {
                    let result = session.run(&job.actions);
                    let _ = job.reply.send(result);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            if let Err(reason) = session.pump(Duration::ZERO) {
                set_status(Status::Failed(reason));
                break;
            }
        }
        // Dropping the D-Bus connection closes the portal session; the next input asks the portal again.
        *shared().jobs.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    /// Start the session thread once, and wait until it is ready, has failed, or the wait runs out.
    fn ensure_connected() -> Result<mpsc::Sender<Job>, String> {
        let shared = shared();
        {
            let mut status = shared.status.lock().unwrap_or_else(|p| p.into_inner());
            match &*status {
                Status::Failed(reason) if reason.starts_with("remote_desktop_declined") => return Err(reason.clone()),
                Status::Idle | Status::Failed(_) => {
                    let (sender, receiver) = mpsc::channel();
                    *shared.jobs.lock().unwrap_or_else(|p| p.into_inner()) = Some(sender);
                    *status = Status::Connecting;
                    std::thread::Builder::new()
                        .name("computer-use-libei".into())
                        .spawn(move || serve(receiver))
                        .map_err(|error| format!("cannot start the libei thread: {error}"))?;
                }
                _ => {}
            }
            let (status, _) = shared
                .changed
                .wait_timeout_while(status, connect_wait(), |status| *status == Status::Connecting)
                .unwrap_or_else(|p| p.into_inner());
            match &*status {
                Status::Ready => {}
                Status::Failed(reason) => return Err(reason.clone()),
                _ => {
                    return Err("approval_pending: approve the remote desktop request on screen (the desktop asks once \
                                and remembers the answer), then retry."
                        .into())
                }
            }
        }
        shared.jobs.lock().unwrap_or_else(|p| p.into_inner()).clone().ok_or_else(|| "the libei session ended".into())
    }

    /// Emulate a batch of input events through the portal session, connecting (and asking the person) on first use.
    pub fn send(actions: Vec<Action>) -> napi::Result<()> {
        if actions.is_empty() {
            return Ok(());
        }
        let jobs = ensure_connected().map_err(napi::Error::from_reason)?;
        let (reply, answer) = mpsc::channel();
        // The compositor's idle clock counts these events too; the takeover monitor sets them aside (activity.rs).
        crate::activity::note_agent_input(true);
        let result = jobs
            .send(Job { actions, reply })
            .map_err(|_| napi::Error::from_reason("the libei session ended"))
            .and_then(|()| {
                answer
                    .recv_timeout(Duration::from_secs(30))
                    .map_err(|_| napi::Error::from_reason("the libei session did not answer"))?
                    .map_err(napi::Error::from_reason)
            });
        crate::activity::note_agent_input(false);
        result
    }

    #[cfg(test)]
    mod tests {
        use super::super::type_actions;
        use super::*;
        use reis::eis;
        use reis::handshake::EisHandshaker;
        use reis::request::{EisRequest, EisRequestConverter};
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        /// The compositor's side of libei, in miniature: one seat with an absolute pointer over a 1920x1080 screen
        /// (with buttons and scroll) and a keyboard. Every input event it receives is recorded as text.
        struct TestEis {
            events: Arc<Mutex<Vec<String>>>,
            stop: Arc<AtomicBool>,
            thread: Option<std::thread::JoinHandle<Result<(), String>>>,
        }

        impl TestEis {
            fn start(listener: eis::Listener) -> TestEis {
                let events = Arc::new(Mutex::new(Vec::new()));
                let stop = Arc::new(AtomicBool::new(false));
                let (recorded, stopping) = (events.clone(), stop.clone());
                let thread = std::thread::spawn(move || serve_one(listener, recorded, stopping));
                TestEis { events, stop, thread: Some(thread) }
            }

            /// The events received so far, waiting up to 3 s for at least `count`.
            fn wait_for(&self, count: usize) -> Vec<String> {
                let deadline = Instant::now() + Duration::from_secs(3);
                loop {
                    let events = self.events.lock().unwrap().clone();
                    if events.len() >= count || Instant::now() >= deadline {
                        return events;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        }

        impl Drop for TestEis {
            fn drop(&mut self) {
                self.stop.store(true, Ordering::Release);
                if let Some(thread) = self.thread.take() {
                    let result = thread.join().expect("the test EIS server panicked");
                    if !std::thread::panicking() {
                        result.expect("the test EIS server failed");
                    }
                }
            }
        }

        fn serve_one(listener: eis::Listener, events: Arc<Mutex<Vec<String>>>, stop: Arc<AtomicBool>) -> Result<(), String> {
            let deadline = Instant::now() + Duration::from_secs(10);
            let context = loop {
                if let Some(context) = listener.accept().map_err(|error| error.to_string())? {
                    break context;
                }
                if stop.load(Ordering::Acquire) || Instant::now() >= deadline {
                    return Ok(());
                }
                std::thread::sleep(Duration::from_millis(5));
            };
            let mut handshaker = EisHandshaker::new(&context, 1);
            let mut converter: Option<EisRequestConverter> = None;
            let mut seat = None;
            let record = |event: String| events.lock().unwrap().push(event);
            while !stop.load(Ordering::Acquire) {
                let mut fd = libc::pollfd { fd: context.as_raw_fd(), events: libc::POLLIN, revents: 0 };
                unsafe { libc::poll(&mut fd, 1, 20) };
                match context.read() {
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                    // The client went away (UnexpectedEof) or the socket failed: the test is over.
                    Err(_) => return Ok(()),
                }
                while let Some(result) = context.pending_request() {
                    let PendingRequestResult::Request(request) = result else { continue };
                    match converter.as_mut() {
                        None => {
                            if let Some(response) = handshaker.handle_request(request).map_err(|e| e.to_string())? {
                                let connected = EisRequestConverter::new(&context, response, 1);
                                seat = Some(connected.handle().add_seat(
                                    Some("test seat"),
                                    DeviceCapability::PointerAbsolute
                                        | DeviceCapability::Button
                                        | DeviceCapability::Scroll
                                        | DeviceCapability::Keyboard,
                                ));
                                converter = Some(connected);
                            }
                        }
                        Some(connected) => connected.handle_request(request).map_err(|e| e.to_string())?,
                    }
                }
                if let Some(connected) = converter.as_mut() {
                    while let Some(request) = connected.next_request() {
                        match request {
                            EisRequest::Bind(bind) => {
                                if bind.capabilities.contains(DeviceCapability::PointerAbsolute) {
                                    let pointer = bind.seat.add_device(
                                        Some("test pointer"),
                                        eis::device::DeviceType::Virtual,
                                        DeviceCapability::PointerAbsolute | DeviceCapability::Button | DeviceCapability::Scroll,
                                        |device| device.device().region(0, 0, 1920, 1080, 1.0),
                                    );
                                    pointer.resumed();
                                }
                                if bind.capabilities.contains(DeviceCapability::Keyboard) {
                                    let keyboard = bind.seat.add_device(
                                        Some("test keyboard"),
                                        eis::device::DeviceType::Virtual,
                                        DeviceCapability::Keyboard.into(),
                                        |_| {},
                                    );
                                    keyboard.resumed();
                                }
                            }
                            EisRequest::PointerMotionAbsolute(motion) => {
                                record(format!("move {} {}", motion.dx_absolute, motion.dy_absolute))
                            }
                            EisRequest::Button(button) => record(format!(
                                "button {:#x} {}",
                                button.button,
                                if button.state == eis::button::ButtonState::Press { "press" } else { "release" }
                            )),
                            EisRequest::ScrollDiscrete(scroll) => {
                                record(format!("scroll {} {}", scroll.discrete_dx, scroll.discrete_dy))
                            }
                            EisRequest::KeyboardKey(key) => record(format!(
                                "key {} {}",
                                key.key,
                                if key.state == eis::keyboard::KeyState::Press { "press" } else { "release" }
                            )),
                            _ => {}
                        }
                    }
                    let _ = connected.handle().flush();
                }
                let _ = context.flush();
            }
            drop(seat);
            Ok(())
        }

        #[test]
        fn a_session_sends_every_action_to_the_compositor_as_libei_events() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("eis-session");
            let server = TestEis::start(eis::Listener::bind(&path).unwrap());
            let context = ei::Context::new(UnixStream::connect(&path).unwrap()).unwrap();
            let mut session = Session::handshake(context).unwrap();

            session
                .run(&[
                    Action::Move { x: 100.0, y: 200.0 },
                    Action::Button { code: 0x110, press: true },
                    Action::Button { code: 0x110, press: false },
                    Action::Scroll { dx: 0, dy: 2 },
                    Action::Key { code: 30, press: true },
                    Action::Key { code: 30, press: false },
                ])
                .unwrap();
            assert_eq!(
                server.wait_for(6),
                [
                    "move 100 200",
                    "button 0x110 press",
                    "button 0x110 release",
                    "scroll 0 240",
                    "key 30 press",
                    "key 30 release",
                ]
            );

            // A point outside every region the compositor offered is refused, not sent.
            let refused = session.run(&[Action::Move { x: 1920.0, y: 10.0 }]).unwrap_err();
            assert!(refused.contains("outside every screen"), "{refused}");

            // Typing is key events: "Hi" is Shift + h, then i.
            session.run(&type_actions("Hi").unwrap()).unwrap();
            assert_eq!(
                server.wait_for(12)[6..],
                ["key 42 press", "key 35 press", "key 35 release", "key 42 release", "key 23 press", "key 23 release"]
            );
        }

        #[test]
        fn send_connects_through_libei_socket_without_the_portal() {
            // The only test that uses the process-wide session, so the variable cannot reach another test's connection.
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("eis-send");
            let server = TestEis::start(eis::Listener::bind(&path).unwrap());
            std::env::set_var("LIBEI_SOCKET", &path);
            send(vec![Action::Move { x: 10.0, y: 20.0 }, Action::Key { code: 57, press: true }, Action::Key { code: 57, press: false }])
                .unwrap();
            assert_eq!(server.wait_for(3), ["move 10 20", "key 57 press", "key 57 release"]);
            assert_eq!(*shared().status.lock().unwrap(), Status::Ready);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_prefers_the_portal_then_a_working_ydotool_and_otherwise_says_why() {
        let wayland = InputProbe { wayland: true, ..Default::default() };
        assert_eq!(choose_route(None, InputProbe { portal_eis: true, ydotool_usable: true, ..wayland }), Route::Ei);
        assert_eq!(choose_route(Some("auto"), InputProbe { ydotool_usable: true, ..wayland }), Route::Ydotool);
        match choose_route(None, wayland) {
            Route::Unavailable(reason) => assert!(reason.contains("RemoteDesktop portal") && reason.contains("xtest")),
            other => panic!("expected Unavailable, got {other:?}"),
        }
        assert_eq!(choose_route(None, InputProbe::default()), Route::Xtest);
    }

    #[test]
    fn a_named_route_is_used_as_asked() {
        let wayland = InputProbe { wayland: true, portal_eis: true, ..Default::default() };
        assert_eq!(choose_route(Some("XTEST"), wayland), Route::Xtest);
        assert_eq!(choose_route(Some("ydotool"), wayland), Route::Ydotool);
        assert_eq!(choose_route(Some(" libei "), InputProbe::default()), Route::Ei);
        // LIBEI_SOCKET names an EIS server directly, on any session.
        assert_eq!(choose_route(None, InputProbe { eis_socket: true, ..Default::default() }), Route::Ei);
    }

    #[test]
    fn typing_maps_characters_to_us_keys_with_shift() {
        let actions = type_actions("aB\r\n!").unwrap();
        assert_eq!(
            actions,
            vec![
                Action::Key { code: 30, press: true },
                Action::Key { code: 30, press: false },
                Action::Key { code: KEY_LEFTSHIFT, press: true },
                Action::Key { code: 48, press: true },
                Action::Key { code: 48, press: false },
                Action::Key { code: KEY_LEFTSHIFT, press: false },
                Action::Key { code: 28, press: true },
                Action::Key { code: 28, press: false },
                Action::Key { code: KEY_LEFTSHIFT, press: true },
                Action::Key { code: 2, press: true },
                Action::Key { code: 2, press: false },
                Action::Key { code: KEY_LEFTSHIFT, press: false },
            ]
        );
        let error = type_actions("café ü").unwrap_err();
        assert!(error.contains("'é'") && error.contains("'ü'") && error.contains("clipboard"), "{error}");
    }

    #[test]
    fn every_printable_ascii_character_has_a_key() {
        for c in (0x20u8..0x7f).map(char::from) {
            assert!(us_key_for_char(c).is_some(), "{c:?}");
        }
    }

    #[test]
    fn points_outside_every_region_are_refused() {
        let regions = [(0, 0, 1920, 1080), (1920, 0, 1280, 1024)];
        assert!(point_in_regions(100.0, 100.0, &regions));
        assert!(point_in_regions(3000.0, 1000.0, &regions));
        assert!(!point_in_regions(3000.0, 1050.0, &regions));
        assert!(!point_in_regions(-1.0, 5.0, &regions));
        assert!(point_in_regions(-1.0, 5.0, &[]));
        assert_eq!((evdev_button(1), evdev_button(2), evdev_button(3)), (0x110, 0x112, 0x111));
    }
}
