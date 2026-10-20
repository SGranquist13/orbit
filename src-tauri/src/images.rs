//! Image support: content-addressed storage under `<orbit home>/images/<workspace>/`, the path
//! guards for sending and reading images, and externalising inline (base64) images from agent events.

use crate::agent::{AgentEvent, FileRef, ImageRef};
use base64::Engine;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub const MAX_BYTES: usize = 20 * 1024 * 1024;
pub const MAX_FILE_BYTES: usize = 25 * 1024 * 1024;

pub fn ext_for_media_type(mime: &str) -> Option<&'static str> {
    match mime {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

/// Media type for a file extension (reading also allows SVG).
pub fn media_type_for_path(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    }
}

pub fn images_dir(home: &Path) -> PathBuf {
    home.join("images")
}

fn valid_workspace_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Writes `bytes` to `<home>/images/<workspace>/<sha256[..16]>.<ext>` (idempotent).
pub fn store(home: &Path, workspace_id: &str, bytes: &[u8], media_type: &str) -> Result<ImageRef, String> {
    let ext = ext_for_media_type(media_type).ok_or_else(|| format!("Unsupported image type \"{media_type}\" (use PNG, JPEG, GIF or WebP)"))?;
    if !valid_workspace_id(workspace_id) {
        return Err("Invalid workspace id".into());
    }
    if bytes.is_empty() {
        return Err("The image is empty".into());
    }
    if bytes.len() > MAX_BYTES {
        return Err(format!("The image is too large ({} MB; the limit is 20 MB)", bytes.len() / (1024 * 1024)));
    }
    let hash = Sha256::digest(bytes);
    let name: String = hash.iter().take(8).map(|b| format!("{b:02x}")).collect();
    let dir = images_dir(home).join(workspace_id);
    let path = dir.join(format!("{name}.{ext}"));
    if !path.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create the images folder: {e}"))?;
        std::fs::write(&path, bytes).map_err(|e| format!("Could not save the image: {e}"))?;
    }
    Ok(ImageRef { path: path.to_string_lossy().to_string(), media_type: media_type.to_string(), data: None })
}

pub fn decode(data: &str) -> Result<Vec<u8>, String> {
    decode_limited(data, MAX_BYTES, "image")
}

fn decode_limited(data: &str, limit: usize, what: &str) -> Result<Vec<u8>, String> {
    // Reject before decoding: base64 expands by 4/3.
    if data.len() > limit / 3 * 4 + 8 {
        return Err(format!("The {what} is too large (the limit is {} MB)", limit / (1024 * 1024)));
    }
    base64::engine::general_purpose::STANDARD.decode(data.trim()).map_err(|e| format!("The image data is not valid base64: {e}"))
}

pub fn save_base64(home: &Path, workspace_id: &str, data: &str, media_type: &str) -> Result<ImageRef, String> {
    if ext_for_media_type(media_type).is_none() {
        return Err(format!("Unsupported image type \"{media_type}\" (use PNG, JPEG, GIF or WebP)"));
    }
    store(home, workspace_id, &decode(data)?, media_type)
}

/// Writes inline images of a `ToolResult` to the images dir and clears their `data`, so stored and
/// emitted events never carry base64. Images that cannot be saved are dropped.
pub fn externalize(home: &Path, workspace_id: &str, ev: AgentEvent) -> AgentEvent {
    let AgentEvent::ToolResult { id, output, is_error, images } = ev else { return ev };
    let images = images
        .into_iter()
        .filter_map(|img| match img.data {
            None => Some(img),
            Some(data) => match save_base64(home, workspace_id, &data, &img.media_type) {
                Ok(saved) => Some(saved),
                Err(e) => {
                    eprintln!("dropping tool result image: {e}");
                    None
                }
            },
        })
        .collect();
    AgentEvent::ToolResult { id, output, is_error, images }
}

