//! On-device dictation for the chat composer (macOS).
//!
//! Captures on `AVAudioEngine` and transcribes with `SFSpeechRecognizer`, the
//! same recognizer macOS dictation uses. Nothing leaves the machine and there
//! is no API key to configure.
//!
//! This lives in the app process on purpose. macOS only hands out the
//! microphone to a process it can name — one with a bundle whose Info.plist
//! carries a purpose string — and it enforces that by aborting the process,
//! not by returning an error. `agentbench-broker` is a bare executable with no
//! bundle, so dictation could never run there; `AgentBench.app` can. See
//! `Info.plist` and `Entitlements.plist`.
//!
//! Threading: `Retained<_>` handles are not `Send`, so the whole session lives
//! in a thread-local pinned to the main thread and every command hops there via
//! `run_on_main_thread`. The audio tap and the recognizer's result handler are
//! called back on their own queues, which is fine — they only touch an
//! `AppHandle` (Send + Sync) to emit events.

#[cfg(not(target_os = "macos"))]
mod unsupported {
    //! Windows and Linux have no on-device recognizer to bind to. The commands
    //! still exist so the IPC surface is uniform; `dictation_available` returns
    //! false and the chat composer hides the mic button.
    use tauri::AppHandle;

    #[tauri::command]
    pub fn dictation_available() -> bool {
        false
    }

    #[tauri::command]
    pub fn dictation_start(_app: AppHandle) -> Result<(), String> {
        Err("Dictation is only available on macOS.".into())
    }

    #[tauri::command]
    pub fn dictation_stop(_app: AppHandle) -> Result<(), String> {
        Ok(())
    }

