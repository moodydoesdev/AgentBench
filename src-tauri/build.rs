fn main() {
    // Embed an Info.plist into the helper binaries on macOS. They run as bare
    // detached executables (no .app bundle), and TCC refuses to track — or
    // even display — a binary with no bundle identity, which is why Screen
    // Recording grants for broker-attributed captures could never stick.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
        for (bin, plist) in [
            ("agentbench-broker", "broker-Info.plist"),
            ("agentbench-gateway", "gateway-Info.plist"),
        ] {
            println!(
                "cargo:rustc-link-arg-bin={bin}=-Wl,-sectcreate,__TEXT,__info_plist,{dir}/{plist}"
            );
            println!("cargo:rerun-if-changed={dir}/{plist}");
        }
    }
    tauri_build::build()
}
