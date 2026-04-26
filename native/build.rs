extern crate napi_build;
fn main() {
    napi_build::setup();

    // Link macOS frameworks — only needed when compiling for macOS.
    // Windows linking is handled automatically by the windows-rs build script.
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=CoreGraphics");
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
        println!("cargo:rustc-link-lib=framework=ApplicationServices");
        println!("cargo:rustc-link-lib=framework=ImageIO");
    }
}