    #[tauri::command]
    pub fn dictation_cancel(_app: AppHandle) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
pub use unsupported::*;

#[cfg(target_os = "macos")]
mod imp {
use std::cell::RefCell;
use std::ptr::NonNull;

use block2::RcBlock;
use objc2_avf_audio::{AVAudioEngine, AVAudioPCMBuffer, AVAudioTime};
use objc2_speech::{
    SFSpeechAudioBufferRecognitionRequest, SFSpeechRecognitionResult, SFSpeechRecognitionTask,
    SFSpeechRecognizer, SFSpeechRecognizerAuthorizationStatus,
};
use objc2::rc::Retained;
use objc2::AnyThread;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Bus 0 of the input node — the microphone.
const MIC_BUS: usize = 0;
/// ~0.25 s at 16 kHz. Small enough that partials feel live, large enough that
/// the audio thread isn't woken constantly.
const TAP_FRAMES: u32 = 4096;

pub const EV_PARTIAL: &str = "dictation://partial";
pub const EV_FINAL: &str = "dictation://final";
pub const EV_ERROR: &str = "dictation://error";
pub const EV_STATE: &str = "dictation://state";

#[derive(Clone, Serialize)]
struct TextEvent {
    text: String,
}

#[derive(Clone, Serialize)]
struct MessageEvent {
    message: String,
}

#[derive(Clone, Serialize)]
struct StateEvent {
    listening: bool,
}

struct Session {
    engine: Retained<AVAudioEngine>,
    request: Retained<SFSpeechAudioBufferRecognitionRequest>,
    task: Retained<SFSpeechRecognitionTask>,
    /// Transcript from recognition tasks that already finalised during this
    /// session. A recognition task is one *utterance*, not one session: the
    /// recognizer decides a phrase is over after a pause, finalises it, and
    /// the next thing said starts a fresh hypothesis from empty. Without
    /// keeping the finished text here, speaking a second time would render
    /// over the first.
    committed: String,
    /// Set by `dictation_stop`. Makes the next final end the session rather
    /// than re-arm.
    stopping: bool,
    /// Bumped on every re-arm. A superseded task can still deliver results
    /// after we've moved on; anything not stamped with the current value is
    /// dropped rather than folded in twice.
    generation: u64,
}

impl Session {
    /// Detach from the microphone. Safe to call twice — stopping an engine that
    /// is already stopped and removing an absent tap are both no-ops in
    /// AVFoundation, and we always pair them the same way.
    fn teardown(&self) {
        unsafe {
            self.engine.inputNode().removeTapOnBus(MIC_BUS);
            self.engine.stop();
        }
    }
}

thread_local! {
    /// Only ever touched on the main thread; see the module note on threading.
    static SESSION: RefCell<Option<Session>> = const { RefCell::new(None) };
}

/// Whether dictation can run at all: a recognizer exists for the user's locale
/// and it can transcribe without going to Apple's servers.
///
/// Deliberately does not consider authorization — a not-yet-granted mic is a
/// prompt waiting to happen, not an unavailable feature, and the button should
/// still be there to trigger it.
#[tauri::command]
pub fn dictation_available() -> bool {
    recognizer().is_some_and(|r| unsafe { r.isAvailable() && r.supportsOnDeviceRecognition() })
}

/// A recognizer for the user's language. `None` when that language has no
/// dictation support — `new()` would assert on the nil the initializer is
/// documented to return, so go through `init` and keep the `Option`.
fn recognizer() -> Option<Retained<SFSpeechRecognizer>> {
    unsafe { SFSpeechRecognizer::init(SFSpeechRecognizer::alloc()) }
}

/// Begin listening. Idempotent: starting while already listening is a no-op, so
/// a held key that repeats can't stack sessions on one microphone.
///
/// Returns as soon as the request is queued. Everything the caller cares about
/// arrives as events: `dictation://state` once the mic is actually live, then
/// `dictation://partial` per revision, and finally `dictation://final`.
#[tauri::command]
pub fn dictation_start(app: AppHandle) -> Result<(), String> {
    on_main(&app, move |app| {
        if SESSION.with_borrow(|s| s.is_some()) {
            return;
        }
        // Speech recognition is a second consent, distinct from the mic: the
        // recognizer refuses to produce anything until it is granted, so ask
        // first and only then touch the audio hardware. On the very first run
        // this is where the system prompt appears.
        let handler = RcBlock::new(move |status: SFSpeechRecognizerAuthorizationStatus| {
            let app = app.clone();
            let granted = status == SFSpeechRecognizerAuthorizationStatus::Authorized;
            // The callback is explicitly not promised on the main thread.
            let _ = app.clone().run_on_main_thread(move || {
                if !granted {
                    fail(&app, "Speech recognition is not allowed. Enable AgentBench under System Settings → Privacy & Security → Speech Recognition.");
                    return;
                }
                if let Err(e) = begin(&app) {
                    fail(&app, &e);
                }
            });
        });
        unsafe { SFSpeechRecognizer::requestAuthorization(&handler) };
    })
}

/// Stop listening and let the recognizer finish. The last partial is not the
/// final text — `endAudio` lets it re-score the tail — so the caller must wait
/// for `dictation://final` rather than using whatever it has.
#[tauri::command]
pub fn dictation_stop(app: AppHandle) -> Result<(), String> {
    on_main(&app, |app| {
        // Drop the tap and the engine now, but keep the task alive: its result
        // handler still owes us one call with `isFinal`.
        let request = SESSION.with_borrow(|s| {
            s.as_ref().inspect(|s| s.teardown()).map(|s| s.request.clone())
        });
        if let Some(request) = request {
            unsafe { request.endAudio() };
        }
        app.emit(EV_STATE, StateEvent { listening: false }).ok();
    })
}

/// Abandon the session and emit nothing further — Esc, or the composer going
/// away mid-phrase.
#[tauri::command]
pub fn dictation_cancel(app: AppHandle) -> Result<(), String> {
    on_main(&app, |app| {
        if let Some(session) = SESSION.with_borrow_mut(|s| s.take()) {
            session.teardown();
            unsafe { session.task.cancel() };
        }
        app.emit(EV_STATE, StateEvent { listening: false }).ok();
    })
}

/// Open the microphone and arm the first recognition task. Main thread only.
fn begin(app: &AppHandle) -> Result<(), String> {
    let engine = unsafe { AVAudioEngine::new() };
    let (request, task) = arm(app, &engine, 0)?;
    unsafe { engine.prepare() };
    // The first `startAndReturnError` is what actually opens the mic, and so
    // what trips the microphone prompt (or fails if it was denied).
    if let Err(e) = unsafe { engine.startAndReturnError() } {
        unsafe {
            engine.inputNode().removeTapOnBus(MIC_BUS);
            task.cancel();
        }
        return Err(e.localizedDescription().to_string());
    }

    SESSION.with_borrow_mut(|s| {
        *s = Some(Session {
            engine,
            request,
            task,
            committed: String::new(),
            stopping: false,
            generation: 0,
        })
    });
    app.emit(EV_STATE, StateEvent { listening: true }).ok();
    Ok(())
}

/// Point a fresh recognition task at the microphone and return its request and
/// task. Deliberately does not touch the engine: re-arming mid-session leaves
/// it running, so the mic is never reopened and macOS never re-prompts partway
/// through a sentence.
fn arm(
    app: &AppHandle,
    engine: &AVAudioEngine,
    generation: u64,
) -> Result<
    (
        Retained<SFSpeechAudioBufferRecognitionRequest>,
        Retained<SFSpeechRecognitionTask>,
    ),
    String,
> {
    let recognizer =
        recognizer().ok_or("No speech recognizer is available for your language.")?;

    let request = unsafe { SFSpeechAudioBufferRecognitionRequest::new() };
    unsafe {
        request.setShouldReportPartialResults(true);
        // Keep the audio on the device. Without this the recognizer may stream
        // to Apple, and it caps sessions at about a minute.
        request.setRequiresOnDeviceRecognition(true);
        request.setAddsPunctuation(true);
    }

    let task = {
        let app = app.clone();
        let handler = RcBlock::new(
            move |result: *mut SFSpeechRecognitionResult, error: *mut objc2_foundation::NSError| {
                // A result and an error are mutually exclusive per call.
                if let Some(result) = unsafe { result.as_ref() } {
                    let text =
                        unsafe { result.bestTranscription().formattedString() }.to_string();
                    let is_final = unsafe { result.isFinal() };
                    deliver(&app, generation, Ok((text, is_final)));
                } else if let Some(error) = unsafe { error.as_ref() } {
                    deliver(
                        &app,
                        generation,
                        Err(error.localizedDescription().to_string()),
                    );
                }
            },
        );
        unsafe { recognizer.recognitionTaskWithRequest_resultHandler(&request, &handler) }
    };

    let input = unsafe { engine.inputNode() };
    // Tap in the hardware's own format. Asking for a different one here makes
    // the engine throw at install time, and the recognizer resamples anyway.
    let format = unsafe { input.outputFormatForBus(MIC_BUS) };
    if unsafe { format.channelCount() } == 0 {
        unsafe { task.cancel() };
        return Err("No microphone input is available.".into());
    }

    let tap = {
        let request = request.clone();
        RcBlock::new(
            move |buffer: NonNull<AVAudioPCMBuffer>, _when: NonNull<AVAudioTime>| {
                unsafe { request.appendAudioPCMBuffer(buffer.as_ref()) };
            },
        )
    };
    unsafe {
        // A bus carries one tap; drop the previous task's before installing
        // this one. No-op on the first arm. installTapOnBus copies the block,
        // so it need not outlive this call.
        input.removeTapOnBus(MIC_BUS);
        input.installTapOnBus_bufferSize_format_block(
            MIC_BUS,
            TAP_FRAMES,
            Some(&format),
            &*tap as *const _ as *mut _,
        );
    }
    Ok((request, task))
}

/// Fold one recognizer callback into the session. Hops to the main thread
/// because the callback arrives on the recognizer's own queue.
fn deliver(app: &AppHandle, generation: u64, result: Result<(String, bool), String>) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        let current = SESSION
            .with_borrow(|s| s.as_ref().map(|s| s.generation))
            .is_some_and(|g| g == generation);
        if !current {
            return;
        }
        match result {
            Err(message) => fail(&app, &message),
            // Partials are revisions of the live utterance, so the UI gets the
            // finished text plus the current hypothesis, never the hypothesis
            // alone.
            Ok((text, false)) => {
                if let Some(text) =
                    SESSION.with_borrow(|s| s.as_ref().map(|s| joined(&s.committed, &text)))
                {
                    app.emit(EV_PARTIAL, TextEvent { text }).ok();
                }
            }
            Ok((text, true)) => commit(&app, text),
        }
    });
}

