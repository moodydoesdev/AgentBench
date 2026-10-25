//! Text-to-speech for spoken readouts (`<spoken>…</spoken>` lines Claude ends
//! a reply with) and the chat's read-aloud button. Two engines:
//!
//! - **ElevenLabs** (`eleven_v4` / `eleven_v4_turbo`): natural and fast, but
//!   the text goes to their API. Needs the user's API key, which stays on the
//!   workstation (`speech-secret.json`, 0600) and is never sent to clients.
//! - **Kokoro** (82M, int8 ONNX) through sherpa-onnx — the engine dictation
//!   uses, pointed the other way. Fully local; slow when the CPU is busy.
//!
//! The desktop calls [`synth_json`] in-process, browsers and phones reach it
//! through the gateway's `speak_text` read; both get base64 audio back.
//!
//! The model lives in `<config>/models/` next to Parakeet. Without it — or in
//! a build without the `parakeet` feature — [`available`] is false and the
//! chat hides its speaker buttons.

use std::path::PathBuf;

/// Kokoro's folder inside `<config>/models/`, as the k2-fsa archive unpacks.
const KOKORO_DIR: &str = "kokoro-int8-multi-lang-v1_0";

/// Kokoro v1.0's speaker table, in `voices.bin` order — `sid` is the index.
/// Only the English voices are offered; the other 26 are other languages.
pub const VOICES: &[&str] = &[
    "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore", "af_nicole",
    "af_nova", "af_river", "af_sarah", "af_sky", "am_adam", "am_echo", "am_eric",
    "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck", "am_santa", "bf_alice",
    "bf_emma", "bf_isabella", "bf_lily", "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
];

pub const DEFAULT_VOICE: &str = "af_heart";

fn kokoro_file(name: &str) -> PathBuf {
    super::dictate::model_dir().join(KOKORO_DIR).join(name)
}

pub fn available() -> bool {
    cfg!(feature = "parakeet")
        && ["model.int8.onnx", "voices.bin", "tokens.txt", "lexicon-us-en.txt"]
            .iter()
            .all(|f| kokoro_file(f).is_file())
        && kokoro_file("espeak-ng-data").is_dir()
}

/// Strip what reads badly aloud: code, markup, links, paths' noise. Spoken
/// readouts are already plain; this is for the read-whole-message button.
pub fn speakable(text: &str) -> String {
    let mut out = String::new();
    let mut in_fence = false;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        // tables and fenced code are for eyes
        if in_fence || t.starts_with('|') {
            continue;
        }
        let t = t.trim_start_matches(['#', '>', '-', '*', ' ']);
        if t.is_empty() {
            continue;
        }
        out.push_str(t);
        out.push_str(if t.ends_with(['.', '!', '?', ':']) { " " } else { ". " });
    }
    // inline markup: drop backticks/emphasis, keep link text
    let mut s = String::with_capacity(out.len());
    let mut chars = out.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '`' | '*' | '_' => {}
            '[' => {
                let label: String = chars.by_ref().take_while(|&c| c != ']').collect();
                s.push_str(&label);
                if chars.peek() == Some(&'(') {
                    for c in chars.by_ref() {
                        if c == ')' {
                            break;
                        }
                    }
                }
            }
            _ => s.push(c),
        }
    }
    // a long message read whole is a podcast nobody asked for
    let s = s.trim();
    if s.chars().count() > 1500 {
        let cut: String = s.chars().take(1500).collect();
        match cut.rfind(". ") {
            Some(i) => cut[..=i].to_string(),
            None => cut,
        }
    } else {
        s.to_string()
    }
}

/// Shared speech settings, `<config>/speech.json`. The broker reads
/// `readouts` to decide whether new sessions get the readout instructions;
/// the rest pick the machine's voice wherever it's heard:
/// `{ readouts, engine: "elevenlabs"|"kokoro", voice, speed,
///    elevenModel, elevenVoice, elevenVoiceName }`.
fn prefs_path() -> PathBuf {
    crate::broker::config_dir().join("speech.json")
}

fn secret_path() -> PathBuf {
    crate::broker::config_dir().join("speech-secret.json")
}

