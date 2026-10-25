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
    println!("cargo::rustc-check-cfg=cfg(speech_analyzer)");
    // Without `gui` there is no webview to build for: tauri_build wants
    // ../dist to exist and regenerates gen/schemas, both pointless when all
    // we are producing is the broker or gateway binary on a headless box.
    if std::env::var_os("CARGO_FEATURE_GUI").is_some() {
        if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
            build_swift_dictation();
        }
        tauri_build::build()
    }
}

/// Compile swift/Dictation.swift (SpeechAnalyzer dictation, macOS 26+) into a
/// static library and link it, setting `cfg(speech_analyzer)`. Skipped — the
/// app falls back to SFSpeechRecognizer — when the SDK predates macOS 26,
/// since the file can't compile against it.
fn build_swift_dictation() {
    use std::process::Command;
    let dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let src = format!("{dir}/swift/Dictation.swift");
    println!("cargo:rerun-if-changed={src}");

    let xcrun = |args: &[&str]| -> Option<String> {
        let out = Command::new("xcrun").args(args).output().ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    };
    let sdk_major = xcrun(&["--sdk", "macosx", "--show-sdk-version"])
        .and_then(|v| v.split('.').next()?.parse::<u32>().ok())
        .unwrap_or(0);
    if sdk_major < 26 {
        println!("cargo:warning=macOS SDK {sdk_major} < 26: dictation uses SFSpeechRecognizer");
        return;
    }
    let sdk = xcrun(&["--sdk", "macosx", "--show-sdk-path"]).unwrap();
    let swiftc = xcrun(&["--sdk", "macosx", "--find", "swiftc"]).unwrap();

    let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        Ok(other) => other,
        Err(_) => "arm64",
    }
    .to_string();
    let out_dir = std::env::var("OUT_DIR").unwrap();
    let lib = format!("{out_dir}/libagentdictation.a");
    let status = Command::new(&swiftc)
        .args([
            "-emit-library",
            "-static",
            "-parse-as-library",
            "-swift-version",
            "5",
            "-O",
            "-module-name",
            "AgentDictation",
            "-sdk",
            &sdk,
            "-target",
            &format!("{arch}-apple-macos12.0"),
            &src,
            "-o",
            &lib,
        ])
        .status()
        .expect("run swiftc");
    assert!(status.success(), "swiftc failed on {src}");

    // The Swift runtime ships with the OS (/usr/lib/swift); the SDK has its
    // link stubs, the toolchain the back-deployment shims.
    let toolchain = std::path::Path::new(&swiftc)
        .parent()
        .and_then(|bin| bin.parent())
        .map(|usr| usr.join("lib/swift/macosx"))
        .unwrap();
    println!("cargo:rustc-link-search=native={out_dir}");
    println!("cargo:rustc-link-lib=static=agentdictation");
    println!("cargo:rustc-link-search=native={sdk}/usr/lib/swift");
    println!("cargo:rustc-link-search=native={}", toolchain.display());
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    for fw in ["Speech", "AVFoundation", "AVFAudio", "CoreMedia", "Foundation"] {
        println!("cargo:rustc-link-lib=framework={fw}");
    }
    println!("cargo:rustc-cfg=speech_analyzer");
}
