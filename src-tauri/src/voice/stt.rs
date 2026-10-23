//! Lazy CPU Whisper inference; no model loading or inference on an async executor.
use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

fn capped(s: &str, max: usize) -> String {
    s.chars().filter(|c| *c != '\0').take(max).collect()
}
/// Vocabulary only, deliberately bounded independently of worktree/skill-list size.
pub fn initial_prompt(repo: &str, branch: &str, files: &[String], skills: &[String]) -> String {
    capped(
        &format!(
            "Repository: {}. Branch: {}. Files: {}. Skills: {}.",
            capped(repo, 70),
            capped(branch, 70),
            capped(&files.iter().take(40).cloned().collect::<Vec<_>>().join(", "), 280),
            capped(&skills.join(", "), 130)
        ),
        600,
    )
}
pub fn file_names(root: &Path) -> Vec<String> {
    let mut result = Vec::new();
    for (dir, prefix) in [(root.to_path_buf(), ""), (root.join("src"), "src/")] {
        let mut names: Vec<_> = std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                (!matches!(name.as_str(), ".git" | "node_modules" | "target") && !name.starts_with('.')).then(|| format!("{prefix}{name}"))
            })
            .collect();
        names.sort();
        // Reserve room for src entries even in repositories with many top-level files.
        result.extend(names.into_iter().take(20));
    }
    result
}
pub fn clean_artifacts(text: &str) -> String {
    static ARTIFACTS: OnceLock<regex::Regex> = OnceLock::new();
    let pattern = ARTIFACTS.get_or_init(|| regex::Regex::new(
        r"(?i)\[\s*(?:blank[_ ]audio|silence|no[_ ]speech|music|inaudible|applause)\s*\]|\(\s*(?:blank[_ ]audio|silence|no[_ ]speech|music|inaudible|applause)\s*\)|<\|[^|]*\|>"
    ).expect("constant artifact regex"));
    let cleaned = pattern.replace_all(text, " ").split_whitespace().collect::<Vec<_>>().join(" ");
    if pattern.is_match(text) && !cleaned.chars().any(char::is_alphanumeric) {
        String::new()
    } else {
        cleaned
    }
}
/// Applied to cleaned Whisper output before any model-based tidy.
pub fn is_junk(text: &str, samples: usize) -> bool {
    if !text.chars().any(char::is_alphabetic) {
        return true;
    }
    static ANNOTATIONS: OnceLock<regex::Regex> = OnceLock::new();
    let annotations = ANNOTATIONS.get_or_init(|| regex::Regex::new(r"\([^()]*\)|\[[^\[\]]*\]|\*[^*]*\*").expect("annotation regex"));
    if !annotations.replace_all(text, "").chars().any(char::is_alphabetic) {
        return true;
    }
    let words: Vec<String> = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .collect();
    if words
        .iter()
        .all(|w| matches!(w.as_str(), "um" | "uh" | "hmm" | "mm" | "ah" | "er" | "huh"))
    {
        return true;
    }
    static PUNCTUATION: OnceLock<regex::Regex> = OnceLock::new();
    let punctuation = PUNCTUATION.get_or_init(|| regex::Regex::new(r"\p{P}").expect("punctuation regex"));
    let normalized = punctuation
        .replace_all(text, "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    samples < 24_000
        && matches!(
            normalized.as_str(),
            "thank you" | "thanks" | "thanks for watching" | "bye" | "you" | "okay"
        )
}
struct Cached {
    id: String,
    path: PathBuf,
    context: WhisperContext,
}
static CONTEXT: OnceLock<std::sync::Arc<tokio::sync::Mutex<Option<Cached>>>> = OnceLock::new();
fn infer(cache: &mut Option<Cached>, id: &str, path: &Path, audio: &[f32], prompt: &str) -> Result<String, String> {
    if audio.is_empty() {
        return Ok(String::new());
    }
    // Without whisper-rs logging backends these hooks discard Whisper and ggml logs.
    whisper_rs::install_logging_hooks();
    if !cache.as_ref().is_some_and(|c| c.id == id && c.path == path) {
        let mut parameters = WhisperContextParameters::default();
        parameters.use_gpu(false);
        // Release the previous model before allocating its replacement.
        *cache = None;
        let context = WhisperContext::new_with_params(path, parameters).map_err(crate::err)?;
        *cache = Some(Cached {
            id: id.into(),
            path: path.into(),
            context,
        });
    }
    let context = &cache.as_ref().ok_or("Whisper context unavailable")?.context;
    let mut state = context.create_state().map_err(crate::err)?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("en"));
    params.set_no_timestamps(true);
    params.set_suppress_blank(true);
    params.set_suppress_nst(true);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_n_threads(std::thread::available_parallelism().map_or(1, |n| n.get().min(8)) as i32);
    params.set_initial_prompt(prompt);
    state.full(params, audio).map_err(crate::err)?;
    let mut text = String::new();
    for segment in state.as_iter() {
        text.push_str(&segment.to_str_lossy().map_err(crate::err)?);
    }
    Ok(clean_artifacts(&text))
}
pub async fn transcribe(id: String, path: PathBuf, audio: Vec<f32>, prompt: String) -> Result<String, String> {
    let cache = CONTEXT.get_or_init(Default::default).clone().lock_owned().await;
    tokio::task::spawn_blocking(move || {
        // Hold serialization through native inference even if the awaiting command is canceled.
        let mut cache = cache;
        infer(&mut cache, &id, &path, &audio, &prompt)
    })
    .await
    .map_err(crate::err)?
}
#[cfg(test)]
mod tests {
    use super::*;
    pub fn to_mono_16k(samples: &[f32], channels: usize, rate: u32) -> Vec<f32> {
        if channels == 0 || rate == 0 {
            return vec![];
        }
        let mono: Vec<f32> = samples
            .chunks_exact(channels)
            .map(|frame| {
                frame
                    .iter()
                    .map(|x| if x.is_finite() { x.clamp(-1.0, 1.0) } else { 0.0 })
                    .sum::<f32>()
                    / channels as f32
            })
            .collect();
        let len = (mono.len() as u64 * 16_000 / rate as u64) as usize;
        (0..len)
            .map(|i| {
                let position = i as f64 * rate as f64 / 16_000.0;
                let a = position as usize;
                let b = (a + 1).min(mono.len() - 1);
                mono[a] + (mono[b] - mono[a]) * (position - a as f64) as f32
            })
            .collect()
    }
    pub fn read_wav(path: &Path) -> Result<Vec<f32>, String> {
        let mut reader = hound::WavReader::open(path).map_err(crate::err)?;
        let spec = reader.spec();
        let max = spec.sample_rate as usize * spec.channels as usize * 120;
        let samples: Result<Vec<f32>, _> = match spec.sample_format {
            hound::SampleFormat::Float => reader.samples::<f32>().take(max).collect(),
            hound::SampleFormat::Int => {
                let scale = 2.0f32.powi(spec.bits_per_sample as i32 - 1);
                reader.samples::<i32>().take(max).map(|s| s.map(|s| s as f32 / scale)).collect()
            }
        };
        Ok(to_mono_16k(&samples.map_err(crate::err)?, spec.channels as usize, spec.sample_rate))
    }

