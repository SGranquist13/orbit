//! Finds projects related to a workspace's repo (packages that consume it, or that it consumes)
//! by comparing manifests, so Orbit can suggest attaching them. Manifests are read with simple
//! scanning: good enough to spot dependencies, with no extra parser dependencies.

use serde::Serialize;
use std::path::{Component, Path, PathBuf};

/// Directories that are never projects of their own.
const SKIP_DIRS: [&str; 4] = ["node_modules", "target", "dist", "build"];
/// Upper bound on directories inspected per discovery, so huge parent folders stay fast.
const MAX_CANDIDATES: usize = 300;

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Manifest {
    /// Manifest file the info came from, e.g. `package.json`.
    pub file: &'static str,
    pub name: Option<String>,
    pub deps: Vec<String>,
    /// Dependencies on local folders (`file:../x`, `path = "../x"`), resolved against the project dir.
    pub path_deps: Vec<PathBuf>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Related {
    pub path: String,
    pub name: String,
    /// "dependent" (uses this project) | "dependency" (used by this project)
    pub relation: String,
    pub evidence: String,
}

/// Reads the first manifest found in `dir`: package.json, Cargo.toml, pyproject.toml, go.mod.
pub fn manifest_info(dir: &Path) -> Option<Manifest> {
    let read = |f: &str| std::fs::read_to_string(dir.join(f)).ok();
    if let Some(m) = read("package.json").and_then(|s| package_json(dir, &s)) {
        return Some(m);
    }
    if let Some(s) = read("Cargo.toml") {
        return Some(cargo_toml(dir, &s));
    }
    if let Some(s) = read("pyproject.toml") {
        return Some(pyproject(&s));
    }
    read("go.mod").map(|s| go_mod(dir, &s))
}

fn package_json(dir: &Path, text: &str) -> Option<Manifest> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let mut m = Manifest { file: "package.json", name: v["name"].as_str().map(String::from), ..Default::default() };
    for section in ["dependencies", "devDependencies", "peerDependencies"] {
        let Some(map) = v[section].as_object() else { continue };
        for (name, spec) in map {
            m.deps.push(name.clone());
            let spec = spec.as_str().unwrap_or_default();
            // `workspace:*` has no path; `workspace:../x` and `file:`/`link:` do.
            let path = ["file:", "link:", "portal:", "workspace:"].iter().find_map(|p| spec.strip_prefix(p));
            if let Some(p) = path.filter(|p| p.starts_with('.')) {
                m.path_deps.push(normalize(&dir.join(p)));
            }
        }
    }
    Some(m)
}

/// The string value of `key = "value"` on this line, if it is one.
fn toml_str(line: &str, key: &str) -> Option<String> {
    let rest = line.strip_prefix(key)?.trim_start().strip_prefix('=')?.trim_start();
    let rest = rest.strip_prefix('"')?;
    Some(rest[..rest.find('"')?].to_string())
}

/// `path = "../x"` anywhere on the line (inline-table dependency).
fn inline_path(line: &str) -> Option<&str> {
    let after = &line[line.find("path")? + 4..];
    let after = after.trim_start().strip_prefix('=')?.trim_start().strip_prefix('"')?;
    Some(&after[..after.find('"')?])
}

fn cargo_toml(dir: &Path, text: &str) -> Manifest {
    let mut m = Manifest { file: "Cargo.toml", ..Default::default() };
    let mut section = String::new();
    for raw in text.lines() {
        let line = raw.trim();
        if let Some(h) = line.strip_prefix('[') {
            section = h.trim_end_matches(']').trim().to_string();
            // `[dependencies.foo]` declares the dependency `foo` by its header.
            if let Some(dep) = section.rsplit_once(".dependencies.").map(|(_, d)| d).or_else(|| {
                ["dependencies.", "dev-dependencies.", "build-dependencies."].iter().find_map(|p| section.strip_prefix(p))
            }) {
                m.deps.push(dep.trim_matches('"').to_string());
            }
            continue;
        }
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let is_dep_table = section == "dependencies"
            || section == "dev-dependencies"
            || section == "workspace.dependencies"
            || (section.starts_with("target.") && section.ends_with("dependencies"));
        if section == "package" {
            if let Some(n) = toml_str(line, "name") {
                m.name = Some(n);
            }
        } else if is_dep_table {
            if let Some((key, _)) = line.split_once('=') {
                m.deps.push(key.trim().trim_matches('"').to_string());
                if let Some(p) = inline_path(line) {
                    m.path_deps.push(normalize(&dir.join(p)));
                }
            }
        } else if section.contains("dependencies.") {
            // Body of a `[dependencies.foo]` table.
            if let Some(p) = toml_str(line, "path") {
                m.path_deps.push(normalize(&dir.join(p)));
            }
        }
    }
    m
}

