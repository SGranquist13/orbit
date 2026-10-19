use super::{error, resolve_inside, Result};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::Path,
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Emitter, State};
struct Terminal {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}
fn terminals() -> &'static Mutex<HashMap<String, Terminal>> {
    static TERMINALS: OnceLock<Mutex<HashMap<String, Terminal>>> = OnceLock::new();
    TERMINALS.get_or_init(Default::default)
}
#[derive(Clone, Serialize)]
pub struct PtyData {
    id: String,
    data: String,
}
#[derive(Clone, Serialize)]
pub struct PtyExit {
    id: String,
    code: Option<u32>,
}
fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols: cols.max(1),
        rows: rows.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}
fn shell(config: &str) -> Result<CommandBuilder> {
    let mut parts = config.split_whitespace();
    if let Some(program) = parts.next() {
        let mut cmd = CommandBuilder::new(program);
        cmd.args(parts);
        return Ok(cmd);
    }
    #[cfg(windows)]
    let program = ["pwsh.exe", "powershell.exe", "cmd.exe"]
        .into_iter()
        .find_map(|s| which::which(s).ok())
        .ok_or("no shell found")?;
    #[cfg(not(windows))]
    let program = std::env::var_os("SHELL").map(std::path::PathBuf::from).unwrap_or_else(|| "/bin/sh".into());
    Ok(CommandBuilder::new(program))
}
/// Retain an incomplete trailing UTF-8 sequence; replace only known invalid sequences.
fn decode(pending: &mut Vec<u8>, eof: bool) -> String {
    let mut out = String::new();
    let mut consumed = 0;
    while consumed < pending.len() {
        match std::str::from_utf8(&pending[consumed..]) {
            Ok(s) => {
                out.push_str(s);
                consumed = pending.len();
            }
            Err(e) => {
                let end = consumed + e.valid_up_to();
                out.push_str(std::str::from_utf8(&pending[consumed..end]).unwrap());
                consumed = end;
                if let Some(n) = e.error_len() {
                    out.push('\u{fffd}');
                    consumed += n;
                } else if eof {
                    out.push('\u{fffd}');
                    consumed = pending.len();
                } else {
                    break;
                }
            }
        }
    }
    pending.drain(..consumed);
    out
}
fn open(
    cwd: &str,
    cols: u16,
    rows: u16,
    config: &str,
    on_data: impl Fn(PtyData) + Send + 'static,
    on_exit: impl Fn(PtyExit) + Send + 'static,
) -> Result<String> {
    let cwd = resolve_inside(Path::new(cwd), "")?;
    let pair = native_pty_system().openpty(size(cols, rows)).map_err(error)?;
    let mut cmd = shell(config)?;
    cmd.cwd(cwd);
    for key in crate::agent::process::host_env_keys() {
        cmd.env_remove(key);
    }
    cmd.env("TERM", "xterm-256color");
    let mut reader = pair.master.try_clone_reader().map_err(error)?;
    let writer = pair.master.take_writer().map_err(error)?;
    let mut child = pair.slave.spawn_command(cmd).map_err(error)?;
    drop(pair.slave);
    let id = uuid::Uuid::new_v4().to_string();
    let killer = child.clone_killer();
    crate::relock(terminals()).insert(
        id.clone(),
        Terminal {
            master: pair.master,
            writer,
            killer,
        },
    );
    let wait_id = id.clone();
    let (exit_tx, exit_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code());
        let removed = crate::relock(terminals()).remove(&wait_id);
        drop(removed);
        let _ = exit_tx.send(code);
    });
    let thread_id = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let data = decode(&mut pending, false);
                    if !data.is_empty() {
                        on_data(PtyData { id: thread_id.clone(), data });
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        let data = decode(&mut pending, true);
        if !data.is_empty() {
            on_data(PtyData { id: thread_id.clone(), data });
        }
        let code = exit_rx.recv().ok().flatten();
        on_exit(PtyExit { id: thread_id, code });
    });
    Ok(id)
}
#[tauri::command]
pub fn pty_open(app: AppHandle, state: State<'_, crate::AppState>, cwd: String, cols: u16, rows: u16) -> Result<String> {
    let config = state.settings().terminal_shell;
    let exit_app = app.clone();
    open(
        &cwd,
        cols,
        rows,
        &config,
        move |data| {
            let _ = app.emit("pty-data", data);
        },
        move |exit| {
            let _ = exit_app.emit("pty-exit", exit);
        },
    )
}
#[tauri::command]
pub fn pty_write(id: String, data: String) -> Result<()> {
    let mut map = crate::relock(terminals());
    let terminal = map.get_mut(&id).ok_or("terminal not found")?;
    terminal.writer.write_all(data.as_bytes()).map_err(error)?;
    terminal.writer.flush().map_err(error)
}
#[tauri::command]
pub fn pty_resize(id: String, cols: u16, rows: u16) -> Result<()> {
    let map = crate::relock(terminals());
    map.get(&id).ok_or("terminal not found")?.master.resize(size(cols, rows)).map_err(error)
}
#[tauri::command]
pub fn pty_close(id: String) -> Result<()> {
    let removed = crate::relock(terminals()).remove(&id);
    // Dropping the master closes the pseudoconsole, which ends the shell even when the kill
    // itself fails (ConPTY can report a timeout for a process that is already going away).
    if let Some(mut terminal) = removed {
        let _ = terminal.killer.kill();
        drop(terminal);
    }
    Ok(())
}
pub fn close_all() {
    let all = std::mem::take(&mut *crate::relock(terminals()));
    for (_, mut terminal) in all {
        let _ = terminal.killer.kill();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn incremental_utf8() {
        let mut b = vec![0xf0, 0x9f];
        assert_eq!(decode(&mut b, false), "");
        b.extend_from_slice(&[0x98, 0x80, 0xff, b'x', 0xc3]);
        assert_eq!(decode(&mut b, false), "😀�x");
        assert_eq!(decode(&mut b, true), "�");
    }
    #[test]
    fn shell_echo() {
        let t = tempfile::tempdir().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let id = open(
            &t.path().to_string_lossy(),
            80,
            24,
            "",
            move |d| {
                let _ = tx.send(d.data);
            },
            |_| {},
        )
        .unwrap();
        pty_write(id.clone(), "echo orbit-pty\r\n".into()).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut output = String::new();
        let mut found = false;
        while std::time::Instant::now() < deadline {
            if let Ok(data) = rx.recv_timeout(std::time::Duration::from_millis(100)) {
                output.push_str(&data);
                // ConPTY asks for the cursor position before it emits anything; xterm.js answers in the app.
                if data.contains("\x1b[6n") {
                    pty_write(id.clone(), "\x1b[1;1R".into()).unwrap();
                }
                if output.contains("orbit-pty") {
                    found = true;
                    break;
                }
            }
        }
        pty_resize(id.clone(), 100, 30).unwrap();
        pty_close(id).unwrap();
        assert!(found, "{output}");
    }
}
