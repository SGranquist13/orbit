//! External editor discovery and launching. Custom commands are argv, never shell scripts.
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Debug, Clone, serde::Serialize)]
pub struct EditorInfo {
    pub id: String,
    pub name: String,
    pub command: String,
}

const EDITORS: &[(&str, &str, &str)] = &[
    ("code", "VS Code", "Microsoft VS Code"),
    ("cursor", "Cursor", "cursor"),
    ("zed", "Zed", "Zed"),
    ("windsurf", "Windsurf", "Windsurf"),
    ("idea", "IntelliJ IDEA", "IntelliJ IDEA"),
    ("webstorm", "WebStorm", "WebStorm"),
    ("pycharm", "PyCharm", "PyCharm"),
    ("rustrover", "RustRover", "RustRover"),
    ("goland", "GoLand", "GoLand"),
];

/// Pure ordered candidate list: PATH first, then per-user Windows installs.
fn candidates(id: &str, install: &str, path: &[PathBuf], programs: Option<&Path>, extensions: &[&str]) -> Vec<PathBuf> {
    let mut dirs = path.to_vec();
    if let Some(root) = programs {
        dirs.push(root.join(install).join("bin"));
        dirs.push(root.join(install));
        dirs.push(root.join("JetBrains").join(install).join("bin"));
    }
    dirs.iter().flat_map(|dir| extensions.iter().map(move |ext| dir.join(format!("{id}{ext}")))).collect()
}

fn resolve(paths: &[PathBuf]) -> Option<PathBuf> {
    paths.iter().find(|p| {
        if !p.is_file() { return false; }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            return p.metadata().is_ok_and(|m| m.permissions().mode() & 0o111 != 0);
        }
        #[cfg(not(unix))]
        true
    }).cloned()
}

pub fn detect_editors() -> Vec<EditorInfo> {
    let path: Vec<_> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    let programs = if cfg!(windows) { std::env::var_os("LOCALAPPDATA").map(|p| PathBuf::from(p).join("Programs")) } else { None };
    let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    let extensions: Vec<&str> = if cfg!(windows) { pathext.split(';').filter(|e| e.starts_with('.')).collect() } else { vec![""] };
    EDITORS.iter().filter_map(|(id, name, install)| {
        let command = resolve(&candidates(id, install, &path, programs.as_deref(), &extensions))?;
        Some(EditorInfo { id: (*id).into(), name: (*name).into(), command: command.to_string_lossy().into_owned() })
    }).collect()
}

/// Quotes group arguments; backslashes remain literal (including Windows paths).
fn command_args(line: &str, path: &str) -> Result<Vec<String>, String> {
    let mut args = Vec::new();
    let mut arg = String::new();
    let mut quote = None;
    let mut started = false;
    for c in line.chars() {
        if quote == Some(c) { quote = None; }
        else if quote.is_none() && matches!(c, '\'' | '"') { quote = Some(c); started = true; }
        else if quote.is_none() && c.is_whitespace() {
            if started { args.push(std::mem::take(&mut arg)); started = false; }
        } else { arg.push(c); started = true; }
    }
    if quote.is_some() { return Err("Editor command has an unclosed quote".into()); }
    if started { args.push(arg); }
    if args.first().is_none_or(|a| a.is_empty()) { return Err("Editor command is empty".into()); }
    let placeholder = args.iter().any(|a| a.contains("{path}"));
    for arg in &mut args { *arg = arg.replace("{path}", path); }
    if !placeholder { args.push(path.into()); }
    Ok(args)
}

pub fn open(path: &str, editor: Option<&str>) -> Result<(), String> {
    if !Path::new(path).is_dir() { return Err(format!("Workspace folder does not exist: {path}")); }
    let detected = detect_editors();
    let args = match editor {
        None => vec![detected.first().ok_or("No external editor found. Install an editor or set editorCommand to a custom command.")?.command.clone(), path.into()],
        Some(value) => {
            if let Some(found) = detected.iter().find(|e| e.id == value) {
                vec![found.command.clone(), path.into()]
            } else if EDITORS.iter().any(|(id, _, _)| *id == value) {
                return Err(format!("Editor '{value}' was not found. Install it or configure a custom editor command."));
            } else { command_args(value, path)? }
        }
    };
    let mut cmd = Command::new(&args[0]);
    cmd.args(&args[1..]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW (as in agent/process.rs) + CREATE_NEW_PROCESS_GROUP.
        cmd.creation_flags(0x0800_0000 | 0x0000_0200);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| format!("Could not open editor '{}': {e}", args[0]))?;
    std::thread::spawn(move || { let _ = child.wait(); });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_preserve_path_and_pathext_order_then_install_locations() {
        let paths = candidates("code", "Microsoft VS Code", &["first".into(), "second".into()], Some(Path::new("Programs")), &[".exe", ".cmd"]);
        assert_eq!(&paths[..4], &[PathBuf::from("first/code.exe"), "first/code.cmd".into(), "second/code.exe".into(), "second/code.cmd".into()]);
        assert_eq!(paths[4], Path::new("Programs").join("Microsoft VS Code/bin/code.exe"));
        assert_eq!(EDITORS.len(), 9);
    }

    #[test]
    fn custom_commands_keep_folder_as_one_literal_argument() {
        assert_eq!(command_args(r#""C:\My Editor\editor.exe" --folder="{path}""#, "a b & c").unwrap(), vec![r"C:\My Editor\editor.exe", "--folder=a b & c"]);
        assert_eq!(command_args("code --new-window", "a b").unwrap(), vec!["code", "--new-window", "a b"]);
        assert!(command_args("'unfinished", "folder").is_err());
        assert!(command_args("", "folder").is_err());
    }

    #[test]
    fn unix_candidates_have_no_windows_suffixes_or_fallbacks() {
        assert_eq!(candidates("zed", "Zed", &["/usr/bin".into()], None, &[""]), vec![PathBuf::from("/usr/bin/zed")]);
    }
}
