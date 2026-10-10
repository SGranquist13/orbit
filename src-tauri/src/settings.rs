//! Typed app settings, persisted as one JSON blob under the `settings` table key `app_settings`.
//! The pre-existing standalone keys (`branch_prefix`, `disabled_packs`, `pinned_skills`) keep working:
//! packs and pins are still read from their own keys, and a legacy `branch_prefix` seeds the blob
//! the first time the blob has no prefix of its own.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const KEY: &str = "app_settings";
pub const LEGACY_BRANCH_PREFIX_KEY: &str = "branch_prefix";

pub const PERMISSION_MODES: &[&str] = &["bypassPermissions", "acceptEdits"];
pub const SANDBOXES: &[&str] = &["danger-full-access", "workspace-write"];
pub const MERGE_METHODS: &[&str] = &["squash", "merge", "rebase"];
pub const SUGGESTION_MODELS: &[&str] = &["haiku", "sonnet"];
pub const AGENTS: &[&str] = &["claude", "codex"];
pub const CHECKS_MODES: &[&str] = &["off", "warn", "block"];
pub const SYNC_MODES: &[&str] = &["off", "suggest", "auto"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    // general
    pub branch_prefix: String,
    pub default_agent: String,
    pub default_model_claude: String,
    pub default_model_codex: String,
    pub notifications: bool,
    pub notify_only_unfocused: bool,
    // agents
    pub claude_permission_mode: String,
    pub codex_sandbox: String,
    pub extra_models_claude: Vec<String>,
    pub extra_models_codex: Vec<String>,
    // github
    pub merge_method: String,
    pub delete_branch_on_merge: bool,
    // inbox
    pub ai_suggestions: bool,
    pub suggestion_model: String,
    // git handling (trunk.rs)
    /// Commit the worktree after each agent turn as a `wip:` save point.
    pub save_commits: bool,
    /// Squash Orbit's unpushed `wip:` commits before Ship.
    pub squash_wip: bool,
    /// off | warn (inbox only, Ship proceeds) | block (Ship refused, "Ship anyway" in the inbox).
    pub checks_mode: String,
    /// off | suggest (record how far behind, inbox only) | auto (rebase idle, clean workspaces).
    pub sync_mode: String,
    pub sync_interval_minutes: u32,
    /// Inbox "stale" thresholds; 0 disables that test.
    pub stale_days: u32,
    pub stale_behind: u32,
    pub archive_on_merge: bool,
    pub delete_local_branch: bool,
    // mobile bridge
    pub remote_enabled: bool,
    pub remote_port: u16,
    pub remote_push: bool,
    // routines
    pub routine_concurrency: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            branch_prefix: default_branch_prefix(),
            default_agent: "claude".into(),
            default_model_claude: String::new(),
            default_model_codex: String::new(),
            notifications: true,
            notify_only_unfocused: true,
            claude_permission_mode: "bypassPermissions".into(),
            codex_sandbox: "danger-full-access".into(),
            extra_models_claude: vec![],
            extra_models_codex: vec![],
            merge_method: "squash".into(),
            delete_branch_on_merge: false,
            ai_suggestions: true,
            suggestion_model: "haiku".into(),
            save_commits: true,
            squash_wip: true,
            checks_mode: "block".into(),
            sync_mode: "auto".into(),
            sync_interval_minutes: 10,
            stale_days: 3,
            stale_behind: 20,
            archive_on_merge: true,
            delete_local_branch: true,
            remote_enabled: false,
            remote_port: crate::remote::server::DEFAULT_PORT,
            remote_push: true,
            routine_concurrency: 2,
        }
    }
}

/// `<username>/`, or empty when the OS user name is unusable.
pub fn default_branch_prefix() -> String {
    let user = std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_default();
    let user = crate::git::slugify(&user);
    if user == "task" { String::new() } else { format!("{user}/") }
}

/// Keeps a prefix a valid ref fragment: path-ish characters only, ending in `/` unless empty.
pub fn normalize_prefix(raw: &str) -> String {
    let cleaned: String = raw
        .trim()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_') { c } else { '-' })
        .collect();
    let cleaned = cleaned.trim_matches(|c| c == '/' || c == '-').to_string();
    let cleaned = cleaned.split('/').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("/");
    if cleaned.is_empty() { String::new() } else { format!("{cleaned}/") }
}

