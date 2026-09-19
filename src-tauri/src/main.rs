// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(feature = "gui")]
fn main() {
    agentbench_lib::run()
}

// `cargo build --no-default-features` is how the daemons are built for a
// headless Linux VM. It still compiles every bin target in the package, so
// this one needs a body that does not reach for Tauri.
#[cfg(not(feature = "gui"))]
fn main() {
    eprintln!("agentbench: built without the `gui` feature; run agentbench-broker instead");
    std::process::exit(1);
}