/// Every image sent from the UI must live in the images dir (it was put there by `save_image`).
pub fn check_send_paths(home: &Path, images: &[ImageRef]) -> Result<(), String> {
    let root = dunce::canonicalize(images_dir(home)).map_err(|_| "Image not found".to_string())?;
    for img in images {
        if ext_for_media_type(&img.media_type).is_none() {
            return Err(format!("Unsupported image type \"{}\"", img.media_type));
        }
        let p = dunce::canonicalize(&img.path).map_err(|_| format!("Image not found: {}", img.path))?;
        if !p.starts_with(&root) {
            return Err("Images must be added through the composer".into());
        }
    }
    Ok(())
}

/// Reads `path` (relative paths resolve against `base`) as a data URL, if it is an image inside
/// one of `roots`.
pub fn read_data_url(roots: &[PathBuf], base: &Path, path: &str) -> Result<String, String> {
    let given = Path::new(path);
    let full = if given.is_absolute() { given.to_path_buf() } else { base.join(given) };
    let canon = dunce::canonicalize(&full).map_err(|_| format!("Image not found: {path}"))?;
    let inside = roots.iter().filter_map(|r| dunce::canonicalize(r).ok()).any(|r| canon.starts_with(r));
    if !inside {
        return Err("That image is outside this workspace".into());
    }
    let mime = media_type_for_path(&canon).ok_or_else(|| "Not a supported image file (png, jpg, gif, webp, svg)".to_string())?;
    let len = std::fs::metadata(&canon).map_err(|e| e.to_string())?.len();
    if len > MAX_BYTES as u64 {
        return Err("The image is too large (the limit is 20 MB)".into());
    }
    let bytes = std::fs::read(&canon).map_err(|e| format!("Could not read the image: {e}"))?;
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// Loads sent images as `(media_type, base64)` for Claude. Unreadable files are reported, not fatal.
pub fn load_base64(images: &[ImageRef]) -> (Vec<(String, String)>, Vec<String>) {
    let mut ok = Vec::new();
    let mut errs = Vec::new();
    for img in images {
        match std::fs::read(&img.path) {
            Ok(b) => ok.push((img.media_type.clone(), base64::engine::general_purpose::STANDARD.encode(b))),
            Err(e) => errs.push(format!("Could not read image {}: {e}", img.path)),
        }
    }
    (ok, errs)
}

pub fn files_dir(home: &Path) -> PathBuf {
    home.join("files")
}

const RESERVED: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2",
    "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// A safe single path component: no separators, `..`, reserved Windows characters or device names.
pub fn sanitize_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = last
        .replace("..", "")
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
        .collect();
    let mut cleaned: String = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace()).chars().take(120).collect();
    if cleaned.is_empty() {
        return "file".into();
    }
    let stem = cleaned.split('.').next().unwrap_or("").to_ascii_lowercase();
    if RESERVED.contains(&stem.as_str()) {
        cleaned.insert(0, '_');
    }
    cleaned
}

/// Writes an attachment to `<home>/files/<workspace>/<sha256[..16]>/<name>` (idempotent).
pub fn save_file(home: &Path, workspace_id: &str, name: &str, data: &str, media_type: &str) -> Result<FileRef, String> {
    if !valid_workspace_id(workspace_id) {
        return Err("Invalid workspace id".into());
    }
    let bytes = decode_limited(data, MAX_FILE_BYTES, "file")?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err("The file is too large (the limit is 25 MB)".into());
    }
    let name = sanitize_name(name);
    let hash = Sha256::digest(&bytes);
    let dir_name: String = hash.iter().take(8).map(|b| format!("{b:02x}")).collect();
    let dir = files_dir(home).join(workspace_id).join(dir_name);
    let path = dir.join(&name);
    if !path.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create the files folder: {e}"))?;
        std::fs::write(&path, &bytes).map_err(|e| format!("Could not save the file: {e}"))?;
    }
    let media_type = if media_type.trim().is_empty() { "application/octet-stream" } else { media_type };
    Ok(FileRef { path: path.to_string_lossy().to_string(), name, media_type: media_type.to_string(), size: bytes.len() as u64 })
}

/// Every attached file sent from the UI must live in the files dir (put there by `save_file`).
pub fn check_file_paths(home: &Path, files: &[FileRef]) -> Result<(), String> {
    let root = dunce::canonicalize(files_dir(home)).map_err(|_| "File not found".to_string())?;
    for f in files {
        let p = dunce::canonicalize(&f.path).map_err(|_| format!("File not found: {}", f.path))?;
        if !p.starts_with(&root) {
            return Err("Files must be added through the composer".into());
        }
    }
    Ok(())
}