fn normalize_models(list: &[String]) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for m in list {
        let m = m.trim().to_string();
        if !m.is_empty() && !m.contains(char::is_whitespace) && !out.contains(&m) {
            out.push(m);
        }
    }
    out
}

fn check(field: &str, value: &str, allowed: &[&str]) -> Result<(), String> {
    if allowed.contains(&value) {
        Ok(())
    } else {
        Err(format!("invalid {field} \"{value}\" (expected one of: {})", allowed.join(", ")))
    }
}

impl Settings {
    /// Rejects unknown enum values and tidies free-form fields.
    pub fn validated(mut self) -> Result<Self, String> {
        check("claudePermissionMode", &self.claude_permission_mode, PERMISSION_MODES)?;
        check("codexSandbox", &self.codex_sandbox, SANDBOXES)?;
        check("mergeMethod", &self.merge_method, MERGE_METHODS)?;
        check("suggestionModel", &self.suggestion_model, SUGGESTION_MODELS)?;
        check("defaultAgent", &self.default_agent, AGENTS)?;
        check("checksMode", &self.checks_mode, CHECKS_MODES)?;
        check("syncMode", &self.sync_mode, SYNC_MODES)?;
        if !(1..=1440).contains(&self.sync_interval_minutes) {
            return Err(format!("invalid syncIntervalMinutes {} (expected 1-1440)", self.sync_interval_minutes));
        }
        if self.remote_port < 1024 {
            return Err(format!("invalid remotePort {} (expected 1024-65535)", self.remote_port));
        }
        if !(1..=8).contains(&self.routine_concurrency) {
            return Err(format!("invalid routineConcurrency {} (expected 1-8)", self.routine_concurrency));
        }
        self.branch_prefix = normalize_prefix(&self.branch_prefix);
        self.extra_models_claude = normalize_models(&self.extra_models_claude);
        self.extra_models_codex = normalize_models(&self.extra_models_codex);
        self.default_model_claude = self.default_model_claude.trim().to_string();
        self.default_model_codex = self.default_model_codex.trim().to_string();
        Ok(self)
    }

    /// Reads the blob (falling back to defaults when absent or corrupt). `legacy_prefix` is the old
    /// standalone `branch_prefix` key, used only if the blob doesn't carry a prefix itself.
    pub fn load(blob: Option<&str>, legacy_prefix: Option<&str>) -> Self {
        let value: Value = blob.and_then(|b| serde_json::from_str(b).ok()).unwrap_or(Value::Null);
        let mut s: Settings = serde_json::from_value(value.clone()).unwrap_or_default();
        if value.get("branchPrefix").is_none() {
            if let Some(p) = legacy_prefix {
                s.branch_prefix = p.to_string();
            }
        }
        s.validated().unwrap_or_default()
    }