pub const ELEVEN_MODELS: &[&str] = &["eleven_v4", "eleven_v4_turbo"];
/// "Rachel", ElevenLabs' long-standing premade voice — every account has it.
const ELEVEN_DEFAULT_VOICE: (&str, &str) = ("21m00Tcm4TlvDq8ikWAM", "Rachel");

fn eleven_key() -> Option<String> {
    std::fs::read_to_string(secret_path())
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v["elevenlabsKey"].as_str().map(str::to_string))
        .filter(|k| !k.trim().is_empty())
}

fn saved_prefs() -> serde_json::Value {
    std::fs::read_to_string(prefs_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// Settings as clients see them — `hasKey`, never the key.
pub fn prefs() -> serde_json::Value {
    let saved = saved_prefs();
    let has_key = eleven_key().is_some();
    let engine = match saved["engine"].as_str() {
        Some("kokoro") => "kokoro",
        Some("elevenlabs") => "elevenlabs",
        // first run: the good voice if a key is there, else the local one
        _ if has_key => "elevenlabs",
        _ => "kokoro",
    };
    let available = match engine {
        "elevenlabs" => has_key,
        _ => available(),
    };
    serde_json::json!({
        "readouts": saved["readouts"].as_bool().unwrap_or(false),
        // machine-wide and off by default: every screen showing the chat
        // (desktop, phone, browser) would otherwise speak — and spend credits
        "autoplay": saved["autoplay"].as_bool().unwrap_or(false),
        "engine": engine,
        "available": available,
        "kokoroAvailable": self::available(),
        "hasKey": has_key,
        "voice": saved["voice"].as_str().filter(|v| VOICES.contains(v)).unwrap_or(DEFAULT_VOICE),
        "voices": VOICES,
        "speed": saved["speed"].as_f64().unwrap_or(1.0),
        "elevenModel": saved["elevenModel"].as_str().filter(|m| ELEVEN_MODELS.contains(m)).unwrap_or(ELEVEN_MODELS[0]),
        "elevenModels": ELEVEN_MODELS,
        "elevenVoice": saved["elevenVoice"].as_str().unwrap_or(ELEVEN_DEFAULT_VOICE.0),
        "elevenVoiceName": saved["elevenVoiceName"].as_str().unwrap_or(ELEVEN_DEFAULT_VOICE.1),
    })
}

const PREF_KEYS: &[&str] = &["readouts", "autoplay", "engine", "voice", "speed", "elevenModel", "elevenVoice", "elevenVoiceName"];

/// Merge `patch` into the saved settings. `elevenlabsKey` is write-only: it
/// goes to the secret file (an empty string removes it).
pub fn set_prefs(patch: &serde_json::Value) -> Result<serde_json::Value, String> {
    if let Some(key) = patch["elevenlabsKey"].as_str() {
        let path = secret_path();
        if key.trim().is_empty() {
            let _ = std::fs::remove_file(&path);
        } else {
            std::fs::write(&path, serde_json::json!({ "elevenlabsKey": key.trim() }).to_string())
                .map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
            }
        }
        *VOICE_CACHE.lock().unwrap() = None;
    }
    let mut saved = saved_prefs();
    if !saved.is_object() {
        saved = serde_json::json!({});
    }
    for key in PREF_KEYS {
        if !patch[*key].is_null() {
            saved[*key] = patch[*key].clone();
        }
    }
    std::fs::write(prefs_path(), serde_json::to_string_pretty(&saved).unwrap()).map_err(|e| e.to_string())?;
    Ok(prefs())
}

static VOICE_CACHE: std::sync::Mutex<Option<(std::time::Instant, serde_json::Value)>> = std::sync::Mutex::new(None);

/// The account's ElevenLabs voices (premade + its own), each with the hosted
/// preview clip — previews play straight from it and cost no credits.
pub async fn eleven_voices() -> Result<serde_json::Value, String> {
    if let Some((at, v)) = VOICE_CACHE.lock().unwrap().as_ref() {
        if at.elapsed().as_secs() < 600 {
            return Ok(v.clone());
        }
    }
    let key = eleven_key().ok_or("Add your ElevenLabs API key first")?;
    let res = reqwest::Client::new()
        .get("https://api.elevenlabs.io/v1/voices")
        .header("xi-api-key", key)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("ElevenLabs unreachable: {e}"))?;
    let status = res.status();
    let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(eleven_error(status, &body));
    }
    let voices: Vec<serde_json::Value> = body["voices"]
        .as_array()
        .map(|list| {
            list.iter()
                // celebrity voices (Albert Einstein™, …) only work inside
                // ElevenLabs' Reader app — the API answers 401
                // "famous_voice_not_permitted", so don't offer them
                .filter(|v| {
                    v["sharing"]["category"].as_str() != Some("famous")
                        && !v["name"].as_str().unwrap_or("").contains('™')
                })
                .map(|v| {
                    let l = &v["labels"];
                    serde_json::json!({
                        "id": v["voice_id"],
                        "name": v["name"],
                        "preview": v["preview_url"],
                        "category": v["category"],
                        "accent": l["accent"],
                        "gender": l["gender"],
                        "age": l["age"],
                        "description": l["description"].as_str().or(l["descriptive"].as_str()),
                        "useCase": l["use_case"].as_str().or(l["use case"].as_str()),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let v = serde_json::json!(voices);
    *VOICE_CACHE.lock().unwrap() = Some((std::time::Instant::now(), v.clone()));
    Ok(v)
}

fn eleven_error(status: reqwest::StatusCode, body: &serde_json::Value) -> String {
    let detail = body["detail"]["message"]
        .as_str()
        .or(body["detail"].as_str())
        .unwrap_or("");
    let code = body["detail"]["status"].as_str().or(body["detail"]["code"].as_str()).unwrap_or("");
    match status.as_u16() {
        // 401 also covers voice permissions — say which, not "bad key"
        401 if code.contains("voice") => format!(
            "ElevenLabs won't let the API use this voice{} — pick another",
            if detail.is_empty() { String::new() } else { format!(" ({detail})") }
        ),
        401 => "ElevenLabs rejected the API key".to_string(),
        429 => "ElevenLabs rate limit or quota reached".to_string(),
        _ => format!("ElevenLabs error {status}{}", if detail.is_empty() { String::new() } else { format!(": {detail}") }),
    }
}

/// Speak `text` with ElevenLabs as MP3.
async fn eleven_synth(text: &str, voice: &str, model: &str, speed: f64) -> Result<Vec<u8>, String> {
    let key = eleven_key().ok_or("Add your ElevenLabs API key in Settings → Voice")?;
    let res = reqwest::Client::new()
        .post(format!("https://api.elevenlabs.io/v1/text-to-speech/{voice}?output_format=mp3_44100_128"))
        .header("xi-api-key", key)
        .json(&serde_json::json!({
            "text": text,
            "model_id": model,
            // ElevenLabs accepts 0.7–1.2
            "voice_settings": { "speed": speed.clamp(0.7, 1.2) },
        }))
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("ElevenLabs unreachable: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let body = res.json::<serde_json::Value>().await.unwrap_or_default();
        return Err(eleven_error(status, &body));
    }
    res.bytes().await.map(|b| b.to_vec()).map_err(|e| e.to_string())
}

/// 16-bit mono WAV around `samples`.
fn wav(samples: &[f32], rate: u32) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    out
}

/// Speak `text` as a WAV. Blocking — tens to hundreds of ms on Apple Silicon
/// for a readout; callers run it off the async runtime.
#[cfg(feature = "parakeet")]
pub fn synth(text: &str, voice: Option<&str>, speed: Option<f32>) -> Result<Vec<u8>, String> {
    use sherpa_onnx::{GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsKokoroModelConfig, OfflineTtsModelConfig};
    use std::sync::{Mutex, OnceLock};

    let text = text.trim();
    if text.is_empty() {
        return Err("nothing to say".into());
    }
    if !available() {
        return Err("voice model not installed".into());
    }
    // one engine per process, loaded on first use; generation is serialized
    // so two panes finishing at once queue instead of doubling memory
    static TTS: OnceLock<Result<Mutex<OfflineTts>, String>> = OnceLock::new();
    let tts = TTS
        .get_or_init(|| {
            let p = |f: &str| Some(kokoro_file(f).to_string_lossy().into_owned());
            let config = OfflineTtsConfig {
                model: OfflineTtsModelConfig {
                    kokoro: OfflineTtsKokoroModelConfig {
                        model: p("model.int8.onnx"),
                        voices: p("voices.bin"),
                        tokens: p("tokens.txt"),
                        data_dir: p("espeak-ng-data"),
                        lexicon: p("lexicon-us-en.txt"),
                        lang: Some("en-us".into()),
                        ..Default::default()
                    },
                    num_threads: 4,
                    debug: false,
                    provider: Some("cpu".into()),
                    vits: Default::default(),
                    matcha: Default::default(),
                    kitten: Default::default(),
                    zipvoice: Default::default(),
                    pocket: Default::default(),
                    supertonic: Default::default(),
                },
                max_num_sentences: 2,
                silence_scale: 0.2,
                ..Default::default()
            };
            OfflineTts::create(&config)
                .map(Mutex::new)
                .ok_or_else(|| "couldn't load the voice model".to_string())
        })
        .as_ref()?;
    let sid = VOICES
        .iter()
        .position(|v| Some(*v) == voice)
        .or_else(|| VOICES.iter().position(|v| *v == DEFAULT_VOICE))
        .unwrap_or(0) as i32;
    let gen = GenerationConfig {
        sid,
        speed: speed.unwrap_or(1.0).clamp(0.5, 2.0),
        ..Default::default()
    };
    let engine = tts.lock().unwrap();
    let audio = engine
        .generate_with_config(text, &gen, None::<fn(&[f32], f32) -> bool>)
        .ok_or("speech generation failed")?;
    Ok(wav(audio.samples(), audio.sample_rate() as u32))
}

#[cfg(not(feature = "parakeet"))]
pub fn synth(_text: &str, _voice: Option<&str>, _speed: Option<f32>) -> Result<Vec<u8>, String> {
    Err("this build has no speech engine".into())
}

/// `speak_text` for both transports: `{ mime, data }` with base64 audio.
/// `engine` / `voice` in `args` override the saved choice (voice previews).
pub async fn synth_json(args: serde_json::Value) -> Result<serde_json::Value, String> {
    use base64::Engine;
    let text = args["text"].as_str().unwrap_or_default();
    let text = if args["raw"].as_bool() == Some(true) { text.trim().to_string() } else { speakable(text) };
    if text.is_empty() {
        return Err("nothing to say".into());
    }
    let p = prefs();
    let engine = args["engine"].as_str().or(p["engine"].as_str()).unwrap_or("kokoro").to_string();
    let speed = args["speed"].as_f64().or(p["speed"].as_f64()).unwrap_or(1.0);
    let (bytes, mime) = if engine == "elevenlabs" {
        let voice = args["voice"].as_str().or(p["elevenVoice"].as_str()).unwrap_or(ELEVEN_DEFAULT_VOICE.0);
        let model = args["model"].as_str().or(p["elevenModel"].as_str()).unwrap_or(ELEVEN_MODELS[0]);
        (eleven_synth(&text, voice, model, speed).await?, "audio/mpeg")
    } else {
        let voice = args["voice"].as_str().or(p["voice"].as_str()).map(str::to_string);
        let bytes = tokio::task::spawn_blocking(move || synth(&text, voice.as_deref(), Some(speed as f32)))
            .await
            .map_err(|e| e.to_string())??;
        (bytes, "audio/wav")
    };
    Ok(serde_json::json!({
        "mime": mime,
        "data": base64::engine::general_purpose::STANDARD.encode(bytes),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speakable_drops_code_and_markup() {
        let s = speakable("## Done\nRan `npm test`, see [the log](http://x).\n```\ncode\n```\n| a | b |\n- next: ship it");
        assert_eq!(s, "Done. Ran npm test, see the log. next: ship it.");
    }

    #[test]
    fn wav_header() {
        let w = wav(&[0.0, 1.0], 24_000);
        assert_eq!(&w[..4], b"RIFF");
        assert_eq!(w.len(), 48);
    }

    // needs the model: cargo test --release --lib gateway::speak -- --ignored
    #[test]
    #[ignore]
    fn speaks() {
        let w = synth("Login works now. Next: run the tests.", None, None).unwrap();
        assert!(w.len() > 10_000);
        std::fs::write(std::env::temp_dir().join("agentbench-speak.wav"), w).unwrap();
    }
}
