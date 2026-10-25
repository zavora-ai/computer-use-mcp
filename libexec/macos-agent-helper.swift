// computer-use-mcp macOS agent helper (v7.5; display capture and regions 7.7.0).
//
// Compiled on first use by src/session/macos-helper.ts with `swiftc -O` into
// ~/Library/Caches/computer-use-mcp/macos-agent-helper-<sha8> and signed ad hoc.
// Every subcommand prints one JSON object on stdout; failures print {"error": ...}
// and exit 1. Nothing here activates an app, moves the pointer or touches the network.
//
//   capture --window <id> --out <file> [--width <px>] [--scale <s>] [--min-scale <s>] [--format png|jpeg] [--quality <1-100>]
//           [--region x,y,w,h]
//       ScreenCaptureKit (SCScreenshotManager, macOS 14+): the window alone, even when
//       covered, without its shadow, never activated. -> {path, width, height, hash, scale, frame, region?}
//   capture --display <id|main> --out <file> [--width <px>] [--format png|jpeg] [--quality <1-100>] [--region x,y,w,h]
//           [--overlay-pids <pid,...>]
//       7.7.0: a whole display through ScreenCaptureKit, replacing `screencapture` + `sips`. The status card and
//       the shielding-level windows of --overlay-pids (the server's agent pointer) are left out of the image.
//       frame is the display in global points.
//   --region (7.7.0) crops to x,y,w,h in points from the window's or display's top-left, at full resolution
//       (--width is ignored); the reply echoes it.
//   --diff [--diff-key <k>] [--skip-unchanged] (7.8): compare with the previous capture of the same source kept in
//       this process; the reply gains diff {changed, area, dirty?, first?}, and an unchanged capture with
//       --skip-unchanged is not encoded ({unchanged: true}, no path).
//   ocr (--window <id> | --image <file>) [--region x,y,w,h] [--languages en-US,...] [--fast]
//       Vision text recognition, on device. Boxes are image pixels, top-left origin.
//       --region is in window points with --window, in image pixels with --image.
//       -> {width, height, scale, frame?, lines: [{text, confidence, box: {x, y, w, h}}]}
//   serve [--idle-ms <ms>] (7.7.0): stays running; one JSON request per stdin line, one reply per stdout line.
//   version -> {version, macos, sck}

import CoreGraphics
import CryptoKit
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers
import Vision

let helperVersion = "7.8.0"

struct HelperError: Error {
    let code: String
    let message: String
}

func emit(_ object: [String: Any]) {
    let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func option(_ name: String, in args: [String]) -> String? {
    guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
    return args[index + 1]
}

func flag(_ name: String, in args: [String]) -> Bool { args.contains(name) }

func frameDict(_ rect: CGRect) -> [String: Double] {
    ["x": Double(rect.origin.x), "y": Double(rect.origin.y), "width": Double(rect.width), "height": Double(rect.height)]
}

// MARK: - ScreenCaptureKit capture

struct WindowImage {
    let image: CGImage
    let scale: Double
    let frame: CGRect
}

final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func claim() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if done { return false }
        done = true
        return true
    }
}

/// ScreenCaptureKit can stall indefinitely when another process is capturing at the same time (measured
/// 2026-10-09: two helpers side by side both hung). A stall becomes a JSON error the caller can act on.
/// 7.7.0: a task group waits for every child before it returns, and a stalled ScreenCaptureKit call ignores
/// cancellation, so the timeout resumes the caller itself and leaves the stalled call behind (`serve` then exits).
func withSckTimeout<T: Sendable>(_ seconds: Double, _ what: String, _ operation: @escaping @Sendable () async throws -> T) async throws -> T {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<T, Error>) in
        let once = Once()
        let timer = Task {
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            if !Task.isCancelled && once.claim() {
                continuation.resume(throwing: HelperError(code: "sck_timeout", message: "ScreenCaptureKit did not \(what) within \(Int(seconds)) s (another capture may be running)"))
            }
        }
        Task {
            do {
                let value = try await operation()
                if once.claim() { timer.cancel(); continuation.resume(returning: value) }
            } catch {
                if once.claim() { timer.cancel(); continuation.resume(throwing: error) }
            }
        }
    }
}