/// Package name from a PEP 508 requirement: `requests[socks]>=2 ; python_version<"3.9"` -> `requests`.
fn requirement_name(req: &str) -> String {
    req.trim()
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .collect()
}

fn pyproject(text: &str) -> Manifest {
    let mut m = Manifest { file: "pyproject.toml", ..Default::default() };
    let mut section = String::new();
    let mut in_list = false;
    for raw in text.lines() {
        let line = raw.trim();
        if in_list {
            // Continuation of `dependencies = [` ... `]`.
            collect_quoted(line, &mut m.deps);
            in_list = !line.contains(']');
            continue;
        }
        if let Some(h) = line.strip_prefix('[') {
            section = h.trim_end_matches(']').trim().to_string();
            continue;
        }
        match section.as_str() {
            "project" => {
                if let Some(n) = toml_str(line, "name") {
                    m.name = Some(n);
                } else if let Some(rest) = line.strip_prefix("dependencies").map(str::trim_start).and_then(|r| r.strip_prefix('=')) {
                    collect_quoted(rest, &mut m.deps);
                    in_list = !rest.contains(']');
                }
            }
            "tool.poetry" => {
                if let Some(n) = toml_str(line, "name") {
                    m.name = Some(n);
                }
            }
            "tool.poetry.dependencies" | "tool.poetry.group.dev.dependencies" => {
                if let Some((key, _)) = line.split_once('=') {
                    let key = key.trim();
                    if key != "python" {
                        m.deps.push(key.to_string());
                    }
                }
            }
            _ => {}
        }
    }
    m
}

/// Pushes the requirement name of every `"..."` string on the line.
fn collect_quoted(line: &str, out: &mut Vec<String>) {
    for (i, part) in line.split('"').enumerate() {
        if i % 2 == 1 {
            let name = requirement_name(part);
            if !name.is_empty() {
                out.push(name);
            }
        }
    }
}

fn go_mod(dir: &Path, text: &str) -> Manifest {
    let mut m = Manifest { file: "go.mod", ..Default::default() };
    let mut in_require = false;
    for raw in text.lines() {
        let line = raw.split("//").next().unwrap_or_default().trim();
        if let Some(n) = line.strip_prefix("module ") {
            m.name = Some(n.trim().trim_matches('"').to_string());
        } else if line.starts_with("require (") {
            in_require = true;
        } else if in_require && line == ")" {
            in_require = false;
        } else if let Some(r) = line.strip_prefix("require ") {
            m.deps.extend(r.split_whitespace().next().map(String::from));
        } else if in_require {
            m.deps.extend(line.split_whitespace().next().map(String::from));
        } else if let Some(r) = line.strip_prefix("replace ") {
            // `replace example.com/x => ../x` points a module at a local folder.
            if let Some(target) = r.split("=>").nth(1).map(str::trim).filter(|t| t.starts_with('.')) {
                m.path_deps.push(normalize(&dir.join(target.split_whitespace().next().unwrap_or(target))));
            }
        }
    }
    m
}

