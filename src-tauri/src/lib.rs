pub mod broker;
pub mod buildhost;
pub mod fsdata;
pub mod gateway;
pub mod relay;
pub mod remote;

// The daemons above are Tauri-free, and the helper binaries only ever reach
// for those three modules. Everything desktop-side lives behind `gui` so
// `cargo build --no-default-features --bin agentbench-broker` links neither
// Tauri nor, on Linux, webkit2gtk — the whole point of running a broker on a
// headless VM.
#[cfg(feature = "gui")]
pub mod dictation;

// Cloudflare tunnel lifecycle. The Settings window starts and stops it; the
// gateway daemon runs the keep-alive watchdog, so this builds without the GUI.
pub mod tunnel;

#[cfg(feature = "gui")]
mod app;

#[cfg(feature = "gui")]
pub use app::run;
