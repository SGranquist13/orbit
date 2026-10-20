//! Token/cost aggregation over persisted `Usage` events. Pure functions over event rows, so the
//! maths is unit-tested without a database.

use crate::agent::{AgentEvent, RateLimits};
use chrono::{Duration, Local, TimeZone};
use serde::Serialize;
use std::collections::BTreeMap;

/// Account-wide snapshots, independent of workspaces. Owned by AppState and loaded at startup.
#[derive(Default)]
pub struct RateLimitStore {
    latest: Vec<RateLimits>,
}

impl RateLimitStore {
    pub fn load(db: &crate::db::Db) -> Self {
        let latest = db.setting("rate_limits").ok().flatten()
            .and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        Self { latest }
    }

    pub fn snapshots(&self) -> Vec<RateLimits> {
        self.latest.clone()
    }

    /// Rolling updates can omit windows; preserve the last known values for those windows.
    /// Persist before publishing the new in-memory snapshot, so a failed write can be retried.
    pub fn update(&mut self, db: &crate::db::Db, limits: &RateLimits) -> anyhow::Result<Option<RateLimits>> {
        let mut next = self.latest.clone();
        if let Some(old) = next.iter_mut().find(|l| l.agent == limits.agent) {
            for window in &limits.windows {
                if let Some(existing) = old.windows.iter_mut().find(|w| w.kind == window.kind) {
                    *existing = window.clone();
                } else {
                    old.windows.push(window.clone());
                }
            }
            if limits.status.is_some() {
                old.status = limits.status.clone();
            }
        } else {
            next.push(limits.clone());
        }
        if next == self.latest {
            return Ok(None);
        }
        db.set_setting("rate_limits", &serde_json::to_string(&next)?)?;
        self.latest = next;
        Ok(self.latest.iter().find(|l| l.agent == limits.agent).cloned())
    }
}

/// One persisted `Usage` or `SessionReset` event.
pub struct Row {
    pub workspace_id: String,
    pub ts: i64,
    pub event: AgentEvent,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub cost_usd: f64,
    pub turns: u64,
}

impl Totals {
    fn add(&mut self, ev: &AgentEvent) {
        if let AgentEvent::Usage { input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, .. } = ev {
            self.input_tokens += input_tokens;
            self.output_tokens += output_tokens;
            self.cache_read_tokens += cache_read_tokens;
            self.cache_write_tokens += cache_write_tokens;
            self.cost_usd += cost_usd.unwrap_or(0.0);
            self.turns += 1;
        }
    }

    /// Tokens the work actually added: input + output + cache writes. Cache reads are excluded:
    /// every API call re-reads the whole cached conversation, so counting them makes a short turn
    /// look like hundreds of thousands of tokens. They stay available separately.
    pub fn tokens(&self) -> u64 {
        self.input_tokens + self.output_tokens + self.cache_write_tokens
    }
}

/// One workspace: lifetime totals, totals since the last "New session", and the live context.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceUsage {
    pub workspace_id: String,
    pub total: Totals,
    pub session: Totals,
    pub context_tokens: Option<u64>,
    pub context_window: Option<u64>,
    pub model: Option<String>,
}