/// Resolves `.` and `..` lexically, so paths that do not exist yet still compare.
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Canonical form for comparing folders: symlinks resolved and the Windows `\\?\` prefix dropped.
/// Falls back to the lexical path when the folder does not exist.
pub fn canonical(p: &Path) -> PathBuf {
    let c = std::fs::canonicalize(p).unwrap_or_else(|_| normalize(p));
    let s = c.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => c,
    }
}

fn same_dir(a: &Path, b: &Path) -> bool {
    let (a, b) = (canonical(a), canonical(b));
    if cfg!(windows) { a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy()) } else { a == b }
}

fn same_name(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b) || a.replace('_', "-").eq_ignore_ascii_case(&b.replace('_', "-"))
}

fn folder_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| p.to_string_lossy().to_string())
}

/// How `candidate` relates to `project`, judged only from their manifests.
fn relate(project: &Path, mine: Option<&Manifest>, candidate: &Path) -> Option<Related> {
    let theirs = manifest_info(candidate)?;
    let mk = |relation: &str, evidence: String| Related {
        path: candidate.to_string_lossy().to_string(),
        name: folder_name(candidate),
        relation: relation.into(),
        evidence,
    };
    // Dependent: the candidate depends on this project.
    if let Some(name) = mine.and_then(|m| m.name.as_deref()) {
        if theirs.deps.iter().any(|d| same_name(d, name)) {
            return Some(mk("dependent", format!("{} depends on \"{name}\"", theirs.file)));
        }
    }
    if theirs.path_deps.iter().any(|p| same_dir(p, project)) {
        return Some(mk("dependent", format!("{} links to {}", theirs.file, folder_name(project))));
    }
    // Dependency: this project depends on the candidate.
    let mine = mine?;
    if let Some(name) = theirs.name.as_deref() {
        if mine.deps.iter().any(|d| same_name(d, name)) {
            return Some(mk("dependency", format!("this project's {} depends on \"{name}\"", mine.file)));
        }
    }
    if mine.path_deps.iter().any(|p| same_dir(p, candidate)) {
        return Some(mk("dependency", format!("this project's {} links to {}", mine.file, folder_name(candidate))));
    }
    None
}

/// Finds which `candidates` use `project` or are used by it.
pub fn discover(project: &Path, candidates: &[PathBuf]) -> Vec<Related> {
    let mine = manifest_info(project);
    candidates.iter().filter_map(|c| relate(project, mine.as_ref(), c)).collect()
}

/// Folders worth inspecting: siblings of the project plus `known` (repos already in Orbit),
/// de-duplicated, without the project itself, hidden or build-output folders.
pub fn candidates(project: &Path, known: &[PathBuf]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut seen: Vec<PathBuf> = vec![canonical(project)];
    let mut push = |p: PathBuf| {
        let name = folder_name(&p);
        if out.len() >= MAX_CANDIDATES || name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) || !p.is_dir() {
            return;
        }
        let key = canonical(&p);
        if !seen.contains(&key) {
            seen.push(key);
            out.push(p);
        }
    };
    if let Some(parent) = project.parent() {
        let mut siblings: Vec<PathBuf> = std::fs::read_dir(parent)
            .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.path()).collect())
            .unwrap_or_default();
        siblings.sort();
        siblings.into_iter().for_each(&mut push);
    }
    known.iter().cloned().for_each(&mut push);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("orbit_related_{name}_{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn project(root: &Path, name: &str, manifest: &str, body: &str) -> PathBuf {
        let d = root.join(name);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(manifest), body).unwrap();
        d
    }

    #[test]
    fn package_json_manifest() {
        let root = tmp("pkgjson");
        let d = project(
            &root,
            "app",
            "package.json",
            r#"{"name":"@acme/app","dependencies":{"@acme/ui":"^1","local":"file:../local"},
                "devDependencies":{"tool":"link:../tool","ws":"workspace:*"},"peerDependencies":{"react":"19"}}"#,
        );
        let m = manifest_info(&d).unwrap();
        assert_eq!(m.name.as_deref(), Some("@acme/app"));
        for dep in ["@acme/ui", "local", "tool", "ws", "react"] {
            assert!(m.deps.iter().any(|x| x == dep), "{dep}");
        }
        assert_eq!(m.path_deps, vec![normalize(&root.join("local")), normalize(&root.join("tool"))]);
    }

    #[test]
    fn cargo_toml_manifest() {
        let root = tmp("cargo");
        let d = project(
            &root,
            "api",
            "Cargo.toml",
            "[package]\nname = \"api\"\nversion = \"0.1.0\"\n\n[dependencies]\nserde = \"1\"\ncore = { path = \"../core\" }\n\n\
             [dev-dependencies]\ntempfile = \"3\"\n\n[dependencies.extra]\npath = \"../extra\"\n",
        );
        let m = manifest_info(&d).unwrap();
        assert_eq!(m.name.as_deref(), Some("api"));
        for dep in ["serde", "core", "tempfile", "extra"] {
            assert!(m.deps.iter().any(|x| x == dep), "{dep}");
        }
        assert_eq!(m.path_deps, vec![normalize(&root.join("core")), normalize(&root.join("extra"))]);
    }

    #[test]
    fn pyproject_and_go_mod_manifests() {
        let root = tmp("pygo");
        let py = project(
            &root,
            "svc",
            "pyproject.toml",
            "[project]\nname = \"svc\"\ndependencies = [\n  \"requests>=2\",\n  \"shared-lib[extra] ; python_version>'3'\",\n]\n",
        );
        let m = manifest_info(&py).unwrap();
        assert_eq!(m.name.as_deref(), Some("svc"));
        assert_eq!(m.deps, vec!["requests".to_string(), "shared-lib".to_string()]);

        let go = project(
            &root,
            "gosvc",
            "go.mod",
            "module example.com/gosvc\n\ngo 1.22\n\nrequire (\n\texample.com/lib v1.2.3\n)\nrequire example.com/other v0.1.0\nreplace example.com/lib => ../lib\n",
        );
        let m = manifest_info(&go).unwrap();
        assert_eq!(m.name.as_deref(), Some("example.com/gosvc"));
        assert_eq!(m.deps, vec!["example.com/lib".to_string(), "example.com/other".to_string()]);
        assert_eq!(m.path_deps, vec![normalize(&root.join("lib"))]);
    }

    #[test]
    fn discovers_package_json_in_both_directions() {
        let root = tmp("disc_pkg");
        let lib = project(&root, "ui", "package.json", r#"{"name":"@acme/ui","dependencies":{"@acme/tokens":"^1"}}"#);
        let app = project(&root, "web", "package.json", r#"{"name":"web","dependencies":{"@acme/ui":"^1"}}"#);
        let tokens = project(&root, "tokens", "package.json", r#"{"name":"@acme/tokens"}"#);
        let linked = project(&root, "docs", "package.json", r#"{"name":"docs","dependencies":{"x":"file:../ui"}}"#);
        let unrelated = project(&root, "other", "package.json", r#"{"name":"other"}"#);

        let found = discover(&lib, &[app.clone(), tokens.clone(), linked.clone(), unrelated]);
        let by = |p: &Path| found.iter().find(|r| Path::new(&r.path) == p).unwrap();
        assert_eq!(by(&app).relation, "dependent");
        assert_eq!(by(&app).evidence, "package.json depends on \"@acme/ui\"");
        assert_eq!(by(&linked).relation, "dependent");
        assert_eq!(by(&tokens).relation, "dependency");
        assert_eq!(by(&tokens).name, "tokens");
        assert_eq!(found.len(), 3);
    }

    #[test]
    fn discovers_cargo_in_both_directions() {
        let root = tmp("disc_cargo");
        let core = project(&root, "core", "Cargo.toml", "[package]\nname = \"core-lib\"\n\n[dependencies]\nutil = { path = \"../util\" }\n");
        let util = project(&root, "util", "Cargo.toml", "[package]\nname = \"util\"\n");
        let api = project(&root, "api", "Cargo.toml", "[package]\nname = \"api\"\n\n[dependencies]\ncore-lib = { path = \"../core\" }\n");
        let cli = project(&root, "cli", "Cargo.toml", "[package]\nname = \"cli\"\n\n[dev-dependencies]\ncore-lib = \"0.1\"\n");

        let found = discover(&core, &[util.clone(), api.clone(), cli.clone()]);
        let rel = |p: &Path| found.iter().find(|r| Path::new(&r.path) == p).map(|r| r.relation.as_str());
        assert_eq!(rel(&util), Some("dependency"));
        assert_eq!(rel(&api), Some("dependent"));
        assert_eq!(rel(&cli), Some("dependent"));
    }

    #[test]
    fn candidates_skip_self_hidden_and_duplicates() {
        let root = tmp("cands");
        let me = root.join("me");
        for d in ["me", "a", ".hidden", "node_modules", "target"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        std::fs::write(root.join("file.txt"), "x").unwrap();
        let elsewhere = tmp("cands_other");
        let found = candidates(&me, &[root.join("a"), elsewhere.clone(), me.clone()]);
        assert_eq!(found, vec![root.join("a"), elsewhere]);
    }
}
