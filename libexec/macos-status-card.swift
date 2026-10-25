// The macOS desktop status card for computer-use-mcp (7.6.1).
//
// A small non-activating panel that says an agent is driving this Mac, what it is doing (the tool, the app and the
// window the server resolved), and lets the person Pause, Resume or Stop it. It is excluded from screen capture
// (`sharingType = .none`), so the agent never sees its own controls; it never takes keyboard focus; it watches the
// server's pid and quits when the server is gone, so nothing is left on screen after a crash.
//
// Protocol: argv[1] is a directory holding `state.json` (written by the server) and `control.txt` (written here:
// running | paused | stopped). Compiled on first use by the server into ~/Library/Caches/computer-use-mcp/.

import AppKit
import Foundation

struct CardAction: Decodable {
    let tool: String
    let label: String
    let app: String?
    let window: String?
    let outcome: String
}

struct CardFrame: Decodable {
    let pid: Int32
    let state: String
    let startedAt: Double
    let action: CardAction?
    let recent: [CardAction]
    let waiting: String?
    let chord: String?
    /// 7.7.0: "takeover" when the person used the mouse or keyboard during an action.
    let reason: String?
    /// 7.8: the live watcher is looking at this target.
    let watching: CardWatching?
}

struct CardWatching: Decodable {
    let target: String
    let since: Double
}

/// "ctrl+alt+escape" as the keys read on a Mac keyboard: ⌃⌥⎋.
func chordLabel(_ chord: String?) -> String? {
    guard let chord = chord, !chord.isEmpty else { return nil }
    let symbols: [String: String] = [
        "ctrl": "⌃", "control": "⌃", "alt": "⌥", "option": "⌥", "shift": "⇧", "cmd": "⌘", "command": "⌘", "meta": "⌘",
        "escape": "⎋", "esc": "⎋", "f12": "F12",
    ]
    return chord.split(separator: "+").map { symbols[$0.lowercased()] ?? $0.uppercased() }.joined()
}

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    FileHandle.standardError.write("usage: macos-status-card <directory>\n".data(using: .utf8)!)
    exit(2)
}
let directory = URL(fileURLWithPath: arguments[1], isDirectory: true)
let stateURL = directory.appendingPathComponent("state.json")
let controlURL = directory.appendingPathComponent("control.txt")

