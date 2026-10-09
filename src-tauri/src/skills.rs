//! Skill packs: directories in the standard Claude plugin layout
//! (`skills/<name>/SKILL.md`, `commands/*.md`, optional `.claude-plugin/plugin.json`),
//! installed by git URL. Public libraries such as ECC drop in unchanged.
//!
//! Invocation:
//! - Claude loads enabled packs via `--plugin-dir` and runs `/<plugin>:<name> args` natively.
//! - Codex has no plugin loading for foreign skills, so the IDE expands the markdown itself.

use anyhow::{anyhow, Context};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Our bundled shipping pack, rewritten on every start so updates ship with the app.
const SHIPKIT: &[(&str, &str)] = &[
    (".claude-plugin/plugin.json", include_str!("../shipkit/.claude-plugin/plugin.json")),
    ("commands/ship.md", include_str!("../shipkit/commands/ship.md")),
    ("commands/fix-ci.md", include_str!("../shipkit/commands/fix-ci.md")),
    ("commands/address-comments.md", include_str!("../shipkit/commands/address-comments.md")),
    ("commands/rebase.md", include_str!("../shipkit/commands/rebase.md")),
    ("commands/write-ticket.md", include_str!("../shipkit/commands/write-ticket.md")),
    ("commands/start-issue.md", include_str!("../shipkit/commands/start-issue.md")),
    ("commands/preflight.md", include_str!("../shipkit/commands/preflight.md")),
    ("agents/builder.md", include_str!("../shipkit/agents/builder.md")),
    ("agents/debugger.md", include_str!("../shipkit/agents/debugger.md")),
    ("agents/planner.md", include_str!("../shipkit/agents/planner.md")),
    ("agents/reviewer.md", include_str!("../shipkit/agents/reviewer.md")),
    ("agents/shipper.md", include_str!("../shipkit/agents/shipper.md")),
    ("agents/ticket-writer.md", include_str!("../shipkit/agents/ticket-writer.md")),
];

pub const BUILTIN_PACK: &str = "shipkit";
pub const DEFAULT_PINS: &[&str] = &["shipkit:preflight", "shipkit:ship", "shipkit:fix-ci", "shipkit:address-comments", "shipkit:rebase"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pack {
    /// Directory name under `packs/`; stable id.
    pub name: String,
    /// Namespace Claude uses for slash commands (`plugin.json` name, else dir name).
    pub plugin: String,
    pub description: Option<String>,
    pub path: String,
    pub source: Option<String>,
    pub builtin: bool,
    pub enabled: bool,
    pub skill_count: usize,
    pub command_count: usize,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SkillKind {
    Command,
    Skill,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    /// `<plugin>:<name>`, also the Claude slash command (without the slash).
    pub id: String,
    pub pack: String,
    pub kind: SkillKind,
    pub name: String,
    pub description: String,
    pub argument_hint: Option<String>,
    pub path: String,
}

/// A workspace role ("coworker"): `agents/<name>.md` in a pack, standard Claude sub-agent markdown
/// plus Orbit's `agent` / `readonly` / `skills` extensions.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    /// `<plugin>:<file stem>`.
    pub id: String,
    pub pack: String,
    /// Display name: the file stem, title-cased ("Ticket writer").
    pub name: String,
    pub description: String,
    pub model: Option<String>,
    pub agent: Option<String>,
    pub readonly: bool,
    /// Skill ids pinned as chips for this role.
    pub skills: Vec<String>,
    /// Role instructions (the markdown body).
    pub instructions: String,
    pub path: String,
}

pub fn packs_dir(home: &Path) -> PathBuf {
    home.join("packs")
}

pub fn install_builtin(home: &Path) -> anyhow::Result<()> {
    let root = packs_dir(home).join(BUILTIN_PACK);
    for (rel, body) in SHIPKIT {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().expect("has parent"))?;
        std::fs::write(&p, body)?;
    }
    Ok(())
}