@available(macOS 14.0, *)
func captureWindow(id: UInt32, width: Int?, scale userScale: Double?, minPixelScale: Double = 1) async throws -> WindowImage {
    let content: SCShareableContent
    do {
        content = try await withSckTimeout(10, "list the windows") { try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false) }
    } catch let error as HelperError {
        throw error
    } catch {
        throw HelperError(code: "screen_recording_denied",
                          message: "ScreenCaptureKit refused to list windows (Screen Recording permission?): \(error.localizedDescription)")
    }
    guard let window = content.windows.first(where: { $0.windowID == id }) else {
        throw HelperError(code: "window_not_found", message: "No window with id \(id)")
    }
    let filter = SCContentFilter(desktopIndependentWindow: window)
    // Vision reads small UI text better at 2x; on a 1x display, OCR asks for an
    // upscaled capture (minPixelScale 2) rather than the backing resolution.
    let pointScale = max(Double(filter.pointPixelScale), minPixelScale)
    let rect = filter.contentRect
    var pixelWidth = Double(rect.width) * pointScale
    var pixelHeight = Double(rect.height) * pointScale
    if let userScale, userScale > 0, userScale < 1 {
        pixelWidth *= userScale
        pixelHeight *= userScale
    }
    if let width, width > 0, Double(width) < pixelWidth {
        pixelHeight = pixelHeight * Double(width) / pixelWidth
        pixelWidth = Double(width)
    }
    let config = SCStreamConfiguration()
    config.width = max(1, Int(pixelWidth.rounded()))
    config.height = max(1, Int(pixelHeight.rounded()))
    // Without scalesToFit, SCK draws the window at its backing size into the
    // top-left of the buffer: a smaller buffer crops it, a larger one pads it.
    config.scalesToFit = true
    config.showsCursor = false
    config.ignoreShadowsSingleWindow = true
    config.captureResolution = .best
    let image = try await withSckTimeout(10, "capture the window") { try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) }
    return WindowImage(image: image, scale: Double(image.width) / max(1, Double(rect.width)), frame: window.frame)
}

/// The status card is compiled into the helper cache as `macos-status-card-<sha8>`. It sets `sharingType = .none`, which
/// ScreenCaptureKit does not honour on every release, so a display capture leaves it out by name as well.
let statusCardPrefix = "macos-status-card"

/// The agent pointer is an NSPanel at the shielding level inside the server process. Only that process's windows at
/// this level are left out: a host that embeds the server keeps its own windows in the capture.
let overlayLayer = Int(CGShieldingWindowLevel())

@available(macOS 14.0, *)
func captureDisplay(id: CGDirectDisplayID?, width: Int?, overlayPids: Set<pid_t>) async throws -> WindowImage {
    let content: SCShareableContent
    do {
        content = try await withSckTimeout(10, "list the displays") { try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) }
    } catch let error as HelperError {
        throw error
    } catch {
        throw HelperError(code: "screen_recording_denied",
                          message: "ScreenCaptureKit refused to list displays (Screen Recording permission?): \(error.localizedDescription)")
    }
    let wanted = id ?? CGMainDisplayID()
    guard let display = content.displays.first(where: { $0.displayID == wanted }) else {
        throw HelperError(code: "display_not_found", message: "No display with id \(wanted)")
    }
    let excluded = content.windows.filter { window in
        guard let app = window.owningApplication else { return false }
        if app.applicationName.hasPrefix(statusCardPrefix) || app.bundleIdentifier.hasPrefix(statusCardPrefix) { return true }
        return overlayPids.contains(app.processID) && window.windowLayer >= overlayLayer
    }
    let filter = SCContentFilter(display: display, excludingWindows: excluded)
    let pointScale = Double(filter.pointPixelScale)
    var pixelWidth = Double(display.width) * pointScale
    var pixelHeight = Double(display.height) * pointScale
    if let width, width > 0, Double(width) < pixelWidth {
        pixelHeight = pixelHeight * Double(width) / pixelWidth
        pixelWidth = Double(width)
    }
    let config = SCStreamConfiguration()
    config.width = max(1, Int(pixelWidth.rounded()))
    config.height = max(1, Int(pixelHeight.rounded()))
    config.scalesToFit = true
    config.showsCursor = false
    config.captureResolution = .best
    let image = try await withSckTimeout(10, "capture the display") { try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) }
    return WindowImage(image: image, scale: Double(image.width) / max(1, Double(display.width)), frame: CGDisplayBounds(wanted))
}

func captureDisplayChecked(id: CGDirectDisplayID?, width: Int?, overlayPids: Set<pid_t>) async throws -> WindowImage {
    if #available(macOS 14.0, *) {
        return try await captureDisplay(id: id, width: width, overlayPids: overlayPids)
    }
    throw HelperError(code: "sck_unavailable", message: "SCScreenshotManager needs macOS 14 or later")
}