/// A task finalised. Either the user asked to stop, which ends the phrase, or
/// the recognizer decided the utterance was over by itself — in which case
/// dictation carries on under a fresh task and the mic never closes.
fn commit(app: &AppHandle, text: String) {
    let Some((stopping, committed)) = SESSION.with_borrow_mut(|s| {
        let session = s.as_mut()?;
        session.committed = joined(&session.committed, &text);
        Some((session.stopping, session.committed.clone()))
    }) else {
        return;
    };

    if stopping {
        if let Some(session) = SESSION.with_borrow_mut(|s| s.take()) {
            session.teardown();
        }
        app.emit(EV_FINAL, TextEvent { text: committed }).ok();
        app.emit(EV_STATE, StateEvent { listening: false }).ok();
        return;
    }

    let Some((engine, generation)) = SESSION.with_borrow_mut(|s| {
        let session = s.as_mut()?;
        session.generation += 1;
        Some((session.engine.clone(), session.generation))
    }) else {
        return;
    };
    match arm(app, &engine, generation) {
        Ok((request, task)) => {
            SESSION.with_borrow_mut(|s| {
                if let Some(session) = s.as_mut() {
                    session.request = request;
                    session.task = task;
                }
            });
            // Re-render so the just-finalised words stop looking provisional.
            app.emit(EV_PARTIAL, TextEvent { text: committed }).ok();
        }
        Err(e) => fail(app, &e),
    }
}

/// Join two transcript fragments with exactly one space, and without a leading
/// one when the left side is still empty.
fn joined(left: &str, right: &str) -> String {
    match (left.trim_end(), right.trim()) {
        ("", r) => r.to_string(),
        (l, "") => l.to_string(),
        (l, r) => format!("{l} {r}"),
    }
}

/// Report a failure to the UI and make sure nothing is left holding the mic.
fn fail(app: &AppHandle, message: &str) {
    if let Some(session) = SESSION.with_borrow_mut(|s| s.take()) {
        session.teardown();
        unsafe { session.task.cancel() };
    }
    app.emit(
        EV_ERROR,
        MessageEvent {
            message: message.to_string(),
        },
    )
    .ok();
    app.emit(EV_STATE, StateEvent { listening: false }).ok();
}

fn on_main(
    app: &AppHandle,
    f: impl FnOnce(AppHandle) + Send + 'static,
) -> Result<(), String> {
    let app2 = app.clone();
    app.run_on_main_thread(move || f(app2))
        .map_err(|e| e.to_string())
}
}

#[cfg(target_os = "macos")]
pub use imp::*;