/// `https://github.com/affaan-m/everything-claude-code(.git)` -> `everything-claude-code`.
pub fn pack_name_from_url(url: &str) -> anyhow::Result<String> {
    let last = url.trim_end_matches('/').rsplit(['/', ':']).next().unwrap_or_default();
    let name = crate::git::slugify(last.trim_end_matches(".git"));
    if name == "task" || name == BUILTIN_PACK {
        return Err(anyhow!("can't derive a pack name from {url}"));
    }
    Ok(name)
}

pub fn install(home: &Path, url: &str) -> anyhow::Result<String> {
    let url = url.trim();
    if !(url.starts_with("https://") || url.starts_with("git@")) {
        return Err(anyhow!("pack URL must be https:// or git@"));
    }
    let name = pack_name_from_url(url)?;
    let dir = packs_dir(home).join(&name);
    if dir.exists() {
        return Err(anyhow!("pack `{name}` is already installed"));
    }
    std::fs::create_dir_all(packs_dir(home))?;
    crate::git::run(&packs_dir(home), &["clone", "--depth", "1", url, &name])?;
    Ok(name)
}

pub fn update(home: &Path, name: &str) -> anyhow::Result<()> {
    crate::git::run(&packs_dir(home).join(name), &["pull", "--ff-only"])?;
    Ok(())
}

pub fn remove(home: &Path, name: &str) -> anyhow::Result<()> {
    if name == BUILTIN_PACK || name.contains(['/', '\\', '.']) {
        return Err(anyhow!("can't remove pack `{name}`"));
    }
    let dir = packs_dir(home).join(name);
    std::fs::remove_dir_all(&dir).with_context(|| format!("remove {}", dir.display()))
}

