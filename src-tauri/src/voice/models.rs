//! Whisper model catalog and verified, atomic installation.
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

pub struct Model {
    pub id: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

pub const CATALOG: &[Model] = &[
    Model {
        id: "tiny.en",
        size: 77_704_715,
        sha256: "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f",
    },
    Model {
        id: "base.en",
        size: 147_964_211,
        sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
    },
    Model {
        id: "small.en",
        size: 487_614_201,
        sha256: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d",
    },
];
pub fn lookup(id: &str) -> Result<&'static Model, String> {
    CATALOG
        .iter()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("invalid voiceModel: {id}"))
}
pub fn dir(home: &Path) -> PathBuf {
    home.join("models").join("whisper")
}
pub fn path(home: &Path, model: &Model) -> PathBuf {
    dir(home).join(format!("ggml-{}.bin", model.id))
}
fn url(model: &Model) -> String {
    format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{}.bin", model.id)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceModel {
    id: &'static str,
    size_bytes: u64,
    installed: bool,
}
pub fn list(home: &Path) -> Vec<VoiceModel> {
    CATALOG
        .iter()
        .map(|m| VoiceModel {
            id: m.id,
            size_bytes: m.size,
            installed: path(home, m).is_file(),
        })
        .collect()
}
#[derive(Clone, Serialize)]
pub struct Progress {
    id: &'static str,
    received: u64,
    total: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    done: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}
static DOWNLOADS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
fn downloads() -> &'static Mutex<HashSet<String>> {
    DOWNLOADS.get_or_init(Default::default)
}
struct DownloadGuard {
    id: String,
    partial: PathBuf,
}
impl DownloadGuard {
    fn acquire(id: &str, partial: PathBuf) -> Result<Self, String> {
        if !crate::relock(downloads()).insert(id.to_string()) {
            return Err("download already in progress".into());
        }
        Ok(Self { id: id.into(), partial })
    }
}
impl Drop for DownloadGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.partial);
        crate::relock(downloads()).remove(&self.id);
    }
}
// Called only after the writer is closed: a failed verification never leaves an installable file.
fn install(partial: &Path, target: &Path, actual: &str, expected: &str) -> Result<(), String> {
    if actual != expected {
        fs::remove_file(partial).map_err(crate::err)?;
        return Err("Whisper model sha256 mismatch".into());
    }
    fs::rename(partial, target).map_err(crate::err)
}
pub async fn download(home: &Path, app: &AppHandle, id: &str) -> Result<(), String> {
    let model = lookup(id)?;
    let target = path(home, model);
    let partial = target.with_extension("bin.partial");
    let _guard = DownloadGuard::acquire(id, partial.clone())?;
    let mut progress = Progress {
        id: model.id,
        received: 0,
        total: model.size,
        done: None,
        error: None,
    };
    let _ = app.emit("voice-download", &progress);
    let result = async {
        if target.is_file() {
            return Ok(());
        }
        fs::create_dir_all(dir(home)).map_err(crate::err)?;
        let mut response = reqwest::Client::new()
            .get(url(model))
            .send()
            .await
            .map_err(crate::err)?
            .error_for_status()
            .map_err(crate::err)?;
        let mut file = fs::File::create(&partial).map_err(crate::err)?;
        let mut hash = Sha256::new();
        let mut last = Instant::now();
        while let Some(chunk) = response.chunk().await.map_err(crate::err)? {
            progress.received += chunk.len() as u64;
            if progress.received > model.size {
                return Err("Whisper model exceeds catalog size".into());
            }
            file.write_all(&chunk).map_err(crate::err)?;
            hash.update(&chunk);
            if last.elapsed() >= Duration::from_millis(100) {
                let _ = app.emit("voice-download", &progress);
                last = Instant::now();
            }
        }
        file.sync_all().map_err(crate::err)?;
        drop(file);
        install(&partial, &target, &format!("{:x}", hash.finalize()), model.sha256)
    }
    .await;
    if result.is_ok() {
        progress.received = model.size;
    }
    progress.done = Some(result.is_ok());
    progress.error = result.as_ref().err().cloned();
    let _ = app.emit("voice-download", &progress);
    result
}
pub fn delete(home: &Path, id: &str) -> Result<(), String> {
    let model = lookup(id)?;
    // Serialize deletion with download acquisition and installation.
    let guard = crate::relock(downloads());
    if guard.contains(id) {
        return Err("download already in progress".into());
    }
    let target = path(home, model);
    if target.exists() {
        fs::remove_file(target).map_err(crate::err)?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_paths() {
        assert!(lookup("../bad").is_err());
        assert_eq!(lookup("tiny.en").unwrap().size, 77_704_715);
        assert_eq!(
            path(Path::new("home"), lookup("base.en").unwrap()),
            Path::new("home/models/whisper/ggml-base.en.bin")
        );
        for m in CATALOG {
            assert_eq!(m.sha256.len(), 64);
            assert!(url(m).ends_with(&format!("ggml-{}.bin", m.id)));
        }
    }
    #[test]
    fn sha_mismatch_discards_partial() {
        let tmp = tempfile::tempdir().unwrap();
        let partial = tmp.path().join("model.bin.partial");
        let target = tmp.path().join("model.bin");
        fs::write(&partial, b"corrupt").unwrap();
        assert!(install(&partial, &target, "wrong", "expected").is_err());
        assert!(!partial.exists() && !target.exists());
        fs::write(&partial, b"valid").unwrap();
        install(&partial, &target, "same", "same").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"valid");
    }
}
