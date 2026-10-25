//! Streaming dictation for browsers: NVIDIA Parakeet (TDT 0.6B, int8 ONNX)
//! run through sherpa-onnx, fed 16 kHz mono PCM over a WebSocket.
//!
//! Parakeet is an offline model — it transcribes a clip, not a stream — so
//! streaming is built around it. Silero VAD cuts the audio into utterances at
//! pauses; the utterance in progress is re-transcribed every half second for
//! the live text, and each finished one is transcribed once more, whole, and
//! committed. The browser's own recognizer gives up after a second or two of
//! silence; this keeps going until the user stops.
//!
//! Models live in `<config>/models/` (see [`model_dir`]). Without them — or in
//! a build without the `parakeet` feature — [`available`] is false and the
//! browser falls back to the Web Speech API.

use std::path::PathBuf;

/// Parakeet's folder and the VAD file inside `<config>/models/`, as the k2-fsa
/// release archives unpack.
const PARAKEET_DIR: &str = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8";
const VAD_FILE: &str = "silero_vad.onnx";

pub const SAMPLE_RATE: i32 = 16_000;

pub fn model_dir() -> PathBuf {
    crate::broker::config_dir().join("models")
}

fn parakeet_file(name: &str) -> PathBuf {
    model_dir().join(PARAKEET_DIR).join(name)
}

/// Whether this gateway can transcribe: built with the engine and holding
/// every model file it needs.
pub fn available() -> bool {
    cfg!(feature = "parakeet")
        && ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"]
            .iter()
            .all(|f| parakeet_file(f).is_file())
        && model_dir().join(VAD_FILE).is_file()
}

/// What a session reports back. `text` is always the whole transcript so far,
/// matching the desktop dictation contract: callers replace, never append.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Partial(String),
    Final(String),
    Error(String),
}

#[cfg(feature = "parakeet")]
pub use engine::Session;

#[cfg(feature = "parakeet")]
mod engine {
    use super::*;
    use sherpa_onnx::{
        OfflineRecognizer, OfflineRecognizerConfig, OfflineTransducerModelConfig,
        SileroVadModelConfig, VadModelConfig, VoiceActivityDetector,
    };
    use std::sync::{Mutex, OnceLock};

    /// How much new audio buys another live re-transcription.
    const PARTIAL_EVERY: usize = SAMPLE_RATE as usize / 2;
    /// Silero's frame. The detector buffers odd sizes itself, but feeding it
    /// whole frames keeps `detected()` in step with what was sent.
    const VAD_WINDOW: usize = 512;