fn plugin_name(dir: &Path) -> String {
    std::fs::read_to_string(dir.join(".claude-plugin/plugin.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v["name"].as_str().map(String::from))
        .unwrap_or_else(|| dir.file_name().unwrap_or_default().to_string_lossy().to_string())
}

fn plugin_description(dir: &Path) -> Option<String> {
    let s = std::fs::read_to_string(dir.join(".claude-plugin/plugin.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&s).ok()?;
    v["description"].as_str().map(String::from)
}

pub fn list_packs(home: &Path, disabled: &[String]) -> anyhow::Result<Vec<Pack>> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(packs_dir(home)) else { return Ok(out) };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let skills = scan(&dir, &plugin_name(&dir), &name);
        out.push(Pack {
            plugin: plugin_name(&dir),
            description: plugin_description(&dir),
            path: dir.display().to_string(),
            source: crate::git::run(&dir, &["remote", "get-url", "origin"]).ok(),
            builtin: name == BUILTIN_PACK,
            enabled: !disabled.contains(&name),
            skill_count: skills.iter().filter(|s| s.kind == SkillKind::Skill).count(),
            command_count: skills.iter().filter(|s| s.kind == SkillKind::Command).count(),
            name,
        });
    }
    // Builtin first, then alphabetical.
    out.sort_by(|a, b| b.builtin.cmp(&a.builtin).then(a.name.cmp(&b.name)));
    Ok(out)
}

pub fn list_skills(packs: &[Pack]) -> Vec<Skill> {
    packs
        .iter()
        .filter(|p| p.enabled)
        .flat_map(|p| scan(Path::new(&p.path), &p.plugin, &p.name))
        .collect()
}

pub fn list_profiles(packs: &[Pack]) -> Vec<Profile> {
    packs
        .iter()
        .filter(|p| p.enabled)
        .flat_map(|p| scan_profiles(Path::new(&p.path), &p.plugin, &p.name))
        .collect()
}

fn scan_profiles(dir: &Path, plugin: &str, pack: &str) -> Vec<Profile> {
    let Ok(entries) = std::fs::read_dir(dir.join("agents")) else { return vec![] };
    let mut out: Vec<Profile> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "md"))
        .filter_map(|p| read_profile(&p, plugin, pack))
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// Drops a trailing ` # comment` from a scalar.
fn strip_comment(v: &str) -> &str {
    v.split(" #").next().unwrap_or(v).trim()
}

fn read_profile(path: &Path, plugin: &str, pack: &str) -> Option<Profile> {
    let text = std::fs::read_to_string(path).ok()?;
    let (fm, body) = parse_frontmatter(&text);
    let stem = path.file_stem()?.to_string_lossy().to_string();
    let field = |k: &str| fm.get(k).map(|v| strip_comment(v).to_string()).filter(|v| !v.is_empty());
    let mut name = stem.replace(['-', '_'], " ");
    if let Some(first) = name.chars().next() {
        name = first.to_uppercase().collect::<String>() + &name[first.len_utf8()..];
    }
    Some(Profile {
        id: format!("{plugin}:{stem}"),
        pack: pack.to_string(),
        name,
        description: fm.get("description").cloned().unwrap_or_default(),
        model: field("model"),
        agent: field("agent").map(|a| a.to_lowercase()),
        readonly: field("readonly").is_some_and(|v| v.eq_ignore_ascii_case("true")),
        // Comma-separated, or a YAML block list that the parser folded into `- a - b`.
        skills: field("skills")
            .map(|v| {
                v.split([',', ' '])
                    .map(|s| s.trim().trim_matches(['[', ']', '"', '\'']))
                    .filter(|s| !s.is_empty() && *s != "-")
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default(),
        instructions: body.trim().to_string(),
        path: path.display().to_string(),
    })
}

fn scan(dir: &Path, plugin: &str, pack: &str) -> Vec<Skill> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir.join("commands")) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().is_some_and(|x| x == "md") {
                let name = p.file_stem().unwrap_or_default().to_string_lossy().to_string();
                if let Some(s) = read_skill(&p, SkillKind::Command, name, plugin, pack) {
                    out.push(s);
                }
            }
        }
    }
    if let Ok(entries) = std::fs::read_dir(dir.join("skills")) {
        for e in entries.flatten() {
            let p = e.path().join("SKILL.md");
            if p.is_file() {
                let name = e.file_name().to_string_lossy().to_string();
                if let Some(s) = read_skill(&p, SkillKind::Skill, name, plugin, pack) {
                    out.push(s);
                }
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// `name` is the folder (skills) or file stem (commands): that's what Claude registers as
/// `/<plugin>:<name>`, even when the frontmatter `name` differs.
fn read_skill(path: &Path, kind: SkillKind, name: String, plugin: &str, pack: &str) -> Option<Skill> {
    let text = std::fs::read_to_string(path).ok()?;
    let (fm, _) = parse_frontmatter(&text);
    Some(Skill {
        id: format!("{plugin}:{name}"),
        pack: pack.to_string(),
        kind,
        description: fm.get("description").cloned().unwrap_or_default(),
        argument_hint: fm.get("argument-hint").cloned(),
        path: path.display().to_string(),
        name,
    })
}

/// Minimal YAML-frontmatter reader: top-level `key: value` pairs, quoted values, and
/// folded/literal blocks (`>`, `|`). Nested maps are skipped. Returns (fields, body).
pub fn parse_frontmatter(text: &str) -> (HashMap<String, String>, &str) {
    let mut fields = HashMap::new();
    let text = text.trim_start_matches('\u{feff}');
    let Some(rest) = text.strip_prefix("---").and_then(|r| r.strip_prefix('\n').or_else(|| r.strip_prefix("\r\n")))
    else {
        return (fields, text);
    };
    let (head, body) = match rest.find("\n---") {
        Some(i) => {
            let after = &rest[i + 4..];
            (&rest[..i], after.split_once('\n').map(|x| x.1).unwrap_or(""))
        }
        None => return (fields, text),
    };

    let lines: Vec<&str> = head.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i].trim_end_matches('\r');
        i += 1;
        if line.starts_with([' ', '\t', '#']) || line.trim().is_empty() {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else { continue };
        let value = value.trim();
        let value = if value.starts_with('>') || value.starts_with('|') || value.is_empty() {
            // Block scalar (or nested map): gather indented continuation lines.
            let mut parts = Vec::new();
            while i < lines.len() && (lines[i].starts_with([' ', '\t']) || lines[i].trim().is_empty()) {
                parts.push(lines[i].trim());
                i += 1;
            }
            if value.is_empty() && parts.iter().any(|p| p.contains(": ")) {
                continue; // nested map, e.g. `metadata:` — not needed
            }
            parts.join(if value.starts_with('|') { "\n" } else { " " }).trim().to_string()
        } else {
            unquote(value)
        };
        fields.insert(key.trim().to_string(), value);
    }
    (fields, body)
}

fn unquote(v: &str) -> String {
    let v = v.trim();
    if v.len() >= 2 && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\''))) {
        v[1..v.len() - 1].replace("\\\"", "\"").replace("''", "'")
    } else {
        v.to_string()
    }
}

