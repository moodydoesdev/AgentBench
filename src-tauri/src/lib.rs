pub mod broker;
pub mod fsdata;
pub mod gateway;

// The daemons above are Tauri-free, and the helper binaries only ever reach
// for those three modules. Everything desktop-side lives behind `gui` so
// `cargo build --no-default-features --bin agentbench-broker` links neither
// Tauri nor, on Linux, webkit2gtk — the whole point of running a broker on a
// headless VM.
#[cfg(feature = "gui")]
pub mod dictation;

#[cfg(feature = "gui")]
mod app;

#[cfg(feature = "gui")]
pub use app::run;