/// Crop a capture to `region` (points from its top-left). `scale` is image pixels per point.
func crop(_ captured: WindowImage, to region: CGRect) throws -> WindowImage {
    let s = captured.scale
    let pixels = CGRect(x: region.minX * s, y: region.minY * s, width: region.width * s, height: region.height * s)
        .integral.intersection(CGRect(x: 0, y: 0, width: captured.image.width, height: captured.image.height))
    guard !pixels.isNull, pixels.width >= 1, pixels.height >= 1, let cropped = captured.image.cropping(to: pixels) else {
        throw HelperError(code: "invalid_region", message: "The region lies outside the capture")
    }
    return WindowImage(image: cropped, scale: s, frame: captured.frame)
}

func captureWindowChecked(id: UInt32, width: Int?, scale: Double?, minPixelScale: Double = 1) async throws -> WindowImage {
    if #available(macOS 14.0, *) {
        return try await captureWindow(id: id, width: width, scale: scale, minPixelScale: minPixelScale)
    }
    throw HelperError(code: "sck_unavailable", message: "SCScreenshotManager needs macOS 14 or later")
}

func encode(_ image: CGImage, to path: String, format: String, quality: Double) throws -> Data {
    let type = (format == "png" ? UTType.png : UTType.jpeg).identifier as CFString
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, type, 1, nil) else {
        throw HelperError(code: "encode_failed", message: "Could not create an image destination")
    }
    let properties: [CFString: Any] = format == "png" ? [:] : [kCGImageDestinationLossyCompressionQuality: quality]
    CGImageDestinationAddImage(destination, image, properties as CFDictionary)
    guard CGImageDestinationFinalize(destination) else {
        throw HelperError(code: "encode_failed", message: "Could not encode the image")
    }
    try (data as Data).write(to: URL(fileURLWithPath: path), options: .atomic)
    return data as Data
}

func shortHash(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined().prefix(16).description
}

// MARK: - Vision OCR

func recognise(_ image: CGImage, region: CGRect?, languages: [String]?, fast: Bool) throws -> [[String: Any]] {
    var source = image
    var origin = CGPoint.zero
    if let region {
        let bounded = region.intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height)).integral
        guard !bounded.isNull, bounded.width >= 1, bounded.height >= 1, let cropped = image.cropping(to: bounded) else {
            throw HelperError(code: "invalid_region", message: "The region lies outside the image")
        }
        source = cropped
        origin = bounded.origin
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = fast ? .fast : .accurate
    request.usesLanguageCorrection = !fast
    if let languages, !languages.isEmpty { request.recognitionLanguages = languages }
    let handler = VNImageRequestHandler(cgImage: source, options: [:])
    try handler.perform([request])
    let width = Double(source.width)
    let height = Double(source.height)
    var lines: [[String: Any]] = []
    for observation in request.results ?? [] {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let box = observation.boundingBox  // normalised, bottom-left origin
        lines.append([
            "text": candidate.string,
            "confidence": Double(candidate.confidence),
            "box": [
                "x": Double(origin.x) + Double(box.minX) * width,
                "y": Double(origin.y) + (1 - Double(box.maxY)) * height,
                "w": Double(box.width) * width,
                "h": Double(box.height) * height,
            ],
        ])
    }
    return lines
}

func loadImage(_ path: String) throws -> CGImage {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw HelperError(code: "image_unreadable", message: "Could not read \(path)")
    }
    return image
}

func parseRegion(_ text: String?) throws -> CGRect? {
    guard let text else { return nil }
    let parts = text.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
    guard parts.count == 4, parts[2] > 0, parts[3] > 0 else {
        throw HelperError(code: "invalid_region", message: "--region expects x,y,w,h (points for capture and window OCR, image pixels for --image)")
    }
    return CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3])
}

// MARK: - Change detection for the live watcher (7.8)

/// A persistent SCStream was tried for the watcher first (2026-10-25): while one ran, a capture from any other process
/// hung, the stream stopped delivering frames, and captures stayed broken until the streaming process exited. So the
/// watcher samples with ordinary captures under the cross-server lock, and this keeps the last sample of each source in
/// the warm process to say what changed, without the server decoding an image.
final class Thumbnails: @unchecked Sendable {
    private let lock = NSLock()
    private var last: [String: (width: Int, height: Int, pixels: [UInt8])] = [:]
    func swap(_ key: String, _ value: (width: Int, height: Int, pixels: [UInt8])) -> (width: Int, height: Int, pixels: [UInt8])? {
        lock.lock(); defer { lock.unlock() }
        let previous = last[key]
        last[key] = value
        return previous
    }
}
let thumbnails = Thumbnails()