func readControl() -> String {
    (try? String(contentsOf: controlURL, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()) ?? ""
}

func writeControl(_ value: String) {
    let temporary = directory.appendingPathComponent("control.txt.\(getpid()).tmp")
    do {
        try value.write(to: temporary, atomically: false, encoding: .utf8)
        _ = try FileManager.default.replaceItemAt(controlURL, withItemAt: temporary)
    } catch {
        try? value.write(to: controlURL, atomically: true, encoding: .utf8)
    }
}

func readFrame() -> CardFrame? {
    guard let data = try? Data(contentsOf: stateURL) else { return nil }
    return try? JSONDecoder().decode(CardFrame.self, from: data)
}

func processAlive(_ pid: Int32) -> Bool {
    if kill(pid, 0) == 0 { return true }
    return errno == EPERM
}

func shortApp(_ bundleId: String?) -> String? {
    guard let id = bundleId, !id.isEmpty else { return nil }
    if let app = NSRunningApplication.runningApplications(withBundleIdentifier: id).first, let name = app.localizedName, !name.isEmpty {
        return name
    }
    return id.split(separator: ".").last.map(String.init) ?? id
}

func elapsedText(since startedAt: Double) -> String {
    let seconds = max(0, Int(Date().timeIntervalSince1970 - startedAt / 1000))
    return seconds >= 3600 ? String(format: "%d:%02d:%02d", seconds / 3600, (seconds % 3600) / 60, seconds % 60)
        : String(format: "%d:%02d", seconds / 60, seconds % 60)
}

/// A button that reacts on the first click even though the panel never becomes key.
final class FirstClickButton: NSButton {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class CardPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class Card {
    let panel: CardPanel
    let dot = NSView()
    let title = NSTextField(labelWithString: "")
    let action = NSTextField(labelWithString: "")
    let recentLines: [NSTextField] = (0..<3).map { _ in NSTextField(labelWithString: "") }
    let pauseButton = FirstClickButton(title: "Pause", target: nil, action: nil)
    let stopButton = FirstClickButton(title: "Stop", target: nil, action: nil)
    var lastFrame: CardFrame?
    var control = "running"

    init() {
        let size = NSSize(width: 340, height: 150)
        panel = CardPanel(contentRect: NSRect(origin: .zero, size: size),
                          styleMask: [.borderless, .nonactivatingPanel, .utilityWindow],
                          backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.sharingType = .none               // excluded from screen capture: the agent never sees this card
        panel.isMovableByWindowBackground = true
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.animationBehavior = .none

        let effect = NSVisualEffectView(frame: NSRect(origin: .zero, size: size))
        effect.material = .hudWindow
        effect.blendingMode = .behindWindow
        effect.state = .active
        effect.wantsLayer = true
        effect.layer?.cornerRadius = 14
        effect.layer?.masksToBounds = true
        panel.contentView = effect

        dot.wantsLayer = true
        dot.layer?.cornerRadius = 5
        dot.frame = NSRect(x: 18, y: size.height - 30, width: 10, height: 10)
        effect.addSubview(dot)

        title.font = .systemFont(ofSize: 13, weight: .semibold)
        title.frame = NSRect(x: 34, y: size.height - 36, width: size.width - 50, height: 20)
        title.lineBreakMode = .byTruncatingTail
        effect.addSubview(title)

        action.font = .systemFont(ofSize: 12)
        action.textColor = .secondaryLabelColor
        action.frame = NSRect(x: 18, y: size.height - 58, width: size.width - 36, height: 18)
        action.lineBreakMode = .byTruncatingTail
        effect.addSubview(action)

        for (index, line) in recentLines.enumerated() {
            line.font = .systemFont(ofSize: 11)
            line.textColor = .tertiaryLabelColor
            line.frame = NSRect(x: 18, y: size.height - 78 - CGFloat(index) * 16, width: size.width - 36, height: 16)
            line.lineBreakMode = .byTruncatingTail
            effect.addSubview(line)
        }

        for (button, x) in [(pauseButton, size.width - 156), (stopButton, size.width - 78)] {
            button.bezelStyle = .rounded
            button.controlSize = .small
            button.font = .systemFont(ofSize: 11)
            button.frame = NSRect(x: x, y: 10, width: button === stopButton ? 64 : 72, height: 24)
            effect.addSubview(button)
        }
        pauseButton.target = self
        pauseButton.action = #selector(togglePause)
        stopButton.target = self
        stopButton.action = #selector(stop)

        if let screen = NSScreen.main {
            let visible = screen.visibleFrame
            panel.setFrameOrigin(NSPoint(x: visible.maxX - size.width - 16, y: visible.maxY - size.height - 16))
        }
        render(frame: nil)
        panel.orderFrontRegardless()
        publishGeometry()
        NotificationCenter.default.addObserver(forName: NSWindow.didMoveNotification, object: panel, queue: .main) { [weak self] _ in
            self?.publishGeometry()
        }
    }

    /// Where the card and its buttons are, in CoreGraphics screen points (top-left origin), as `card.json`:
    /// a host or an integration test can find the controls without capturing the screen (which excludes the card).
    func publishGeometry() {
        guard let primary = NSScreen.screens.first else { return }
        let height = primary.frame.height
        func cg(_ rect: NSRect) -> [String: Double] {
            ["x": rect.minX, "y": height - rect.maxY, "width": rect.width, "height": rect.height]
        }
        let frame = panel.frame
        func button(_ view: NSView) -> [String: Double] {
            let local = view.frame
            return cg(NSRect(x: frame.minX + local.minX, y: frame.minY + local.minY, width: local.width, height: local.height))
        }
        let payload: [String: Any] = ["frame": cg(frame), "buttons": ["pause": button(pauseButton), "stop": button(stopButton)], "pid": Int(getpid())]
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        try? data.write(to: directory.appendingPathComponent("card.json"), options: .atomic)
    }

    @objc func togglePause() {
        let current = readControl()
        if current == "stopped" { return }
        control = current == "paused" ? "running" : "paused"
        writeControl(control)
        render(frame: lastFrame)
    }

    @objc func stop() {
        // 7.7.0: once the agent is stopped the button reads Close and dismisses the card. The server keeps the stopped
        // state (and does not open the card again), so closing it resumes nothing.
        if readControl() == "stopped" {
            NSApp.terminate(nil)
            return
        }
        control = "stopped"
        writeControl(control)
        render(frame: lastFrame)
    }

    func tick() {
        guard FileManager.default.fileExists(atPath: controlURL.path) else { NSApp.terminate(nil); return }
        if let frame = readFrame() {
            lastFrame = frame
            if !processAlive(frame.pid) { NSApp.terminate(nil); return }
        }
        control = readControl()
        render(frame: lastFrame)
    }

    func render(frame: CardFrame?) {
        let state = frame?.state ?? "running"
        let effective = control == "stopped" ? "stopped" : (control == "paused" ? "paused" : state)
        let elapsed = frame.map { elapsedText(since: $0.startedAt) } ?? "0:00"
        switch effective {
        case "stopped":
            dot.layer?.backgroundColor = NSColor.systemRed.cgColor
            title.stringValue = "Agent stopped · \(elapsed)"
            action.stringValue = "No further desktop input this session. Restart the server to resume."
            pauseButton.isEnabled = false
            stopButton.title = "Close"
            stopButton.isEnabled = true
        case "paused":
            dot.layer?.backgroundColor = NSColor.systemOrange.cgColor
            if frame?.reason == "takeover" {
                title.stringValue = "You took over · \(elapsed)"
                action.stringValue = "The agent waits while you use the mouse or keyboard, and resumes when you stop."
            } else if frame?.watching != nil {
                title.stringValue = "Agent paused · \(elapsed)"
                action.stringValue = "The watch sees nothing and nothing is changed until you resume."
            } else {
                title.stringValue = "Agent paused · \(elapsed)"
                action.stringValue = "Mutations are refused; it can still look. Resume when you are ready."
            }
            pauseButton.title = "Resume"
            pauseButton.isEnabled = true
            stopButton.title = "Stop"
            stopButton.isEnabled = true
        default:
            pauseButton.title = "Pause"
            pauseButton.isEnabled = true
            stopButton.title = "Stop"
            stopButton.isEnabled = true
            if frame?.waiting == "user_active" {
                dot.layer?.backgroundColor = NSColor.systemOrange.cgColor
                title.stringValue = "Agent waiting for you · \(elapsed)"
                action.stringValue = "You are typing or moving the mouse; it resumes when you stop."
            } else if frame?.waiting == "approval" {
                dot.layer?.backgroundColor = NSColor.systemOrange.cgColor
                title.stringValue = "Agent needs approval · \(elapsed)"
                action.stringValue = current(frame) ?? "A gated action is waiting for the host's approval."
            } else if let watching = frame?.watching, current(frame) == nil {
                // Watching without acting: say what it can see, and that Pause stops it seeing.
                dot.layer?.backgroundColor = NSColor.systemPurple.cgColor
                title.stringValue = "Agent is watching this Mac · \(elapsedText(since: watching.since))"
                action.stringValue = "Sees \(watching.target). Pause and it sees nothing."
            } else {
                dot.layer?.backgroundColor = NSColor.systemBlue.cgColor
                title.stringValue = "Agent is using this Mac · \(elapsed)"
                let keys = chordLabel(frame?.chord)
                action.stringValue = current(frame) ?? (keys.map { "Idle · \($0) stops it from any app" } ?? "Idle")
            }
        }
        stopButton.toolTip = control == "stopped" ? "Close this card; the agent stays stopped"
            : chordLabel(frame?.chord).map { "Stop the agent for this session (or press \($0) anywhere)" }
            ?? "Stop the agent for this session"
        let recent = frame?.recent ?? []
        for (index, line) in recentLines.enumerated() {
            if index < recent.count {
                let item = recent[index]
                let mark = item.outcome == "failed" ? "✕" : "✓"
                line.stringValue = "\(mark) \(describe(item))"
                line.textColor = item.outcome == "failed" ? .systemRed : .tertiaryLabelColor
            } else {
                line.stringValue = ""
            }
        }
    }

    func current(_ frame: CardFrame?) -> String? {
        guard let item = frame?.action else { return nil }
        return describe(item)
    }

    func describe(_ item: CardAction) -> String {
        var text = item.label
        if let app = shortApp(item.app) {
            text += " in \(app)"
            if let window = item.window, !window.isEmpty { text += " · \(window)" }
        }
        return text
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let card = Card()
let timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { _ in card.tick() }
RunLoop.main.add(timer, forMode: .common)
signal(SIGTERM) { _ in exit(0) }
app.run()
