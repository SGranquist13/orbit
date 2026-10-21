//! Lazy CPU Whisper inference; no model loading or inference on an async executor.
use std::{
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
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
struct Cached {
    id: String,
    path: PathBuf,
    context: WhisperContext,
}
static CONTEXT: OnceLock<Mutex<Option<Cached>>> = OnceLock::new();
fn infer(id: &str, path: &Path, audio: &[f32], prompt: &str) -> Result<String, String> {
    if audio.is_empty() {
        return Ok(String::new());
    }
    let mut cache = crate::relock(CONTEXT.get_or_init(Default::default));
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
    tokio::task::spawn_blocking(move || infer(&id, &path, &audio, &prompt))
        .await
        .map_err(crate::err)?
}
#[cfg(test)]
mod tests {
    use super::*;
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
    #[tokio::test]
    #[ignore = "requires ORBIT_WHISPER_TEST_MODEL pointing to a downloaded English Whisper model"]
    async fn voice_live_pong() {
        let model = std::env::var_os("ORBIT_WHISPER_TEST_MODEL").expect("set ORBIT_WHISPER_TEST_MODEL");
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/fixtures/voice-pong.wav");
        let audio = super::super::capture::read_wav(&fixture).unwrap();
        let text = transcribe("test".into(), model.into(), audio, String::new()).await.unwrap();
        assert!(text.to_lowercase().contains("pong"), "transcribed: {text}");
    }
}