/// A small grey copy of the image (160 wide), enough to see a dialog, a line of text or a progress bar change.
func thumbnail(_ image: CGImage) -> (width: Int, height: Int, pixels: [UInt8])? {
    let width = 160
    let height = max(1, Int((Double(width) * Double(image.height) / max(1, Double(image.width))).rounded()))
    var pixels = [UInt8](repeating: 0, count: width * height)
    let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
        guard let context = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
                                      bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(),
                                      bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
        context.interpolationQuality = .medium
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return true
    }
    return drawn ? (width, height, pixels) : nil
}

/// The share of the thumbnail that changed by more than a few grey levels, and the box around it (fractions of the
/// image, top-left origin).
func difference(_ before: (width: Int, height: Int, pixels: [UInt8]), _ after: (width: Int, height: Int, pixels: [UInt8])) -> [String: Any] {
    guard before.width == after.width, before.height == after.height else { return ["changed": true, "area": 1.0, "resized": true] }
    var count = 0, minX = after.width, minY = after.height, maxX = -1, maxY = -1
    for y in 0..<after.height {
        for x in 0..<after.width {
            let index = y * after.width + x
            if abs(Int(before.pixels[index]) - Int(after.pixels[index])) > 12 {
                count += 1
                minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
            }
        }
    }
    guard count > 0 else { return ["changed": false, "area": 0.0] }
    let w = Double(after.width), h = Double(after.height)
    return [
        "changed": true,
        "area": (Double(count) / (w * h) * 10_000).rounded() / 10_000,
        "dirty": ["x": Double(minX) / w, "y": Double(minY) / h, "width": Double(maxX - minX + 1) / w, "height": Double(maxY - minY + 1) / h],
    ]
}

// MARK: - commands

func usage(_ message: String) -> HelperError { HelperError(code: "usage", message: message) }

/// One command, as a reply object. Errors are thrown; `main` and `serve` turn them into {"error": ...}.
func runCommand(_ args: [String]) async throws -> [String: Any] {
    guard let command = args.first else { throw usage("capture | ocr | serve | version") }
    switch command {
    case "version":
        var sck = false
        if #available(macOS 14.0, *) { sck = true }
        return ["version": helperVersion, "macos": ProcessInfo.processInfo.operatingSystemVersionString, "sck": sck]
    case "capture":
        guard let out = option("--out", in: args) else { throw usage("capture needs --out <file>") }
        let format = option("--format", in: args) ?? (out.lowercased().hasSuffix(".png") ? "png" : "jpeg")
        let quality = min(1, max(0.01, (Double(option("--quality", in: args) ?? "80") ?? 80) / 100))
        let region = try parseRegion(option("--region", in: args))
        let width = option("--width", in: args).flatMap { Int($0) }
        var captured: WindowImage
        var source: [String: Any]
        if let displayText = option("--display", in: args) {
            let id: CGDirectDisplayID? = displayText == "main" ? nil : CGDirectDisplayID(displayText)
            if displayText != "main" && id == nil { throw usage("--display expects a display id or main") }
            let pids = Set((option("--overlay-pids", in: args) ?? "").split(separator: ",").compactMap { pid_t($0) })
            // A region is cut from the full-resolution capture, so --width applies to the whole display only.
            captured = try await captureDisplayChecked(id: id, width: region == nil ? width : nil, overlayPids: pids)
            source = ["display": Int(id ?? CGMainDisplayID())]
        } else if let idText = option("--window", in: args), let id = UInt32(idText) {
            captured = try await captureWindowChecked(
                id: id, width: region == nil ? width : nil,
                scale: option("--scale", in: args).flatMap { Double($0) },
                minPixelScale: option("--min-scale", in: args).flatMap { Double($0) } ?? 1)
            source = ["window": Int(id)]
        } else {
            throw usage("capture needs --window <id> or --display <id|main>")
        }
        if let region { captured = try crop(captured, to: region) }
        // 7.8: --diff compares this capture with the previous one of the same source (the live watcher); with
        // --skip-unchanged an unchanged capture is not encoded at all.
        var diff: [String: Any]?
        if flag("--diff", in: args), let small = thumbnail(captured.image) {
            let key = option("--diff-key", in: args) ?? (source.map { "\($0.key):\($0.value)" }.joined() + (region.map { ":\($0)" } ?? ""))
            diff = thumbnails.swap(key, small).map { difference($0, small) } ?? ["changed": true, "area": 1.0, "first": true]
        }
        if let diff, diff["changed"] as? Bool == false, flag("--skip-unchanged", in: args) {
            var reply: [String: Any] = ["unchanged": true, "diff": diff, "width": captured.image.width, "height": captured.image.height,
                                        "scale": captured.scale, "frame": frameDict(captured.frame)]
            reply.merge(source) { first, _ in first }
            return reply
        }
        let data = try encode(captured.image, to: out, format: format, quality: quality)
        var reply: [String: Any] = [
            "path": out, "width": captured.image.width, "height": captured.image.height,
            "hash": shortHash(data), "scale": captured.scale, "frame": frameDict(captured.frame),
            "mimeType": format == "png" ? "image/png" : "image/jpeg", "bytes": data.count,
        ]
        reply.merge(source) { first, _ in first }
        if let region { reply["region"] = frameDict(region) }
        if let diff { reply["diff"] = diff }
        return reply
    case "ocr":
        var region = try parseRegion(option("--region", in: args))
        let languages = option("--languages", in: args)?.split(separator: ",").map { String($0) }
        let fast = flag("--fast", in: args)
        var result: [String: Any] = [:]
        let image: CGImage
        if let idText = option("--window", in: args), let id = UInt32(idText) {
            let captured = try await captureWindowChecked(id: id, width: nil, scale: nil, minPixelScale: 2)
            image = captured.image
            if let points = region {
                let s = captured.scale
                region = CGRect(x: points.minX * s, y: points.minY * s, width: points.width * s, height: points.height * s)
            }
            result["scale"] = captured.scale
            result["frame"] = frameDict(captured.frame)
        } else if let path = option("--image", in: args) {
            image = try loadImage(path)
        } else {
            throw usage("ocr needs --window <id> or --image <file>")
        }
        let started = Date()
        result["lines"] = try recognise(image, region: region, languages: languages, fast: fast)
        result["width"] = image.width
        result["height"] = image.height
        result["ocrMs"] = Int(Date().timeIntervalSince(started) * 1000)
        return result
    default:
        throw usage("unknown command \(command); expected capture | ocr | serve | version")
    }
}

