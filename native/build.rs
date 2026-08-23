extern crate napi_build;
fn main() {
    napi_build::setup();

    // `cfg(target_os)` in a build script describes the machine running the
    // script, not Cargo's compilation target. Use Cargo's target metadata so
    // macOS hosts can validate the Windows crate (and vice versa) without
    // emitting impossible framework link directives.
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();

    // Link macOS frameworks — only needed when compiling for macOS.
    // Windows linking is handled automatically by the windows-rs build script.
    if target_os == "macos" {
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=CoreGraphics");
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
        println!("cargo:rustc-link-lib=framework=ApplicationServices");
        println!("cargo:rustc-link-lib=framework=ImageIO");
    }

    // Link X11 libraries on Linux.
    if target_os == "linux" {
        println!("cargo:rustc-link-lib=X11");
        println!("cargo:rustc-link-lib=Xtst");
        println!("cargo:rustc-link-lib=Xrandr");
    }
}
