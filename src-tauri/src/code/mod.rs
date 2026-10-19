//! Filesystem, search, watcher and terminal services for Orbit Code.
pub mod fs;
pub mod pty;
pub mod search;
pub mod watch;

use std::path::{Component, Path, PathBuf};
pub type Result<T> = std::result::Result<T, String>;
pub(super) fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}
pub(super) fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/")
}

/// Check each existing ancestor before traversing further, including symlinks.
/// New suffixes are allowed, but never above the canonical root.
pub fn resolve_inside(root: &Path, rel: &str) -> Result<PathBuf> {
    let root = dunce::canonicalize(root).map_err(error)?;
    let mut path = root.clone();
    for c in Path::new(rel).components() {
        match c {
            Component::Normal(name) => {
                #[cfg(windows)]
                if name.to_string_lossy().contains(':') {
                    return Err("invalid path component".into());
                }
                path.push(name);
            }
            Component::CurDir => continue,
            Component::ParentDir => {
                if path == root {
                    return Err("path escapes root".into());
                }
                path.pop();
            }
            _ => return Err("absolute paths are forbidden".into()),
        }
        match std::fs::symlink_metadata(&path) {
            Ok(_) => {
                path = dunce::canonicalize(&path).map_err(error)?;
                if !path.starts_with(&root) {
                    return Err("symlink escapes root".into());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(error(e)),
        }
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn guard() {
        let t = tempfile::tempdir().unwrap();
        for p in ["../x", "a/../../x", "/absolute"] {
            assert!(resolve_inside(t.path(), p).is_err(), "{p}");
        }
        #[cfg(windows)]
        for p in ["C:\\x", "C:x", "\\\\server\\share", "a:stream"] {
            assert!(resolve_inside(t.path(), p).is_err());
        }
        assert_eq!(
            resolve_inside(t.path(), "new/deep/file").unwrap(),
            dunce::canonicalize(t.path()).unwrap().join("new/deep/file")
        );
    }
    #[test]
    fn symlink_escape() {
        let t = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_dir(outside.path(), t.path().join("link"));
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(outside.path(), t.path().join("link"));
        if made.is_err() {
            return;
        }
        assert!(resolve_inside(t.path(), "link/new/file").is_err());
        assert!(resolve_inside(t.path(), "link/../file").is_err());
    }
}