/// Text sent to agents that can't run the skill natively (Codex).
pub fn expand(skill: &Skill, args: &str) -> anyhow::Result<String> {
    let text = std::fs::read_to_string(&skill.path)?;
    let (_, body) = parse_frontmatter(&text);
    let body = body.trim();
    Ok(match skill.kind {
        SkillKind::Command => {
            let positional: Vec<&str> = args.split_whitespace().collect();
            let mut out = body.replace("$ARGUMENTS", args);
            for (n, a) in positional.iter().enumerate().take(9).rev() {
                out = out.replace(&format!("${}", n + 1), a);
            }
            if !body.contains("$ARGUMENTS") && !args.trim().is_empty() {
                out.push_str(&format!("\n\nARGUMENTS: {args}"));
            }
            out
        }
        SkillKind::Skill => {
            let dir = Path::new(&skill.path).parent().map(|p| p.display().to_string()).unwrap_or_default();
            let task = if args.trim().is_empty() { "Apply this skill to the current task." } else { args };
            format!(
                "Use the `{}` skill below. Its supporting files live in `{dir}`.\n\n<skill name=\"{}\">\n{body}\n</skill>\n\n{task}",
                skill.name, skill.name
            )
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_variants() {
        let (fm, body) = parse_frontmatter(
            "---\nname: agentic-engineering\ndescription: \"Quoted: value\"\nargument-hint: [msg]\nmetadata:\n  origin: ECC\nlong: >\n  folded\n  text\n---\n\n# Body\n",
        );
        assert_eq!(fm["name"], "agentic-engineering");
        assert_eq!(fm["description"], "Quoted: value");
        assert_eq!(fm["argument-hint"], "[msg]");
        assert_eq!(fm["long"], "folded text");
        assert!(!fm.contains_key("metadata"));
        assert_eq!(body.trim(), "# Body");
    }

    #[test]
    fn builtin_profiles() {
        let home = std::env::temp_dir().join(format!("orbit_profiles_{}", std::process::id()));
        install_builtin(&home).unwrap();
        let profiles = list_profiles(&list_packs(&home, &[]).unwrap());
        let ids: Vec<&str> = profiles.iter().map(|p| p.id.as_str()).collect();
        for id in ["builder", "debugger", "planner", "reviewer", "shipper", "ticket-writer"] {
            assert!(ids.contains(&format!("shipkit:{id}").as_str()), "missing {id}");
        }
        let get = |id: &str| profiles.iter().find(|p| p.id == id).unwrap();
        assert!(get("shipkit:planner").readonly && !get("shipkit:builder").readonly);
        assert!(get("shipkit:ticket-writer").readonly);
        assert_eq!(get("shipkit:ticket-writer").name, "Ticket writer");
        assert_eq!(get("shipkit:ticket-writer").skills, vec!["shipkit:write-ticket"]);
        assert_eq!(get("shipkit:reviewer").agent.as_deref(), Some("codex"));
        assert_eq!(get("shipkit:shipper").skills.len(), 5);
        assert!(profiles.iter().all(|p| !p.description.is_empty() && !p.instructions.is_empty()));
        assert!(list_profiles(&list_packs(&home, &["shipkit".into()]).unwrap()).is_empty());
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn profile_frontmatter_forms() {
        let dir = std::env::temp_dir().join(format!("orbit_profile_fm_{}", std::process::id()));
        std::fs::create_dir_all(dir.join("agents")).unwrap();
        let p = dir.join("agents/qa_bot.md");
        std::fs::write(&p, "---\nname: x\ndescription: d\nmodel: opus   # note\nreadonly: true\nskills:\n  - a:one\n  - b:two\n---\nBody\n").unwrap();
        let pr = read_profile(&p, "t", "t").unwrap();
        assert_eq!((pr.id.as_str(), pr.name.as_str(), pr.model.as_deref()), ("t:qa_bot", "Qa bot", Some("opus")));
        assert!(pr.readonly);
        assert_eq!(pr.skills, vec!["a:one", "b:two"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn frontmatter_absent_and_crlf() {
        let (fm, body) = parse_frontmatter("just text");
        assert!(fm.is_empty());
        assert_eq!(body, "just text");
        let (fm, body) = parse_frontmatter("---\r\ndescription: x\r\n---\r\nbody");
        assert_eq!(fm["description"], "x");
        assert_eq!(body, "body");
    }

    #[test]
    fn pack_names() {
        assert_eq!(pack_name_from_url("https://github.com/affaan-m/everything-claude-code").unwrap(), "everything-claude-code");
        assert_eq!(pack_name_from_url("git@github.com:me/My_Pack.git").unwrap(), "my-pack");
        assert!(pack_name_from_url("https://github.com/x/shipkit").is_err());
    }

    #[test]
    fn builtin_pack_scans_and_expands() {
        let home = std::env::temp_dir().join(format!("orbit_skills_{}", std::process::id()));
        install_builtin(&home).unwrap();
        let packs = list_packs(&home, &[]).unwrap();
        assert_eq!(packs[0].name, "shipkit");
        assert_eq!(packs[0].plugin, "shipkit");
        let skills = list_skills(&packs);
        let ship = skills.iter().find(|s| s.id == "shipkit:ship").expect("ship command");
        assert_eq!(ship.kind, SkillKind::Command);
        assert!(!ship.description.is_empty());
        for pin in DEFAULT_PINS {
            assert!(skills.iter().any(|s| s.id == *pin), "missing pin {pin}");
        }
        let ticket = skills.iter().find(|s| s.id == "shipkit:write-ticket").unwrap();
        assert!(expand(ticket, "login button broken on safari").unwrap().contains("login button broken on safari"));
        assert!(list_skills(&list_packs(&home, &["shipkit".into()]).unwrap()).is_empty());
        let _ = std::fs::remove_dir_all(home);
    }

    /// Indexes a real installed pack tree: `PACKS_HOME=<dir containing packs/> cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn index_real_packs() {
        let home = PathBuf::from(std::env::var("PACKS_HOME").expect("PACKS_HOME"));
        for pack in list_packs(&home, &[]).unwrap() {
            let skills = list_skills(std::slice::from_ref(&pack));
            let undescribed: Vec<_> = skills.iter().filter(|s| s.description.is_empty()).map(|s| &s.id).collect();
            eprintln!(
                "{} (/{}:…): {} skills, {} commands, {} without description {:?}",
                pack.name, pack.plugin, pack.skill_count, pack.command_count, undescribed.len(), undescribed
            );
            assert!(skills.iter().all(|s| s.id.starts_with(&format!("{}:", pack.plugin))));
            assert!(undescribed.len() * 20 <= skills.len(), "too many skills missing descriptions");
        }
    }

    #[test]
    fn expand_skill_inlines_body() {
        let dir = std::env::temp_dir().join(format!("orbit_skill_{}", std::process::id()));
        std::fs::create_dir_all(dir.join("skills/greeter")).unwrap();
        let p = dir.join("skills/greeter/SKILL.md");
        std::fs::write(&p, "---\nname: other-name\ndescription: d\n---\nSay HOWDY.\n").unwrap();
        let s = read_skill(&p, SkillKind::Skill, "greeter".into(), "t", "t").unwrap();
        assert_eq!(s.id, "t:greeter", "folder name wins, matching Claude");
        let out = expand(&s, "greet me").unwrap();
        assert!(out.contains("Say HOWDY.") && out.ends_with("greet me") && !out.contains("description: d"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
