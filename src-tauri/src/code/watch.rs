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
/// One kind per path, from its last event in the batch: emitting per-kind groups would otherwise
/// reorder them (an atomic replace's `remove` could land after its `create`). A `remove` for a
/// path that still exists was a replace, so it is reported as `modify`.
fn final_kinds(events: Vec<(&'static str, String)>, exists: impl Fn(&str) -> bool) -> BTreeMap<&'static str, BTreeSet<String>> {
    let mut last: HashMap<String, &'static str> = HashMap::new();
    for (kind, rel) in events {
        last.insert(rel, kind);
    }
    let mut groups: BTreeMap<&'static str, BTreeSet<String>> = BTreeMap::new();
    for (rel, kind) in last {
        let kind = if kind == "remove" && exists(&rel) { "modify" } else { kind };
        groups.entry(kind).or_default().insert(rel);
    }
    groups
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
        let mut seen = Vec::new();
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
                    seen.push((kind, rel));
                }
            }
        }
        let groups = final_kinds(seen, |rel| emit_base.join(rel).exists());
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

#[cfg(test)]
mod tests {
    use super::final_kinds;

    #[test]
    fn last_event_wins_and_replaced_files_are_modified() {
        let events = vec![
            ("remove", "COUNT.txt".to_string()),
            ("create", "COUNT.txt".to_string()),
            ("create", "gone.txt".to_string()),
            ("remove", "gone.txt".to_string()),
            ("create", "new.txt".to_string()),
            ("modify", "new.txt".to_string()),
            ("remove", "replaced.txt".to_string()),
        ];
        let groups = final_kinds(events, |rel| rel != "gone.txt");
        let names = |k: &str| groups.get(k).map(|s| s.iter().cloned().collect::<Vec<_>>()).unwrap_or_default();
        assert_eq!(names("create"), ["COUNT.txt"]);
        assert_eq!(names("remove"), ["gone.txt"]);
        assert_eq!(names("modify"), ["new.txt", "replaced.txt"]);
    }
}
