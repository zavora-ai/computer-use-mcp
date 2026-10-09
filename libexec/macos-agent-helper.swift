// computer-use-mcp macOS agent helper (v7.5).
//
// Compiled on first use by src/session/macos-helper.ts with `swiftc -O` into
// ~/Library/Caches/computer-use-mcp/macos-agent-helper-<sha8> and signed ad hoc.
// Every subcommand prints one JSON object on stdout; failures print {"error": ...}
// and exit 1. Nothing here activates an app, moves the pointer or touches the network.
//
//   capture --window <id> --out <file> [--width <px>] [--scale <s>] [--min-scale <s>] [--format png|jpeg] [--quality <1-100>]
//       ScreenCaptureKit (SCScreenshotManager, macOS 14+): the window alone, even when
//       covered, without its shadow, never activated. -> {path, width, height, hash, scale, frame}
//   ocr (--window <id> | --image <file>) [--region x,y,w,h] [--languages en-US,...] [--fast]
//       Vision text recognition, on device. Boxes are image pixels, top-left origin.
//       --region is in window points with --window, in image pixels with --image.
//       -> {width, height, scale, frame?, lines: [{text, confidence, box: {x, y, w, h}}]}
//   version -> {version, macos, sck}

import CoreGraphics
import CryptoKit
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers
import Vision

let helperVersion = "7.5.0"

struct HelperError: Error {
    let code: String
    let message: String
}

func emit(_ object: [String: Any]) {
    let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func fail(_ code: String, _ message: String) -> Never {
    emit(["error": code, "message": message])
    exit(1)
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

/// ScreenCaptureKit can stall indefinitely when another process is capturing at the same time (measured
/// 2026-10-09: two helpers side by side both hung). A stall becomes a JSON error the caller can act on.
func withSckTimeout<T: Sendable>(_ seconds: Double, _ what: String, _ operation: @escaping @Sendable () async throws -> T) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await operation() }
        group.addTask {
            try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            throw HelperError(code: "sck_timeout", message: "ScreenCaptureKit did not \(what) within \(Int(seconds)) s (another capture may be running)")
        }
        guard let first = try await group.next() else { throw HelperError(code: "sck_timeout", message: "ScreenCaptureKit returned nothing") }
        group.cancelAll()
        return first
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
        throw HelperError(code: "invalid_region", message: "--region expects x,y,w,h in image pixels")
    }
    return CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3])
}

// MARK: - main

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { fail("usage", "capture | ocr | version") }
// Opens the WindowServer connection ScreenCaptureKit expects in a command-line tool.
_ = CGMainDisplayID()

do {
    switch command {
    case "version":
        var sck = false
        if #available(macOS 14.0, *) { sck = true }
        emit(["version": helperVersion, "macos": ProcessInfo.processInfo.operatingSystemVersionString, "sck": sck])
    case "capture":
        guard let idText = option("--window", in: args), let id = UInt32(idText) else { fail("usage", "capture needs --window <id>") }
        guard let out = option("--out", in: args) else { fail("usage", "capture needs --out <file>") }
        let format = option("--format", in: args) ?? (out.lowercased().hasSuffix(".png") ? "png" : "jpeg")
        let quality = min(1, max(0.01, (Double(option("--quality", in: args) ?? "80") ?? 80) / 100))
        let captured = try await captureWindowChecked(
            id: id, width: option("--width", in: args).flatMap { Int($0) },
            scale: option("--scale", in: args).flatMap { Double($0) },
            minPixelScale: option("--min-scale", in: args).flatMap { Double($0) } ?? 1)
        let data = try encode(captured.image, to: out, format: format, quality: quality)
        emit([
            "path": out, "width": captured.image.width, "height": captured.image.height,
            "hash": shortHash(data), "scale": captured.scale, "frame": frameDict(captured.frame),
            "mimeType": format == "png" ? "image/png" : "image/jpeg", "bytes": data.count,
        ])
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
            fail("usage", "ocr needs --window <id> or --image <file>")
        }
        let started = Date()
        result["lines"] = try recognise(image, region: region, languages: languages, fast: fast)
        result["width"] = image.width
        result["height"] = image.height
        result["ocrMs"] = Int(Date().timeIntervalSince(started) * 1000)
        emit(result)
    default:
        fail("usage", "unknown command \(command); expected capture | ocr | version")
    }
} catch let error as HelperError {
    fail(error.code, error.message)
} catch {
    fail("failed", error.localizedDescription)
}