func errorReply(_ error: Error) -> [String: Any] {
    if let error = error as? HelperError { return ["error": error.code, "message": error.message] }
    return ["error": "failed", "message": error.localizedDescription]
}

// MARK: - serve (7.7.0)

/// `serve [--idle-ms <ms>]`: one request per stdin line, `{"id": n, "args": ["capture", ...]}`, one reply per stdout
/// line with the same `id`. Starting this process, loading the frameworks and opening the WindowServer connection cost
/// about 200 ms of every one-shot capture; a capture in a warm process takes about 60 ms. The process exits when stdin
/// closes (the server is gone) or after --idle-ms without a request (default 60 s).
final class Idle: @unchecked Sendable {
    private let lock = NSLock()
    private var last = Date()
    private var busy = false
    func begin() { lock.lock(); busy = true; lock.unlock() }
    func end() { lock.lock(); busy = false; last = Date(); lock.unlock() }
    func expired(after seconds: Double) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return !busy && Date().timeIntervalSince(last) > seconds
    }
}

func serve(idleSeconds: Double) async {
    let idle = Idle()
    Thread.detachNewThread {
        while true {
            Thread.sleep(forTimeInterval: 1)
            if idle.expired(after: idleSeconds) { exit(0) }
        }
    }
    while let line = readLine(strippingNewline: true) {
        if line.isEmpty { continue }
        idle.begin()
        var reply: [String: Any]
        var id: Any = NSNull()
        if let data = line.data(using: .utf8),
           let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let requestArgs = request["args"] as? [String] {
            id = request["id"] ?? NSNull()
            if requestArgs.first == "serve" {
                reply = ["error": "usage", "message": "serve cannot be nested"]
            } else {
                do { reply = try await runCommand(requestArgs) } catch { reply = errorReply(error) }
            }
        } else {
            reply = ["error": "usage", "message": "expected {\"id\": n, \"args\": [...]}"]
        }
        reply["id"] = id
        emit(reply)
        // A stalled ScreenCaptureKit call is still running in this process, and the next capture would hang on it.
        if reply["error"] as? String == "sck_timeout" { exit(0) }
        idle.end()
    }
    exit(0)
}

// MARK: - main

let args = Array(CommandLine.arguments.dropFirst())
// Opens the WindowServer connection ScreenCaptureKit expects in a command-line tool.
_ = CGMainDisplayID()

if args.first == "serve" {
    let idleMs = option("--idle-ms", in: args).flatMap { Double($0) } ?? 60_000
    await serve(idleSeconds: max(1, idleMs / 1000))
}

do {
    emit(try await runCommand(args))
} catch {
    let reply = errorReply(error)
    emit(reply)
    exit(1)
}