/// Rows must be in seq order.
pub fn workspace_usage(workspace_id: &str, rows: &[&Row]) -> WorkspaceUsage {
    let mut u = WorkspaceUsage { workspace_id: workspace_id.to_string(), ..Default::default() };
    for r in rows {
        match &r.event {
            AgentEvent::Usage { context_tokens, context_window, model, .. } => {
                u.total.add(&r.event);
                u.session.add(&r.event);
                // A turn that can't tell its context size leaves the last known value.
                u.context_tokens = context_tokens.or(u.context_tokens);
                u.context_window = context_window.or(u.context_window);
                u.model = model.clone().or(u.model.take());
            }
            AgentEvent::SessionReset => {
                u.session = Totals::default();
                u.context_tokens = None;
            }
            _ => {}
        }
    }
    u
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRow {
    pub workspace_id: String,
    pub name: String,
    pub agent: String,
    pub total: Totals,
    pub context_tokens: Option<u64>,
    pub context_window: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRow {
    pub agent: String,
    pub total: Totals,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DayRow {
    /// Local date, `YYYY-MM-DD`.
    pub day: String,
    pub tokens: u64,
    pub cost_usd: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub totals: Totals,
    pub by_workspace: Vec<WorkspaceRow>,
    pub by_agent: Vec<AgentRow>,
    /// The last 14 days (oldest first, zero-filled), regardless of `since_ms`.
    pub by_day: Vec<DayRow>,
}

pub struct WorkspaceInfo {
    pub id: String,
    pub name: String,
    pub agent: String,
}

fn local_day(ts_ms: i64) -> String {
    Local.timestamp_millis_opt(ts_ms).single().unwrap_or_else(Local::now).format("%Y-%m-%d").to_string()
}

/// `rows` in seq order across all workspaces; `now_ms` is injected for tests.
pub fn report(rows: &[Row], workspaces: &[WorkspaceInfo], since_ms: Option<i64>, now_ms: i64) -> Report {
    let since = since_ms.unwrap_or(i64::MIN);
    let mut totals = Totals::default();
    let mut by_workspace = Vec::new();
    let mut agents: BTreeMap<&str, Totals> = BTreeMap::new();
    for ws in workspaces {
        let all: Vec<&Row> = rows.iter().filter(|r| r.workspace_id == ws.id).collect();
        let mut t = Totals::default();
        for r in all.iter().filter(|r| r.ts >= since) {
            t.add(&r.event);
        }
        if t.turns == 0 {
            continue;
        }
        let live = workspace_usage(&ws.id, &all);
        totals.input_tokens += t.input_tokens;
        totals.output_tokens += t.output_tokens;
        totals.cache_read_tokens += t.cache_read_tokens;
        totals.cache_write_tokens += t.cache_write_tokens;
        totals.cost_usd += t.cost_usd;
        totals.turns += t.turns;
        let a = agents.entry(ws.agent.as_str()).or_default();
        a.input_tokens += t.input_tokens;
        a.output_tokens += t.output_tokens;
        a.cache_read_tokens += t.cache_read_tokens;
        a.cache_write_tokens += t.cache_write_tokens;
        a.cost_usd += t.cost_usd;
        a.turns += t.turns;
        by_workspace.push(WorkspaceRow {
            workspace_id: ws.id.clone(),
            name: ws.name.clone(),
            agent: ws.agent.clone(),
            total: t,
            context_tokens: live.context_tokens,
            context_window: live.context_window,
        });
    }
    by_workspace.sort_by_key(|w| std::cmp::Reverse(w.total.tokens()));
    let mut by_agent: Vec<AgentRow> = agents.into_iter().map(|(agent, total)| AgentRow { agent: agent.into(), total }).collect();
    by_agent.sort_by_key(|a| std::cmp::Reverse(a.total.tokens()));

    let mut days: Vec<DayRow> = (0..14)
        .rev()
        .map(|i| DayRow { day: local_day(now_ms - Duration::days(i).num_milliseconds()), tokens: 0, cost_usd: 0.0 })
        .collect();
    for r in rows {
        if let AgentEvent::Usage { .. } = &r.event {
            let mut t = Totals::default();
            t.add(&r.event);
            let day = local_day(r.ts);
            if let Some(d) = days.iter_mut().find(|d| d.day == day) {
                d.tokens += t.tokens();
                d.cost_usd += t.cost_usd;
            }
        }
    }
    Report { totals, by_workspace, by_agent, by_day: days }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_limits_are_global_deduplicated_and_survive_reload() {
        use crate::agent::{AgentKind, LimitWindow};
        let db = crate::db::Db::memory();
        let mut store = RateLimitStore::load(&db);
        assert!(store.snapshots().is_empty());
        let mut claude = RateLimits {
            agent: AgentKind::Claude,
            windows: vec![
                LimitWindow { kind: "fiveHour".into(), used_percent: 62.0, resets_at: Some(123) },
                LimitWindow { kind: "weekly".into(), used_percent: 31.0, resets_at: None },
            ],
            status: Some("allowed".into()),
        };
        assert_eq!(store.update(&db, &claude).unwrap(), Some(claude.clone()));
        assert_eq!(store.update(&db, &claude).unwrap(), None);
        let codex = RateLimits { agent: AgentKind::Codex, windows: vec![
            LimitWindow { kind: "fiveHour".into(), used_percent: 88.0, resets_at: None },
        ], status: None };
        store.update(&db, &codex).unwrap();
        let patch = RateLimits { agent: AgentKind::Claude, windows: vec![
            LimitWindow { kind: "weekly".into(), used_percent: 32.0, resets_at: None },
        ], status: None };
        claude.windows[1].used_percent = 32.0;
        assert_eq!(store.update(&db, &patch).unwrap(), Some(claude.clone()));
        assert_eq!(store.update(&db, &patch).unwrap(), None);
        let restored = RateLimitStore::load(&db).snapshots();
        assert_eq!(restored, vec![claude, codex]);
        let ev = AgentEvent::RateLimits(restored[0].clone());
        assert!(!ev.is_persistent());
        let json = serde_json::to_value(&ev).unwrap();
        assert_eq!(json["type"], "rateLimits");
        assert_eq!(json["agent"], "claude");
        assert_eq!(json["windows"][0]["usedPercent"], 62.0);
        assert_eq!(json["windows"][0]["resetsAt"], 123);
        assert_eq!(serde_json::from_value::<AgentEvent>(json).unwrap(), ev);
    }

    fn usage(ctx: Option<u64>, input: u64, cost: Option<f64>) -> AgentEvent {
        AgentEvent::Usage {
            input_tokens: input,
            output_tokens: 10,
            cache_read_tokens: 100,
            cache_write_tokens: 5,
            context_tokens: ctx,
            context_window: Some(1000),
            cost_usd: cost,
            model: Some("m".into()),
        }
    }

    fn row(ws: &str, ts: i64, event: AgentEvent) -> Row {
        Row { workspace_id: ws.into(), ts, event }
    }

    #[test]
    fn workspace_totals_session_and_context() {
        let rows = [
            row("a", 1, usage(Some(300), 50, Some(0.5))),
            row("a", 2, usage(None, 50, Some(0.25))),
            row("a", 3, AgentEvent::SessionReset),
            row("a", 4, usage(Some(40), 5, None)),
        ];
        let refs: Vec<&Row> = rows.iter().collect();
        let u = workspace_usage("a", &refs);
        assert_eq!((u.total.turns, u.total.input_tokens, u.total.cost_usd), (3, 105, 0.75));
        // Session counters restart at the reset.
        assert_eq!((u.session.turns, u.session.input_tokens), (1, 5));
        assert_eq!((u.context_tokens, u.context_window), (Some(40), Some(1000)));
        // Reset with no later usage clears the context.
        let u = workspace_usage("a", &refs[..3]);
        assert_eq!(u.context_tokens, None);
        // Unknown context keeps the previous value.
        let u = workspace_usage("a", &refs[..2]);
        assert_eq!(u.context_tokens, Some(300));
    }

    #[test]
    fn report_groups_by_workspace_agent_and_day() {
        let now = Local.with_ymd_and_hms(2026, 10, 9, 12, 0, 0).unwrap().timestamp_millis();
        let day = Duration::days(1).num_milliseconds();
        let rows = [
            row("a", now - 20 * day, usage(Some(1), 1, Some(1.0))),
            row("a", now - day, usage(Some(200), 40, Some(0.5))),
            row("b", now, usage(Some(900), 10, None)),
        ];
        let ws = [
            WorkspaceInfo { id: "a".into(), name: "alpha".into(), agent: "claude".into() },
            WorkspaceInfo { id: "b".into(), name: "beta".into(), agent: "codex".into() },
            WorkspaceInfo { id: "c".into(), name: "idle".into(), agent: "claude".into() },
        ];
        let r = report(&rows, &ws, None, now);
        assert_eq!(r.totals.turns, 3);
        assert_eq!(r.by_workspace.len(), 2); // idle workspace omitted
        assert_eq!(r.by_workspace[0].name, "alpha");
        assert_eq!(r.by_agent.iter().map(|a| a.agent.as_str()).collect::<Vec<_>>(), ["claude", "codex"]);
        // Window filter drops the old turn from totals but not from the 14-day chart's range.
        let r7 = report(&rows, &ws, Some(now - 7 * day), now);
        assert_eq!(r7.totals.turns, 2);
        assert_eq!(r7.by_day.len(), 14);
        assert_eq!(r7.by_day[13].tokens, 10 + 10 + 5); // cache reads (100) excluded
        assert_eq!(r7.by_day[12].cost_usd, 0.5);
        assert_eq!(r7.by_day.iter().map(|d| d.tokens).sum::<u64>(), 55 + 25);
    }
}
