//! STT and TTS model catalog and verified, atomic installation.
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

pub struct PackFile {
    pub path: &'static str,
    source: &'static str,
    size: u64,
    sha256: &'static str,
}
pub const KOKORO_FILES: &[PackFile] = &[
    PackFile {
        path: "model_quantized.onnx",
        source: "onnx/model_quantized.onnx",
        size: 92361116,
        sha256: "fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478",
    },
    PackFile {
        path: "voices/af_heart.bin",
        source: "voices/af_heart.bin",
        size: 522240,
        sha256: "d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b",
    },
    PackFile {
        path: "voices/af_bella.bin",
        source: "voices/af_bella.bin",
        size: 522240,
        sha256: "f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b",
    },
    PackFile {
        path: "voices/af_nicole.bin",
        source: "voices/af_nicole.bin",
        size: 522240,
        sha256: "cd2191ab31b914ed7b318416b0e4440fdf392ddad9106a060819aa600a64f59a",
    },
    PackFile {
        path: "voices/am_michael.bin",
        source: "voices/am_michael.bin",
        size: 522240,
        sha256: "1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1",
    },
    PackFile {
        path: "voices/am_fenrir.bin",
        source: "voices/am_fenrir.bin",
        size: 522240,
        sha256: "c27989f741f7ee34d273a39d8a595cc0837d35f5ced9a29b7cc162614616df43",
    },
    PackFile {
        path: "voices/am_puck.bin",
        source: "voices/am_puck.bin",
        size: 522240,
        sha256: "fcf73c989033e9233e0b98713eca600c8c74dcc1614b37009d5450ff4a2274a0",
    },
    PackFile {
        path: "voices/bf_emma.bin",
        source: "voices/bf_emma.bin",
        size: 522240,
        sha256: "669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73",
    },
    PackFile {
        path: "voices/bm_george.bin",
        source: "voices/bm_george.bin",
        size: 522240,
        sha256: "c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc",
    },
    PackFile {
        path: "us_gold.json",
        source: "us_gold.json",
        size: 3000469,
        sha256: "dc414872a49a28ae6c141463d502fd945f3b2fde040484fdc47d00cc4612686f",
    },
    PackFile {
        path: "us_silver.json",
        source: "us_silver.json",
        size: 3099517,
        sha256: "de8f67be911bb6c659187b4a65fd966b6a30e56350e0f790d763210b053ac475",
    },
];
pub const KOKORO_VOICES: &[&str] = &[
    "af_heart",
    "af_bella",
    "af_nicole",
    "am_michael",
    "am_fenrir",
    "am_puck",
    "bf_emma",
    "bm_george",
];
fn kokoro_dir(home: &Path) -> PathBuf {
    home.join("models/kokoro")
}
pub fn tts_file_path(home: &Path, relative: &str) -> Result<PathBuf, String> {
    let file = KOKORO_FILES.iter().find(|f| f.path == relative).ok_or("invalid voice file path")?;
    Ok(kokoro_dir(home).join(file.path))
}
pub fn read_tts_file(path: &Path) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "no model: download kokoro in Settings > Voice".into()
        } else {
            crate::err(e)
        }
    })
}
struct DownloadFile {
    target: PathBuf,
    url: String,
    size: u64,
    sha256: &'static str,
}
fn download_files(home: &Path, id: &str) -> Result<Vec<DownloadFile>, String> {
    if id == "kokoro" {
        return Ok(KOKORO_FILES
            .iter()
            .map(|f| DownloadFile {
                target: kokoro_dir(home).join(f.path),
                size: f.size,
                sha256: f.sha256,
                url: if f.path.ends_with(".json") {
                    format!(
                        "https://raw.githubusercontent.com/hexgrad/misaki/fba1236595f2d2bf21d414ba6e57d25256afada3/misaki/data/{}",
                        f.source
                    )
                } else {
                    format!(
                        "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/{}",
                        f.source
                    )
                },
            })
            .collect());
    }
    let m = lookup(id)?;
    Ok(vec![DownloadFile {
        target: path(home, m),
        url: url(m),
        size: m.size,
        sha256: m.sha256,
    }])
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceModel {
    id: &'static str,
    kind: &'static str,
    size_bytes: u64,
    installed: bool,
}
pub fn list(home: &Path) -> Vec<VoiceModel> {
    CATALOG
        .iter()
        .map(|m| VoiceModel {
            id: m.id,
            kind: "stt",
            size_bytes: m.size,
            installed: path(home, m).is_file(),
        })
        .chain(std::iter::once(VoiceModel {
            id: "kokoro",
            kind: "tts",
            size_bytes: KOKORO_FILES.iter().map(|f| f.size).sum(),
            installed: KOKORO_FILES.iter().all(|f| kokoro_dir(home).join(f.path).is_file()),
        }))
        .collect()
}
#[derive(Clone, Serialize)]
pub struct Progress {
    id: String,
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
    partials: Vec<PathBuf>,
}
impl DownloadGuard {
    fn acquire(id: &str, partials: Vec<PathBuf>) -> Result<Self, String> {
        if !crate::relock(downloads()).insert(id.to_string()) {
            return Err("download already in progress".into());
        }
        Ok(Self { id: id.into(), partials })
    }
}
impl Drop for DownloadGuard {
    fn drop(&mut self) {
        for partial in &self.partials {
            let _ = fs::remove_file(partial);
        }
        crate::relock(downloads()).remove(&self.id);
    }
}
// Called only after the writer is closed: a failed verification never leaves an installable file.
fn install(partial: &Path, target: &Path, actual: &str, expected: &str) -> Result<(), String> {
    if actual != expected {
        fs::remove_file(partial).map_err(crate::err)?;
        return Err("model sha256 mismatch".into());
    }
    fs::rename(partial, target).map_err(crate::err)
}
pub async fn download(home: &Path, app: &AppHandle, id: &str) -> Result<(), String> {
    let files = download_files(home, id)?;
    let partials: Vec<_> = files.iter().map(|f| f.target.with_added_extension("partial")).collect();
    let _guard = DownloadGuard::acquire(id, partials.clone())?;
    let mut progress = Progress {
        id: id.into(),
        received: files.iter().filter(|f| f.target.is_file()).map(|f| f.size).sum(),
        total: files.iter().map(|f| f.size).sum(),
        done: None,
        error: None,
    };
    let _ = app.emit("voice-download", &progress);
    let result = async {
        let client = reqwest::Client::new();
        let mut last = Instant::now();
        for (file_spec, partial) in files.iter().zip(&partials) {
            if file_spec.target.is_file() {
                continue;
            }
            fs::create_dir_all(file_spec.target.parent().ok_or("missing model directory")?).map_err(crate::err)?;
            let mut response = client
                .get(&file_spec.url)
                .send()
                .await
                .map_err(crate::err)?
                .error_for_status()
                .map_err(crate::err)?;
            let mut file = fs::File::create(partial).map_err(crate::err)?;
            let mut hash = Sha256::new();
            let mut received = 0;
            while let Some(chunk) = response.chunk().await.map_err(crate::err)? {
                received += chunk.len() as u64;
                if received > file_spec.size {
                    return Err("model exceeds catalog size".into());
                }
                progress.received += chunk.len() as u64;
                file.write_all(&chunk).map_err(crate::err)?;
                hash.update(&chunk);
                if last.elapsed() >= Duration::from_millis(100) {
                    let _ = app.emit("voice-download", &progress);
                    last = Instant::now();
                }
            }
            file.sync_all().map_err(crate::err)?;
            drop(file);
            if received != file_spec.size {
                return Err("model does not match catalog size".into());
            }
            install(partial, &file_spec.target, &format!("{:x}", hash.finalize()), file_spec.sha256)?;
        }
        Ok(())
    }
    .await;
    progress.done = Some(result.is_ok());
    progress.error = result.as_ref().err().cloned();
    let _ = app.emit("voice-download", &progress);
    result
}
pub fn delete(home: &Path, id: &str) -> Result<(), String> {
    let files = download_files(home, id)?;
    let guard = crate::relock(downloads());
    if guard.contains(id) {
        return Err("download already in progress".into());
    }
    if id == "kokoro" {
        let target = kokoro_dir(home);
        if target.exists() {
            fs::remove_dir_all(target).map_err(crate::err)?;
        }
    } else {
        for file in files {
            if file.target.exists() {
                fs::remove_file(file.target).map_err(crate::err)?;
            }
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn kokoro_catalog_and_allowlist() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let pack = || list(home).into_iter().find(|m| m.id == "kokoro").unwrap();
        assert_eq!(pack().kind, "tts");
        assert_eq!(pack().size_bytes, 102_639_022);
        assert_eq!(pack().size_bytes, KOKORO_FILES.iter().map(|f| f.size).sum::<u64>());
        assert!(!pack().installed);
        for invalid in [
            "../x",
            r"C:\x",
            "voices/zz.bin",
            "/model_quantized.onnx",
            r"voices\af_heart.bin",
            "./us_gold.json",
        ] {
            assert!(tts_file_path(home, invalid).is_err(), "{invalid}");
        }
        assert_eq!(
            read_tts_file(&tts_file_path(home, "us_gold.json").unwrap()).unwrap_err(),
            "no model: download kokoro in Settings > Voice"
        );
        for file in KOKORO_FILES {
            assert!(!pack().installed);
            let path = tts_file_path(home, file.path).unwrap();
            assert_eq!(file.sha256.len(), 64);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, b"fixture").unwrap();
        }
        assert!(pack().installed);
        assert_eq!(read_tts_file(&tts_file_path(home, "us_gold.json").unwrap()).unwrap(), b"fixture");
        delete(home, "kokoro").unwrap();
        assert!(!kokoro_dir(home).exists());
        assert!(!pack().installed);
        assert!(lookup("kokoro").is_err());
        assert!(list(home).iter().filter(|m| m.id != "kokoro").all(|m| m.kind == "stt"));
    }
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
