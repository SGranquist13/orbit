use super::{error, relative, resolve_inside, Result};
use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{BinaryDetection, SearcherBuilder, Sink, SinkMatch};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};
static LATEST: AtomicU64 = AtomicU64::new(0);
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    pub regex: bool,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub include: String,
    pub exclude: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub rel: String,
    pub line: u64,
    pub start: usize,
    pub end: usize,
    pub text: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub matches: Vec<SearchMatch>,
    pub truncated: bool,
    pub generation: u64,
}
#[tauri::command]
pub async fn code_search(root: String, query: String, options: SearchOptions, generation: u64) -> Result<SearchResult> {
    LATEST.fetch_max(generation, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || search_inner(&root, &query, &options, generation, 2000, &LATEST))
        .await
        .map_err(error)?
}
fn search_inner(root: &str, query: &str, options: &SearchOptions, generation: u64, cap: usize, latest: &AtomicU64) -> Result<SearchResult> {
    let base = resolve_inside(Path::new(root), "")?;
    let mut result = SearchResult {
        matches: vec![],
        truncated: false,
        generation,
    };
    if query.is_empty() {
        return Ok(result);
    }
    let pattern = if options.regex { query.to_owned() } else { regex::escape(query) };
    let pattern = if options.whole_word { format!(r"\b(?:{pattern})\b") } else { pattern };
    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(!options.case_sensitive)
        .build(&pattern)
        .map_err(error)?;
    let mut overrides = ignore::overrides::OverrideBuilder::new(&base);
    for glob in options.include.split(',').map(str::trim).filter(|g| !g.is_empty()) {
        overrides.add(glob).map_err(error)?;
    }
    for glob in options.exclude.split(',').map(str::trim).filter(|g| !g.is_empty()) {
        overrides.add(&format!("!{glob}")).map_err(error)?;
    }
    let overrides = overrides.build().map_err(error)?;
    let walker = super::fs::walker(&base);
    for entry in walker.build() {
        if latest.load(Ordering::SeqCst) > generation || result.truncated {
            break;
        }
        let entry = entry.map_err(error)?;
        if !entry.file_type().is_some_and(|t| t.is_file()) || entry.metadata().map_err(error)?.len() > 1024 * 1024 {
            continue;
        }
        if overrides.matched(entry.path(), false).is_ignore() {
            continue;
        }
        let rel = relative(&base, entry.path());
        let path = resolve_inside(&base, &rel)?;
        // Preflight guarantees binary files never contribute partial matches before a late NUL.
        let bytes = std::fs::read(path).map_err(error)?;
        if bytes.contains(&0) || std::str::from_utf8(&bytes).is_err() {
            continue;
        }
        struct Matches<'a> {
            matcher: &'a grep_regex::RegexMatcher,
            rel: &'a str,
            result: &'a mut SearchResult,
            cap: usize,
            latest: &'a AtomicU64,
        }
        impl Sink for Matches<'_> {
            type Error = std::io::Error;
            fn matched(&mut self, _: &grep_searcher::Searcher, mat: &SinkMatch<'_>) -> std::io::Result<bool> {
                if self.latest.load(Ordering::SeqCst) > self.result.generation {
                    return Ok(false);
                }
                let line = std::str::from_utf8(mat.bytes()).unwrap_or("").trim_end_matches(['\r', '\n']);
                self.matcher
                    .find_iter(line.as_bytes(), |m| {
                        // Byte-mode regexes may match a fragment of a Unicode scalar.
                        // Keep all public columns on valid UTF-8 boundaries.
                        let (Some(prefix), Some(through)) = (line.get(..m.start()), line.get(..m.end())) else {
                            return true;
                        };
                        let start = prefix.encode_utf16().count();
                        let end = through.encode_utf16().count();
                        self.result.matches.push(SearchMatch {
                            rel: self.rel.into(),
                            line: mat.line_number().unwrap_or(1),
                            start,
                            end,
                            text: line.chars().take(300).collect(),
                        });
                        if self.result.matches.len() >= self.cap {
                            self.result.truncated = true;
                            return false;
                        }
                        true
                    })
                    .map_err(std::io::Error::other)?;
                Ok(!self.result.truncated)
            }
        }
        SearcherBuilder::new()
            .line_number(true)
            .binary_detection(BinaryDetection::quit(0))
            .build()
            .search_slice(
                &matcher,
                &bytes,
                Matches {
                    matcher: &matcher,
                    rel: &rel,
                    result: &mut result,
                    cap,
                    latest,
                },
            )
            .map_err(error)?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn search_flags_columns_globs_cap_and_cancel() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().to_string_lossy();
        std::fs::write(t.path().join("a.rs"), "😀é orbit ORBIT orbital\nfoo.bar\nfooXbar\n").unwrap();
        std::fs::write(t.path().join("b.txt"), "orbit\n").unwrap();
        std::fs::write(t.path().join("binary"), b"orbit\n\0").unwrap();
        std::fs::write(t.path().join(".gitignore"), "ignored.rs\n").unwrap();
        std::fs::write(t.path().join("ignored.rs"), "orbit\n").unwrap();
        std::fs::write(t.path().join("large.txt"), "orbit\n".repeat(180_000)).unwrap();
        let latest = AtomicU64::new(1);
        let run = |q: &str, o: &SearchOptions, cap| search_inner(&root, q, o, 1, cap, &latest).unwrap();
        let mut o = SearchOptions::default();
        assert_eq!(run("foo.bar", &o, 100).matches.len(), 1);
        o.whole_word = true;
        let r = run("orbit", &o, 100);
        assert_eq!(r.matches.len(), 3);
        let m = r.matches.iter().find(|m| m.rel == "a.rs").unwrap();
        assert_eq!((m.start, m.end, m.line), (4, 9, 1));
        o.case_sensitive = true;
        assert_eq!(run("orbit", &o, 100).matches.len(), 2);
        o.regex = true;
        assert_eq!(run("foo.bar|ORBIT", &o, 100).matches.len(), 3);
        o.include = "*.rs".into();
        assert_eq!(run("orbit", &o, 100).matches.len(), 1);
        o.include.clear();
        o.exclude = "*.rs".into();
        assert_eq!(run("orbit", &o, 100).matches.len(), 1);
        o.exclude.clear();
        let r = run("orbit", &o, 1);
        assert_eq!(r.matches.len(), 1);
        assert!(r.truncated);
        latest.store(2, Ordering::SeqCst);
        assert!(run("orbit", &o, 100).matches.is_empty());
    }
}