    /// Shallow-merges `patch` (camelCase keys) over the current values and validates the result.
    pub fn patched(&self, patch: &Value) -> Result<Self, String> {
        let Some(patch) = patch.as_object() else { return Err("settings patch must be an object".into()) };
        let mut base = serde_json::to_value(self).map_err(|e| e.to_string())?;
        let map = base.as_object_mut().expect("settings serialize to an object");
        for (k, v) in patch {
            map.insert(k.clone(), v.clone());
        }
        serde_json::from_value::<Settings>(base).map_err(|e| format!("invalid settings: {e}"))?.validated()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_match_previous_hardcoded_behaviour() {
        let s = Settings::default();
        assert_eq!(s.claude_permission_mode, "bypassPermissions");
        assert_eq!(s.codex_sandbox, "danger-full-access");
        assert_eq!(s.merge_method, "squash");
        assert!(s.notifications && s.notify_only_unfocused && s.ai_suggestions && !s.delete_branch_on_merge);
        assert_eq!(s.suggestion_model, "haiku");
        assert_eq!(s.default_agent, "claude");
        // An empty blob deserializes to the same defaults.
        assert_eq!(Settings::load(Some("{}"), None), s);
        assert_eq!(Settings::load(None, None), s);
        assert_eq!(Settings::load(Some("garbage"), None), s);
    }

    #[test]
    fn patch_merges_and_keeps_other_fields() {
        let s = Settings::default().patched(&json!({ "mergeMethod": "rebase", "notifications": false })).unwrap();
        assert_eq!(s.merge_method, "rebase");
        assert!(!s.notifications);
        assert_eq!(s.codex_sandbox, "danger-full-access");
        let s = s.patched(&json!({ "extraModelsClaude": [" opus-x ", "opus-x", "", "a b"] })).unwrap();
        assert_eq!(s.extra_models_claude, ["opus-x"]);
        assert_eq!(s.merge_method, "rebase");
    }

    #[test]
    fn validation_rejects_bad_enums_and_types() {
        let d = Settings::default();
        assert!(d.patched(&json!({ "claudePermissionMode": "yolo" })).is_err());
        assert!(d.patched(&json!({ "codexSandbox": "read-only" })).is_err());
        assert!(d.patched(&json!({ "mergeMethod": "fast-forward" })).is_err());
        assert!(d.patched(&json!({ "suggestionModel": "opus" })).is_err());
        assert!(d.patched(&json!({ "defaultAgent": "gemini" })).is_err());
        assert!(d.patched(&json!({ "notifications": "yes" })).is_err());
        assert!(d.patched(&json!("nope")).is_err());
        assert!(d.patched(&json!({ "remotePort": 80 })).is_err());
        assert!(d.patched(&json!({ "remotePort": 70000 })).is_err());
        assert_eq!(d.patched(&json!({ "remotePort": 50000, "remoteEnabled": true })).unwrap().remote_port, 50000);
        assert!(!d.remote_enabled && d.remote_push && d.remote_port == 47821);
        // Unknown keys are ignored rather than stored.
        assert!(d.patched(&json!({ "bogus": 1 })).is_ok());
    }

    #[test]
    fn git_settings_defaults_and_validation() {
        let d = Settings::default();
        assert!(d.save_commits && d.squash_wip && d.archive_on_merge && d.delete_local_branch);
        assert_eq!((d.checks_mode.as_str(), d.sync_mode.as_str()), ("block", "auto"));
        assert_eq!((d.sync_interval_minutes, d.stale_days, d.stale_behind), (10, 3, 20));
        let s = d.patched(&json!({ "checksMode": "warn", "syncMode": "suggest", "staleDays": 0 })).unwrap();
        assert_eq!((s.checks_mode.as_str(), s.sync_mode.as_str(), s.stale_days), ("warn", "suggest", 0));
        assert!(d.patched(&json!({ "checksMode": "maybe" })).is_err());
        assert!(d.patched(&json!({ "syncMode": "always" })).is_err());
        assert!(d.patched(&json!({ "syncIntervalMinutes": 0 })).is_err());
        assert!(d.patched(&json!({ "staleBehind": -1 })).is_err());
    }

    #[test]
    fn prefix_is_normalized() {
        assert_eq!(normalize_prefix("steven"), "steven/");
        assert_eq!(normalize_prefix(" feat/ "), "feat/");
        assert_eq!(normalize_prefix("a b//c"), "a-b/c/");
        assert_eq!(normalize_prefix("  "), "");
        assert_eq!(normalize_prefix("/"), "");
    }

    #[test]
    fn legacy_branch_prefix_is_honoured_until_blob_has_one() {
        let s = Settings::load(None, Some("old/"));
        assert_eq!(s.branch_prefix, "old/");
        // Blob without a prefix still falls back to the legacy key, other fields intact.
        let s = Settings::load(Some(r#"{"mergeMethod":"merge"}"#), Some("old/"));
        assert_eq!((s.branch_prefix.as_str(), s.merge_method.as_str()), ("old/", "merge"));
        // Once the blob has its own prefix (even empty), the legacy key is ignored.
        let s = Settings::load(Some(r#"{"branchPrefix":""}"#), Some("old/"));
        assert_eq!(s.branch_prefix, "");
    }
}