fn human_size(n: u64) -> String {
    match n {
        0..=1023 => format!("{n} B"),
        1024..=1_048_575 => format!("{:.1} KB", n as f64 / 1024.0),
        _ => format!("{:.1} MB", n as f64 / 1_048_576.0),
    }
}

/// The block appended to the agent's copy of a message so it knows where attached files are.
pub fn files_block(files: &[FileRef]) -> String {
    if files.is_empty() {
        return String::new();
    }
    let mut s = String::from("\n\nAttached files (read them with your tools):");
    for f in files {
        s.push_str(&format!("\n- {} ({}): {}", f.name, human_size(f.size), f.path));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

    #[test]
    fn save_validates_and_is_idempotent() {
        let home = tempfile::tempdir().unwrap();
        assert!(save_base64(home.path(), "ws-1", PNG_B64, "image/bmp").unwrap_err().contains("Unsupported"));
        assert!(save_base64(home.path(), "ws-1", "!!!", "image/png").unwrap_err().contains("base64"));
        assert!(save_base64(home.path(), "../x", PNG_B64, "image/png").unwrap_err().contains("Invalid"));
        let a = save_base64(home.path(), "ws-1", PNG_B64, "image/png").unwrap();
        let b = save_base64(home.path(), "ws-1", PNG_B64, "image/png").unwrap();
        assert_eq!(a, b);
        assert!(a.path.ends_with(".png"));
        assert!(Path::new(&a.path).starts_with(images_dir(home.path()).join("ws-1")));
        assert_eq!(Path::new(&a.path).file_stem().unwrap().len(), 16);
        assert!(Path::new(&a.path).exists());
    }

    #[test]
    fn file_names_are_sanitised() {
        assert_eq!(sanitize_name("report.pdf"), "report.pdf");
        assert_eq!(sanitize_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_name("C:\\Users\\me\\a<b>.txt"), "ab.txt");
        assert_eq!(sanitize_name(".."), "file");
        assert_eq!(sanitize_name("  "), "file");
        assert_eq!(sanitize_name("con.txt"), "_con.txt");
        assert_eq!(sanitize_name("a..b.txt"), "ab.txt");
        assert!(sanitize_name(&"x".repeat(500)).len() <= 120);
    }

    #[test]
    fn save_file_is_idempotent_and_capped() {
        let home = tempfile::tempdir().unwrap();
        let data = base64::engine::general_purpose::STANDARD.encode(b"hello");
        let a = save_file(home.path(), "ws", "../notes.txt", &data, "text/plain").unwrap();
        let b = save_file(home.path(), "ws", "../notes.txt", &data, "text/plain").unwrap();
        assert_eq!(a, b);
        assert_eq!((a.name.as_str(), a.size), ("notes.txt", 5));
        assert!(Path::new(&a.path).starts_with(files_dir(home.path()).join("ws")));
        assert_eq!(std::fs::read(&a.path).unwrap(), b"hello");
        assert!(check_file_paths(home.path(), &[a.clone()]).is_ok());
        let outside = FileRef { path: home.path().join("state.db").to_string_lossy().to_string(), ..a.clone() };
        std::fs::write(&outside.path, b"x").unwrap();
        assert!(check_file_paths(home.path(), &[outside]).is_err());
        let big = base64::engine::general_purpose::STANDARD.encode(vec![0u8; MAX_FILE_BYTES + 1]);
        assert!(save_file(home.path(), "ws", "big.bin", &big, "").unwrap_err().contains("too large"));
    }

    #[test]
    fn files_block_format() {
        assert_eq!(files_block(&[]), "");
        let f = FileRef { path: "/h/files/w/ab/r.pdf".into(), name: "r.pdf".into(), media_type: "application/pdf".into(), size: 2048 };
        assert_eq!(files_block(&[f]), "\n\nAttached files (read them with your tools):\n- r.pdf (2.0 KB): /h/files/w/ab/r.pdf");
    }

    #[test]
    fn old_events_deserialize() {
        let ev: AgentEvent = serde_json::from_str(r#"{"type":"userMessage","text":"hi","skill":null}"#).unwrap();
        assert_eq!(ev, AgentEvent::UserMessage { text: "hi".into(), skill: None, images: vec![], files: vec![] });
        let json = serde_json::to_string(&ev).unwrap();
        assert!(!json.contains("images") && !json.contains("files"));
        let ev: AgentEvent = serde_json::from_str(r#"{"type":"toolResult","id":"a","output":"","isError":false}"#).unwrap();
        assert!(matches!(ev, AgentEvent::ToolResult { images, .. } if images.is_empty()));
    }

    #[test]
    fn too_big_is_rejected() {
        let home = tempfile::tempdir().unwrap();
        let big = vec![0u8; MAX_BYTES + 1];
        assert!(store(home.path(), "ws", &big, "image/png").unwrap_err().contains("too large"));
        let huge = "A".repeat(MAX_BYTES / 3 * 4 + 100);
        assert!(save_base64(home.path(), "ws", &huge, "image/png").unwrap_err().contains("too large"));
    }

    #[test]
    fn externalize_writes_files_and_drops_data() {
        let home = tempfile::tempdir().unwrap();
        let ev = AgentEvent::ToolResult {
            id: "t".into(),
            output: String::new(),
            is_error: false,
            images: vec![ImageRef { path: String::new(), media_type: "image/png".into(), data: Some(PNG_B64.into()) }],
        };
        let AgentEvent::ToolResult { images, .. } = externalize(home.path(), "ws", ev) else { panic!() };
        assert_eq!(images.len(), 1);
        assert!(images[0].data.is_none());
        assert!(Path::new(&images[0].path).exists());
        assert!(!serde_json::to_string(&images[0]).unwrap().contains(PNG_B64));
    }

    #[test]
    fn read_guard() {
        let home = tempfile::tempdir().unwrap();
        let wt = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let saved = save_base64(home.path(), "ws", PNG_B64, "image/png").unwrap();
        std::fs::write(wt.path().join("shot.png"), b"png").unwrap();
        std::fs::write(wt.path().join("notes.txt"), b"x").unwrap();
        std::fs::write(outside.path().join("secret.png"), b"png").unwrap();
        let roots = vec![images_dir(home.path()), wt.path().to_path_buf()];

        let url = read_data_url(&roots, wt.path(), &saved.path).unwrap();
        assert!(url.starts_with("data:image/png;base64,"));
        // relative to the worktree
        assert!(read_data_url(&roots, wt.path(), "shot.png").unwrap().starts_with("data:image/png;base64,"));
        // outside, absolute and via ..
        let abs = outside.path().join("secret.png");
        assert!(read_data_url(&roots, wt.path(), &abs.to_string_lossy()).unwrap_err().contains("outside"));
        let rel = format!("../{}/secret.png", outside.path().file_name().unwrap().to_string_lossy());
        assert!(read_data_url(&roots, wt.path(), &rel).is_err());
        // non-image inside, missing
        assert!(read_data_url(&roots, wt.path(), "notes.txt").unwrap_err().contains("supported"));
        assert!(read_data_url(&roots, wt.path(), "nope.png").unwrap_err().contains("not found"));
    }

    #[test]
    fn send_paths_must_be_in_images_dir() {
        let home = tempfile::tempdir().unwrap();
        let saved = save_base64(home.path(), "ws", PNG_B64, "image/png").unwrap();
        assert!(check_send_paths(home.path(), &[saved.clone()]).is_ok());
        let other = tempfile::tempdir().unwrap();
        let f = other.path().join("a.png");
        std::fs::write(&f, b"x").unwrap();
        let bad = ImageRef { path: f.to_string_lossy().to_string(), media_type: "image/png".into(), data: None };
        assert!(check_send_paths(home.path(), &[bad]).is_err());
        let esc = ImageRef { path: format!("{}/../../x.png", saved.path), media_type: "image/png".into(), data: None };
        assert!(check_send_paths(home.path(), &[esc]).is_err());
    }
}