    /// One recognizer for the process: loading Parakeet takes a few seconds and
    /// ~700 MB, so it happens on first use and then stays. Decoding takes
    /// `&self` and the C API is thread-safe per stream.
    fn recognizer() -> Result<&'static OfflineRecognizer, String> {
        static REC: OnceLock<Result<OfflineRecognizer, String>> = OnceLock::new();
        static LOADING: Mutex<()> = Mutex::new(());
        if let Some(r) = REC.get() {
            return r.as_ref().map_err(Clone::clone);
        }
        let _guard = LOADING.lock().unwrap_or_else(|e| e.into_inner());
        REC.get_or_init(|| {
            let path = |f: &str| Some(parakeet_file(f).to_string_lossy().into_owned());
            let mut config = OfflineRecognizerConfig::default();
            config.model_config.transducer = OfflineTransducerModelConfig {
                encoder: path("encoder.int8.onnx"),
                decoder: path("decoder.int8.onnx"),
                joiner: path("joiner.int8.onnx"),
            };
            config.model_config.tokens = path("tokens.txt");
            config.model_config.model_type = Some("nemo_transducer".into());
            config.model_config.num_threads = std::thread::available_parallelism()
                .map(|n| (n.get() / 2).clamp(1, 4) as i32)
                .unwrap_or(2);
            OfflineRecognizer::create(&config)
                .ok_or_else(|| "could not load the Parakeet model".to_string())
        })
        .as_ref()
        .map_err(Clone::clone)
    }

    fn transcribe(rec: &OfflineRecognizer, samples: &[f32]) -> String {
        if samples.is_empty() {
            return String::new();
        }
        let stream = rec.create_stream();
        stream.accept_waveform(SAMPLE_RATE, samples);
        rec.decode(&stream);
        stream
            .get_result()
            .map(|r| r.text.trim().to_string())
            .unwrap_or_default()
    }

    /// One press of the mic. Blocking: feed it from a dedicated thread.
    pub struct Session {
        rec: &'static OfflineRecognizer,
        vad: VoiceActivityDetector,
        /// Finished utterances, transcribed.
        committed: Vec<String>,
        /// Audio since the last commit, for the live re-transcription. Holds a
        /// little leading silence too, which Parakeet ignores.
        pending: Vec<f32>,
        /// Samples not yet a whole VAD frame.
        spill: Vec<f32>,
        since_partial: usize,
        last_sent: String,
    }

    impl Session {
        pub fn new() -> Result<Self, String> {
            let rec = recognizer()?;
            let vad_config = VadModelConfig {
                silero_vad: SileroVadModelConfig {
                    model: Some(model_dir().join(VAD_FILE).to_string_lossy().into_owned()),
                    threshold: 0.5,
                    // Long enough that a breath mid-sentence doesn't cut it.
                    min_silence_duration: 0.6,
                    min_speech_duration: 0.25,
                    window_size: VAD_WINDOW as i32,
                    // Parakeet handles long clips, but re-transcribing one for
                    // every partial gets slow; split monologues.
                    max_speech_duration: 20.0,
                },
                sample_rate: SAMPLE_RATE,
                num_threads: 1,
                ..Default::default()
            };
            let vad = VoiceActivityDetector::create(&vad_config, 60.0)
                .ok_or_else(|| "could not load the voice-activity model".to_string())?;
            Ok(Self {
                rec,
                vad,
                committed: Vec::new(),
                pending: Vec::new(),
                spill: Vec::new(),
                since_partial: 0,
                last_sent: String::new(),
            })
        }

        fn joined(&self, tail: &str) -> String {
            let mut parts: Vec<&str> = self.committed.iter().map(String::as_str).collect();
            if !tail.is_empty() {
                parts.push(tail);
            }
            parts.join(" ")
        }

        /// Move every utterance the VAD has closed into `committed`.
        fn drain_segments(&mut self) -> bool {
            let mut any = false;
            while let Some(seg) = self.vad.front() {
                let text = transcribe(self.rec, seg.samples());
                self.vad.pop();
                if !text.is_empty() {
                    self.committed.push(text);
                }
                any = true;
            }
            if any {
                // The VAD holds its own copy of anything still being spoken,
                // but `pending` can't tell where the closed utterance ended.
                // Keep only what's after it — at most the VAD's hangover.
                let keep = if self.vad.detected() { SAMPLE_RATE as usize } else { 0 };
                let cut = self.pending.len().saturating_sub(keep);
                self.pending.drain(..cut);
                self.since_partial = 0;
            }
            any
        }

        /// Feed audio; returns the new transcript if it changed.
        pub fn push(&mut self, samples: &[f32]) -> Option<Event> {
            self.spill.extend_from_slice(samples);
            let whole = self.spill.len() / VAD_WINDOW * VAD_WINDOW;
            if whole > 0 {
                let frames: Vec<f32> = self.spill.drain(..whole).collect();
                self.vad.accept_waveform(&frames);
            }
            self.pending.extend_from_slice(samples);
            self.since_partial += samples.len();

            let closed = self.drain_segments();
            let speaking = self.vad.detected();
            if !speaking {
                // Silence between utterances: nothing to re-transcribe, and
                // letting it pile up would just pad the next one.
                let keep = SAMPLE_RATE as usize / 2;
                if self.pending.len() > keep {
                    let cut = self.pending.len() - keep;
                    self.pending.drain(..cut);
                }
            }
            let text = if speaking && self.since_partial >= PARTIAL_EVERY {
                self.since_partial = 0;
                let live = transcribe(self.rec, &self.pending);
                self.joined(&live)
            } else if closed {
                self.joined("")
            } else {
                return None;
            };
            if text == self.last_sent {
                return None;
            }
            self.last_sent = text.clone();
            Some(Event::Partial(text))
        }

        /// The user let go: close whatever is still open and return it all.
        pub fn finish(mut self) -> Event {
            if !self.spill.is_empty() {
                let rest = std::mem::take(&mut self.spill);
                self.vad.accept_waveform(&rest);
            }
            self.vad.flush();
            let before = self.committed.len();
            self.drain_segments();
            // A last word too short for the VAD to call speech still showed up
            // in the live text; don't drop it at the finish.
            if self.committed.len() == before && !self.last_sent.is_empty() {
                return Event::Final(self.last_sent);
            }
            Event::Final(self.joined(""))
        }
    }
}

/// Little-endian 16-bit PCM, the wire format, to the float samples sherpa
/// takes.
pub fn pcm16_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pcm_decodes_little_endian() {
        let v = pcm16_to_f32(&[0x00, 0x40, 0x00, 0xC0, 0xFF]);
        assert_eq!(v, vec![0.5, -0.5]);
    }

    /// Streams the model's own sample recording through a session the way a
    /// phone would, in 100 ms chunks. Needs the models installed.
    #[cfg(feature = "parakeet")]
    #[test]
    #[ignore]
    fn streams_sample_wav() {
        let wav = model_dir().join(PARAKEET_DIR).join("test_wavs/0.wav");
        let wave = sherpa_onnx::Wave::read(&wav.to_string_lossy()).expect("sample wav");
        assert_eq!(wave.sample_rate(), SAMPLE_RATE);
        let mut session = Session::new().expect("session");
        let started = std::time::Instant::now();
        for chunk in wave.samples().chunks(1600) {
            if let Some(ev) = session.push(chunk) {
                eprintln!("{:>6.2}s {ev:?}", started.elapsed().as_secs_f32());
            }
        }
        let fin = session.finish();
        eprintln!("final {fin:?}");
        let Event::Final(text) = fin else { panic!("no final") };
        assert!(text.len() > 20, "{text}");
    }
}
