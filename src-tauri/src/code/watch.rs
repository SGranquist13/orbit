use super::{error, relative, resolve_inside, Result};
use notify::{event::ModifyKind, EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tauri::{AppHandle, Emitter};
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeFsEvent {
    root: String,
    paths: Vec<String>,
    kind: String,
}
struct Watch {
    _debouncer: Debouncer<RecommendedWatcher, RecommendedCache>,
    roots: Arc<Mutex<HashMap<String, usize>>>,
}
fn watches() -> &'static Mutex<HashMap<PathBuf, Watch>> {
    static WATCHES: OnceLock<Mutex<HashMap<PathBuf, Watch>>> = OnceLock::new();
    WATCHES.get_or_init(Default::default)
}
#[tauri::command]
pub fn code_watch(app: AppHandle, root: String) -> Result<()> {
    let base = resolve_inside(Path::new(&root), "")?;
    let mut watches = crate::relock(watches());
    if let Some(w) = watches.get_mut(&base) {
        *crate::relock(&w.roots).entry(root).or_default() += 1;
        return Ok(());
    }
    let roots = Arc::new(Mutex::new(HashMap::from([(root, 1usize)])));
    let emit_roots = roots.clone();
    let emit_base = base.clone();
    let mut debouncer = new_debouncer(Duration::from_millis(150), None, move |batch: DebounceEventResult| {
        let Ok(batch) = batch else { return };
        let mut groups: BTreeMap<&str, BTreeSet<String>> = BTreeMap::new();
        for event in batch {
            let kind = match event.kind {
                EventKind::Create(_) => "create",
                EventKind::Remove(_) => "remove",
                EventKind::Modify(ModifyKind::Name(_)) => "rename",
                EventKind::Modify(_) => "modify",
                _ => "other",
            };
            for path in &event.paths {
                if !path.starts_with(&emit_base) {
                    continue;
                }
                let rel = relative(&emit_base, path);
                if rel.split('/').any(|s| matches!(s, ".git" | "node_modules" | "target")) {
                    continue;
                }
                if !rel.is_empty() {
                    groups.entry(kind).or_default().insert(rel);
                }
            }
        }
        let roots: Vec<String> = crate::relock(&emit_roots).keys().cloned().collect();
        for root in roots {
            for (kind, paths) in &groups {
                let _ = app.emit(
                    "code-fs",
                    CodeFsEvent {
                        root: root.clone(),
                        paths: paths.iter().cloned().collect(),
                        kind: (*kind).into(),
                    },
                );
            }
        }
    })
    .map_err(error)?;
    debouncer.watch(&base, RecursiveMode::Recursive).map_err(error)?;
    watches.insert(base, Watch { _debouncer: debouncer, roots });
    Ok(())
}
#[tauri::command]
pub fn code_unwatch(root: String) -> Result<()> {
    let base = resolve_inside(Path::new(&root), "")?;
    let removed = {
        let mut watches = crate::relock(watches());
        let empty = if let Some(w) = watches.get_mut(&base) {
            let mut roots = crate::relock(&w.roots);
            if let Some(n) = roots.get_mut(&root) {
                *n -= 1;
                if *n == 0 {
                    roots.remove(&root);
                }
            }
            roots.is_empty()
        } else {
            false
        };
        if empty {
            watches.remove(&base)
        } else {
            None
        }
    };
    // Dropping the debouncer joins its worker; never do so under the registry lock.
    drop(removed);
    Ok(())
}
