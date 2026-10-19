use super::{error, relative, resolve_inside, Result};
use serde::Serialize;
use std::{fs, path::Path, time::UNIX_EPOCH};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub rel: String,
    pub dir: bool,
    pub ignored: bool,
    pub size: u64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub text: Option<String>,
    pub mtime: i64,
    pub size: u64,
    pub binary: bool,
    pub too_large: bool,
}
fn mtime(meta: &fs::Metadata) -> Result<i64> {
    Ok(meta.modified().map_err(error)?.duration_since(UNIX_EPOCH).map_err(error)?.as_millis() as i64)
}

#[tauri::command]
pub fn code_list_dir(root: String, rel: String) -> Result<Vec<DirEntry>> {
    let base = resolve_inside(Path::new(&root), "")?;
    let path = resolve_inside(&base, &rel)?;
    // WalkBuilder handles nested .gitignore rules and parent exclusions identically to quick open.
    let mut visible = std::collections::HashSet::new();
    for entry in walker(&base).max_depth(Some(Path::new(&rel).components().count() + 1)).build().flatten() {
        visible.insert(entry.into_path());
    }
    let mut out = vec![];
    for entry in fs::read_dir(path).map_err(error)? {
        let entry = entry.map_err(error)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        let meta = entry.metadata().map_err(error)?;
        out.push(DirEntry {
            name,
            rel: relative(&base, &entry.path()),
            dir: meta.is_dir(),
            ignored: !visible.contains(&entry.path()),
            size: meta.len(),
        });
    }
    out.sort_by(|a, b| {
        b.dir
            .cmp(&a.dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(out)
}

pub(super) fn walker(root: &Path) -> ignore::WalkBuilder {
    let mut w = ignore::WalkBuilder::new(root);
    w.hidden(false).require_git(false).filter_entry(|e| e.file_name() != ".git");
    w
}
#[tauri::command]
pub fn code_list_files(root: String) -> Result<Vec<String>> {
    let base = resolve_inside(Path::new(&root), "")?;
    Ok(walker(&base)
        .build()
        .flatten()
        .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
        .filter(|e| resolve_inside(&base, &relative(&base, e.path())).is_ok())
        .take(20_000)
        .map(|e| relative(&base, e.path()))
        .collect())
}
#[tauri::command]
pub fn code_read_file(root: String, rel: String) -> Result<FileContent> {
    let path = resolve_inside(Path::new(&root), &rel)?;
    let meta = fs::metadata(&path).map_err(error)?;
    let too_large = meta.len() > 5 * 1024 * 1024;
    let mut binary = false;
    let text = if too_large {
        None
    } else {
        let bytes = fs::read(path).map_err(error)?;
        binary = bytes.iter().take(8192).any(|b| *b == 0);
        match String::from_utf8(bytes) {
            Ok(s) if !binary => Some(s),
            _ => {
                binary = true;
                None
            }
        }
    };
    Ok(FileContent {
        text,
        mtime: mtime(&meta)?,
        size: meta.len(),
        binary,
        too_large,
    })
}
#[tauri::command]
pub fn code_write_file(root: String, rel: String, text: String, expected_mtime: Option<i64>) -> Result<i64> {
    let path = resolve_inside(Path::new(&root), &rel)?;
    if let Some(expected) = expected_mtime {
        match fs::metadata(&path) {
            Ok(meta) if mtime(&meta)?.abs_diff(expected) > 1 => return Err("conflict: file changed on disk".into()),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(error(e)),
        }
    }
    let parent = path.parent().ok_or("missing parent")?;
    fs::create_dir_all(parent).map_err(error)?;
    let temp = parent.join(format!(".orbit-write-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        use std::io::Write;
        let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&temp).map_err(error)?;
        f.write_all(text.as_bytes()).map_err(error)?;
        f.sync_all().map_err(error)?;
        drop(f);
        fs::rename(&temp, &path).map_err(error)?;
        mtime(&fs::metadata(&path).map_err(error)?)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
#[tauri::command]
pub fn code_create(root: String, rel: String, dir: bool) -> Result<()> {
    let p = resolve_inside(Path::new(&root), &rel)?;
    if p.exists() {
        return Err("target exists".into());
    }
    if dir {
        fs::create_dir_all(p).map_err(error)
    } else {
        fs::create_dir_all(p.parent().ok_or("missing parent")?).map_err(error)?;
        fs::OpenOptions::new().write(true).create_new(true).open(p).map(|_| ()).map_err(error)
    }
}
fn mutation_path(root: &str, rel: &str) -> Result<std::path::PathBuf> {
    let base = resolve_inside(Path::new(root), "")?;
    let path = resolve_inside(&base, rel)?;
    if path == base {
        return Err("cannot remove or rename root".into());
    }
    Ok(path)
}
#[tauri::command]
pub fn code_rename(root: String, from: String, to: String) -> Result<()> {
    let from = mutation_path(&root, &from)?;
    let to = mutation_path(&root, &to)?;
    if to.symlink_metadata().is_ok() {
        return Err("target exists".into());
    }
    fs::rename(from, to).map_err(error)
}
#[tauri::command]
pub fn code_delete(root: String, rel: String) -> Result<()> {
    trash::delete(mutation_path(&root, &rel)?).map_err(error)
}
#[tauri::command]
pub fn code_file_at(root: String, rel: String, rev: String) -> Result<Option<String>> {
    let base = resolve_inside(Path::new(&root), "")?;
    let file = resolve_inside(&base, &rel)?;
    let Ok(top) = crate::git::run(&base, &["rev-parse", "--show-toplevel"]) else {
        return Ok(None);
    };
    let top = dunce::canonicalize(top.trim()).map_err(error)?;
    let rel = file.strip_prefix(&top).map_err(error)?.to_string_lossy().replace('\\', "/");
    let revision = match rev.as_str() {
        "HEAD" => "HEAD".to_owned(),
        "base" => {
            let branch = crate::git::default_branch(&top);
            let mb = crate::git::run(&top, &["merge-base", "HEAD", &format!("origin/{branch}")])
                .or_else(|_| crate::git::run(&top, &["merge-base", "HEAD", &branch]));
            let Ok(mb) = mb else { return Ok(None) };
            mb.trim().to_owned()
        }
        _ => return Err("invalid revision".into()),
    };
    Ok(crate::git::run_raw(&top, &["show", &format!("{revision}:{rel}")]).ok())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn root(t: &tempfile::TempDir) -> String {
        t.path().to_string_lossy().into_owned()
    }
    #[test]
    fn write_read_conflict() {
        let t = tempfile::tempdir().unwrap();
        let r = root(&t);
        let m = code_write_file(r.clone(), "new/a.txt".into(), "hello\n".into(), None).unwrap();
        let f = code_read_file(r.clone(), "new/a.txt".into()).unwrap();
        assert_eq!(f.text.as_deref(), Some("hello\n"));
        assert_eq!(f.mtime, m);
        assert_eq!(f.size, 6);
        let e = code_write_file(r.clone(), "new/a.txt".into(), "bad".into(), Some(m - 100)).unwrap_err();
        assert!(e.starts_with("conflict:"));
        assert_eq!(fs::read_to_string(t.path().join("new/a.txt")).unwrap(), "hello\n");
        code_write_file(r.clone(), "new/a.txt".into(), "next".into(), Some(m + 1)).unwrap();
        assert_eq!(code_read_file(r, "new/a.txt".into()).unwrap().text.as_deref(), Some("next"));
    }
    #[test]
    fn binary_and_large() {
        let t = tempfile::tempdir().unwrap();
        let r = root(&t);
        for (name, bytes) in [("nul-byte", vec![b'a', 0]), ("invalid", vec![0xff])] {
            fs::write(t.path().join(name), bytes).unwrap();
            let f = code_read_file(r.clone(), name.into()).unwrap();
            assert!(f.binary && f.text.is_none());
        }
        let f = fs::File::create(t.path().join("large")).unwrap();
        f.set_len(5 * 1024 * 1024 + 1).unwrap();
        drop(f);
        let f = code_read_file(r, "large".into()).unwrap();
        assert!(f.too_large && f.text.is_none());
    }
    #[test]
    fn directory_order_ignore_and_quick_open() {
        let t = tempfile::tempdir().unwrap();
        let r = root(&t);
        for d in ["Zdir", "adir", ".git", "nested"] {
            fs::create_dir(t.path().join(d)).unwrap();
        }
        for f in ["Z.txt", "a.txt", "skip.txt", ".hidden", "nested/no.txt", "nested/yes.rs"] {
            fs::write(t.path().join(f), "x").unwrap();
        }
        fs::write(t.path().join(".gitignore"), "skip.txt\n*.txt\n!a.txt\n!Z.txt\n").unwrap();
        fs::write(t.path().join("nested/.gitignore"), "!yes.rs\n").unwrap();
        let list = code_list_dir(r.clone(), "".into()).unwrap();
        let dirs: Vec<_> = list.iter().filter(|e| e.dir).map(|e| e.name.as_str()).collect();
        assert_eq!(dirs, ["adir", "nested", "Zdir"]);
        assert!(list.iter().find(|e| e.name == "skip.txt").unwrap().ignored);
        assert!(!list.iter().find(|e| e.name == "a.txt").unwrap().ignored);
        assert!(!list.iter().any(|e| e.name == ".git"));
        let nested = code_list_dir(r.clone(), "nested".into()).unwrap();
        assert!(nested.iter().find(|e| e.name == "no.txt").unwrap().ignored);
        let files = code_list_files(r).unwrap();
        assert!(files.contains(&".hidden".into()));
        assert!(!files.contains(&"skip.txt".into()));
        assert!(files.contains(&"nested/yes.rs".into()));
    }
    #[test]
    fn create_rename_guards() {
        let t = tempfile::tempdir().unwrap();
        let r = root(&t);
        code_create(r.clone(), "dir".into(), true).unwrap();
        code_create(r.clone(), "dir/a".into(), false).unwrap();
        code_create(r.clone(), "dir/b".into(), false).unwrap();
        assert!(code_rename(r.clone(), "dir/a".into(), "dir/b".into()).is_err());
        code_rename(r.clone(), "dir/a".into(), "dir/c".into()).unwrap();
        assert!(code_delete(r.clone(), "../outside".into()).is_err());
        assert!(code_delete(r.clone(), "".into()).is_err());
        assert!(code_rename(r, "".into(), "other".into()).is_err());
    }
    #[test]
    fn revisions_from_subfolder() {
        let t = tempfile::tempdir().unwrap();
        let r = root(&t);
        assert!(code_file_at(r.clone(), "missing".into(), "HEAD".into()).unwrap().is_none());
        let git = |args: &[&str]| crate::git::run(t.path(), args).unwrap();
        git(&["init", "-q", "-b", "main"]);
        fs::create_dir(t.path().join("sub")).unwrap();
        fs::write(t.path().join("sub/a"), "base\n\n").unwrap();
        git(&["add", "."]);
        git(&["-c", "user.name=t", "-c", "user.email=t@e.x", "commit", "-qm", "base"]);
        git(&["checkout", "-qb", "feature"]);
        fs::write(t.path().join("sub/a"), "head\n").unwrap();
        git(&["add", "."]);
        git(&["-c", "user.name=t", "-c", "user.email=t@e.x", "commit", "-qm", "head"]);
        let sub = t.path().join("sub").to_string_lossy().into_owned();
        assert_eq!(code_file_at(sub.clone(), "a".into(), "HEAD".into()).unwrap().as_deref(), Some("head\n"));
        assert_eq!(code_file_at(sub.clone(), "a".into(), "base".into()).unwrap().as_deref(), Some("base\n\n"));
        assert!(code_file_at(sub, "missing".into(), "HEAD".into()).unwrap().is_none());
    }
}