    #[test]
    fn voice_junk_filter() {
        for (text, samples, expected) in [
            ("", 32000, true),
            ("123 ... \u{266a}", 32000, true),
            ("(coughs)", 32000, true),
            ("[COUGH]", 32000, true),
            ("*clears throat*", 32000, true),
            ("(laughing) [cough] *SNEEZES*.", 32000, true),
            ("\u{266a}", 32000, true),
            ("Um, uh! HMM... mm ah er huh?", 32000, true),
            ("Thank you.", 6400, true),
            ("Thanks!", 6400, true),
            ("Thanks for watching.", 6400, true),
            ("Bye.", 6400, true),
            ("You!", 6400, true),
            ("Okay.", 23999, true),
            ("Thank you\u{2026}", 6400, true),
            ("um 123", 32000, false),
            ("Okay.", 24000, false),
            ("Fix the bug in chat.tsx.", 6400, false),
            ("Thank you, now run the tests.", 32000, false),
            ("Thank you.", 32000, false),
            ("Okay, ship it.", 6400, false),
            ("[cough] Fix it.", 6400, false),
            ("Keep (this wording) and [index].", 32000, false),
            ("[BLANK_AUDIO] (silence)", 32000, true),
        ] {
            assert_eq!(is_junk(&clean_artifacts(text), samples), expected, "{text}");
        }
    }
    #[test]
    fn voice_prompt_caps_unicode_and_lists() {
        let files = vec!["文件.rs".repeat(100); 100];
        let prompt = initial_prompt("orbit", "feat/voice", &files, &["shipkit:ship".into()]);
        assert!(prompt.chars().count() <= 600);
        assert!(prompt.contains("orbit") && prompt.contains("feat/voice") && prompt.contains("shipkit:ship"));
        assert!(!initial_prompt("\0repo", "main", &[], &[]).contains('\0'));
    }
    #[test]
    fn voice_artifacts() {
        assert_eq!(clean_artifacts(" [BLANK_AUDIO] (silence) [Music] "), "");
        assert_eq!(clean_artifacts("(silence). [BLANK_AUDIO]..."), "");
        assert_eq!(
            clean_artifacts(" (Silence) Fix  lib.rs. [BLANK_AUDIO] <|endoftext|> "),
            "Fix lib.rs."
        );
        assert_eq!(
            clean_artifacts("Keep (this wording) and [index]."),
            "Keep (this wording) and [index]."
        );
    }
    async fn transcribe_fixture(model: PathBuf, audio: Vec<f32>) -> String {
        let encoded = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            audio.iter().flat_map(|s| s.to_le_bytes()).collect::<Vec<_>>(),
        );
        let audio = super::super::decode_audio(&encoded).unwrap();
        transcribe("test".into(), model, audio, String::new()).await.unwrap()
    }
    #[tokio::test]
    #[ignore = "requires ORBIT_WHISPER_TEST_MODEL pointing to a downloaded English Whisper model"]
    async fn voice_live_low_noise_dropped() {
        let model = std::env::var_os("ORBIT_WHISPER_TEST_MODEL").expect("set ORBIT_WHISPER_TEST_MODEL");
        let audio = (0..6400).map(|i| (((i * 7919 % 65521) as f32 / 65521.0) - 0.5) * 0.002).collect();
        let text = transcribe_fixture(model.into(), audio).await;
        assert!(is_junk(&text, 6400), "noise transcribed: {text}");
    }
    #[tokio::test]
    #[ignore = "requires ORBIT_WHISPER_TEST_MODEL pointing to a downloaded English Whisper model"]
    async fn voice_live_pong() {
        let model = std::env::var_os("ORBIT_WHISPER_TEST_MODEL").expect("set ORBIT_WHISPER_TEST_MODEL");
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/fixtures/voice-pong.wav");
        let audio = read_wav(&fixture).unwrap();
        let text = transcribe_fixture(model.into(), audio).await;
        assert!(text.to_lowercase().contains("pong"), "transcribed: {text}");
    }
}
