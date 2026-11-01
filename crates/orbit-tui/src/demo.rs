//! `orb --demo`: an in-memory fake of the desktop app. Eight workspaces covering every rail and
//! inbox state, realistic transcripts, the seven shipkit skills, a review with diffs, a ship flow
//! that ends in a mergeable PR, and scripted streaming turns when you send a message.

use crate::backend::Backend;
use async_trait::async_trait;
use orbit_proto::{
    AgentEvent, AgentModels, Agents, CheckResult, Commit, EventPush, FileAt, FileChange, Hello, HelloSettings,
    MergeOutcome, PrChecks, PrStatus, PrepareShip, Profile, Push, Repo, Review, Scope, Skill, Snapshot, Status,
    StoredEvent, Summary, Workspace,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::Instant;

const MIN: i64 = 60_000;

// ---------------------------------------------------------------------------------------------
// state

struct DemoReview {
    /// (path, old text, new text, commit index)
    files: Vec<(String, String, String, usize)>,
    commits: Vec<Commit>,
}

#[derive(Default)]
struct State {
    repos: Vec<Repo>,
    workspaces: Vec<Workspace>,
    events: HashMap<String, Vec<StoredEvent>>,
    prs: HashMap<String, PrStatus>,
    reviews: HashMap<String, DemoReview>,
    /// Bumped to cancel a running script.
    generation: HashMap<String, u64>,
}

impl State {
    fn ws_mut(&mut self, id: &str) -> Option<&mut Workspace> {
        self.workspaces.iter_mut().find(|w| w.id == id)
    }
    fn summary(&self, id: &str) -> Summary {
        let evs = self.events.get(id).map(Vec::as_slice).unwrap_or(&[]);
        let mut s = Summary { workspace_id: id.into(), ..Default::default() };
        for e in evs {
            s.last_seq = e.seq;
            s.last_activity_ts = e.ts;
            match &e.event {
                AgentEvent::TurnCompleted { is_error, error, interrupted, .. } => {
                    s.last_turn_seq = e.seq;
                    s.last_turn_error = is_error.then(|| error.clone().unwrap_or_else(|| "Turn failed".into()));
                    s.last_turn_interrupted = *interrupted;
                }
                AgentEvent::Message { text } => s.last_assistant_text = Some(text.clone()),
                AgentEvent::UserMessage { text, .. } => s.last_user_text = Some(text.clone()),
                _ => {}
            }
        }
        s
    }
    fn last_seq(&self, id: &str) -> i64 {
        self.events.get(id).and_then(|e| e.last()).map(|e| e.seq).unwrap_or(0)
    }
}

/// Builds a workspace's event log with increasing seqs and timestamps.
struct Log {
    events: Vec<StoredEvent>,
    ts: i64,
}

impl Log {
    fn new(start: i64) -> Log {
        Log { events: vec![], ts: start }
    }
    fn at(&mut self, ms: i64) -> &mut Log {
        self.ts += ms;
        self
    }
    fn ev(&mut self, event: AgentEvent) -> &mut Log {
        let seq = self.events.len() as i64 + 1;
        self.events.push(StoredEvent { commit_sha: None, seq, ts: self.ts, event });
        self.ts += 1500;
        self
    }
    fn user(&mut self, text: &str) -> &mut Log {
        self.ev(user(text, None)).ev(AgentEvent::TurnStarted)
    }
    fn say(&mut self, text: &str) -> &mut Log {
        self.ev(AgentEvent::Message { text: text.into() })
    }
    fn tool(&mut self, id: &str, name: &str, input: Value, output: Option<&str>) -> &mut Log {
        self.ev(AgentEvent::ToolCall { id: id.into(), name: name.into(), input });
        if let Some(o) = output {
            self.ev(AgentEvent::ToolResult { id: id.into(), output: o.into(), is_error: false });
        }
        self
    }
    fn done(&mut self, secs: u64, tokens: u64, ctx: u64) -> &mut Log {
        self.ev(usage(tokens, ctx)).ev(AgentEvent::TurnCompleted {
            duration_ms: Some(secs * 1000),
            cost_usd: Some(tokens as f64 / 400_000.0),
            is_error: false,
            error: None,
            interrupted: false,
        })
    }
}

fn user(text: &str, skill: Option<&str>) -> AgentEvent {
    AgentEvent::UserMessage { text: text.into(), skill: skill.map(Into::into), images: vec![], files: vec![] }
}

fn usage(tokens: u64, ctx: u64) -> AgentEvent {
    AgentEvent::Usage {
        input_tokens: tokens * 7 / 10,
        output_tokens: tokens / 5,
        cache_read_tokens: tokens * 3,
        cache_write_tokens: tokens / 10,
        context_tokens: Some(ctx),
        context_window: Some(200_000),
        cost_usd: None,
        model: None,
    }
}

#[allow(clippy::too_many_arguments)]
fn workspace(
    id: &str,
    repo: &str,
    name: &str,
    branch: &str,
    agent: &str,
    model: &str,
    status: Status,
    created: i64,
) -> Workspace {
    Workspace {
        id: id.into(),
        repo_id: repo.into(),
        name: name.into(),
        branch: branch.into(),
        path: format!("~/.orbit/worktrees/{repo}/{name}"),
        agent: agent.into(),
        model: Some(model.into()),
        status,
        created_at: created,
        updated_at: created,
        ..Default::default()
    }
}

fn edit(path: &str, old: &str, new: &str) -> Value {
    json!({ "file_path": path, "old_string": old, "new_string": new })
}

const LOGIN_TEST_OLD: &str = r##"import { describe, it, expect } from "bun:test";
import { page, user } from "./fixtures";
import { session } from "./session";

describe("login", () => {
  it("signs in", async () => {
    await page.goto("/login");
    await page.fill("#email", user.email);
    await page.fill("#password", user.password);
    await page.click("#submit");
    expect(await session()).toBeTruthy();
  });

  it("rejects a wrong password", async () => {
    await page.goto("/login");
    await page.fill("#email", user.email);
    await page.fill("#password", "nope");
    await page.click("#submit");
    expect(await page.text(".error")).toContain("Wrong password");
  });
});
"##;

const LOGIN_TEST_NEW: &str = r##"import { describe, it, expect } from "bun:test";
import { page, user } from "./fixtures";
import { session } from "./session";
import { cookie } from "./cookie";

describe("login", () => {
  it("signs in", async () => {
    await page.goto("/login");
    await page.fill("#email", user.email);
    await page.fill("#password", user.password);
    await page.click("#submit");
    await cookie.wait("session");
    expect(await session()).toBeTruthy();
  });

  it("rejects a wrong password", async () => {
    await page.goto("/login");
    await page.fill("#email", user.email);
    await page.fill("#password", "nope");
    await page.click("#submit");
    expect(await page.text(".error")).toContain("Wrong password");
  });
});
"##;

const SESSION_OLD: &str = r##"import { store } from "../lib/store";

export type Session = { user: string; expires: number };

export async function session(): Promise<Session | null> {
  return store.get("session");
}

export function clearSession() {
  store.delete("session");
}
"##;

const SESSION_NEW: &str = r##"import { store } from "../lib/store";
import { cookie } from "./cookie";

export type Session = { user: string; expires: number };

export async function session(): Promise<Session | null> {
  const c = await cookie.wait("session", 2000);
  return c ?? store.get("session");
}

export function clearSession() {
  store.delete("session");
  cookie.clear("session");
}
"##;

const COOKIE_NEW: &str = r##"/** Waits for a cookie the server sets after a redirect, instead of racing it. */
export const cookie = {
  async wait(name: string, timeoutMs = 5000): Promise<string | null> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const hit = document.cookie.split("; ").find((c) => c.startsWith(`${name}=`));
      if (hit) return hit.slice(name.length + 1);
      await new Promise((r) => setTimeout(r, 25));
    }
    return null;
  },
  clear(name: string) {
    document.cookie = `${name}=; Max-Age=0; path=/`;
  },
};
"##;

const README_OLD: &str = r##"# Orbit Web

The marketing site and docs for Orbit.

## Develop

```sh
bun install
bun run dev
```

## Deploy

Pushes to `main` deploy to production.
"##;

const README_NEW: &str = r##"# Orbit Web

[![CI](https://github.com/orbit/web/actions/workflows/ci.yml/badge.svg)](https://github.com/orbit/web/actions/workflows/ci.yml)

The marketing site and docs for Orbit.

## Develop

```sh
bun install
bun run dev
```

## Check

```sh
bun run check
```

## Deploy

Pushes to `main` deploy to production.
"##;

const CI_NEW: &str = r##"name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run check
"##;

const HOME_OLD: &str = r##"export function Hero() {
  return (
    <section className="hero">
      <h1>The IDE for agents</h1>
      <p className="lede">Orbit runs Claude Code and Codex side by side.</p>
      <a className="cta" href="/download">Download</a>
    </section>
  );
}
"##;

const HOME_NEW: &str = r##"export function Hero() {
  return (
    <section className="hero">
      <h1>Run a fleet of coding agents. Ship what they build.</h1>
      <p className="lede">Orbit runs Claude Code and Codex side by side.</p>
      <a className="cta" href="/download">Download</a>
    </section>
  );
}
"##;

fn seed(base: i64) -> State {
    let mut st = State {
        repos: vec![
            Repo {
                id: "r-web".into(),
                name: "orbit-web".into(),
                path: "~/code/orbit-web".into(),
                base_branch: "main".into(),
            },
            Repo {
                id: "r-api".into(),
                name: "orbit-api".into(),
                path: "~/code/orbit-api".into(),
                base_branch: "main".into(),
            },
        ],
        ..Default::default()
    };
    let day = 24 * 60 * MIN;

    // 1. Asked you a question.
    let mut l = Log::new(base - 9 * MIN);
    l.user("Rewrite the landing page headline so it says what Orbit does in one line.")
        .say("I'll find the hero component first.")
        .tool("rc1", "Grep", json!({"pattern":"<h1>"}), Some("src/pages/Home.tsx:5"))
        .tool("rc2", "Read", json!({"file_path":"src/pages/Home.tsx"}), Some(HOME_OLD))
        .tool(
            "rc3",
            "Edit",
            edit("src/pages/Home.tsx", "<h1>The IDE for agents</h1>", "<h1>Run a fleet of coding agents. Ship what they build.</h1>"),
            Some("ok"),
        )
        .say("Changed the headline to **Run a fleet of coding agents. Ship what they build.** It fits on one line down to 360px.\n\nThe old line, *The IDE for agents*, still reads well. Keep the old headline as a subtitle?")
        .done(41, 18_400, 31_200);
    let mut w = workspace(
        "w-copy",
        "r-web",
        "review-copy",
        "copy/landing-headline",
        "claude",
        "sonnet",
        Status::Done,
        base - day,
    );
    w.seen_seq = 2;
    w.ahead = 1;
    st.events.insert(w.id.clone(), l.events.clone());
    st.workspaces.push(w);
    st.reviews.insert(
        "w-copy".into(),
        DemoReview {
            files: vec![("src/pages/Home.tsx".into(), HOME_OLD.into(), HOME_NEW.into(), 0)],
            commits: vec![Commit {
                sha: "c41d9e2f".into(),
                subject: "wip: rewrite hero headline".into(),
                ts: base - 3 * MIN,
            }],
        },
    );

    // 2. PR checks failing.
    let mut l = Log::new(base - 3 * 60 * MIN);
    l.user("Add Node 22 to the CI test matrix.")
        .tool("cn1", "Read", json!({"path":".github/workflows/test.yml"}), Some("matrix: node: [18, 20]"))
        .tool("cn2", "Edit", json!({"files":[".github/workflows/test.yml"]}), Some("ok"))
        .say("Added `22` to the matrix next to 18 and 20.")
        .done(22, 6_100, 12_800);
    l.at(20 * MIN)
        .ev(user("/shipkit:ship", Some("shipkit:ship")))
        .ev(AgentEvent::TurnStarted)
        .tool("cn3", "Bash", json!({"command":"git push -u origin ci/node-22"}), Some("ok"))
        .tool("cn4", "Bash", json!({"command":"gh pr create --draft --title \"CI: test on Node 22\""}), Some("#38"))
        .say("Opened draft PR #38, *CI: test on Node 22*.")
        .done(31, 4_900, 15_100);
    let mut w =
        workspace("w-ci", "r-web", "ci-node-22", "ci/node-22", "codex", "gpt-6.1-sol", Status::Done, base - 2 * day);
    w.seen_seq = l.events.len() as i64;
    w.ahead = 2;
    st.events.insert(w.id.clone(), l.events.clone());
    st.workspaces.push(w);
    st.prs.insert(
        "w-ci".into(),
        PrStatus {
            number: 38,
            title: "CI: test on Node 22".into(),
            url: "https://github.com/orbit/web/pull/38".into(),
            state: "OPEN".into(),
            is_draft: false,
            mergeable: "MERGEABLE".into(),
            review_decision: "REVIEW_REQUIRED".into(),
            checks: PrChecks { passed: 3, failed: 1, pending: 0, failing: vec!["test (node 22)".into()] },
        },
    );

    // 3. Running: the login flake.
    let mut l = Log::new(base - 16 * MIN);
    l.user("make the login test stop flaking")
        .say("I'll look at the test and its fixtures first.")
        .tool("fl1", "Grep", json!({"pattern":"session\\(\\)"}), Some("12 matches"))
        .tool("fl2", "Read", json!({"file_path":"src/auth/login.test.ts"}), Some(LOGIN_TEST_OLD))
        .tool("fl3", "Read", json!({"file_path":"src/auth/session.ts"}), Some(SESSION_OLD))
        .say("The test asserts on `session()` right after the click, but the server sets the session cookie after a redirect. On a slow run the assertion wins the race.")
        .tool("fl4", "Write", json!({"file_path":"src/auth/cookie.ts","content":COOKIE_NEW}), Some("ok"))
        .tool("fl5", "Edit", edit("src/auth/session.ts", "  return store.get(\"session\");", "  const c = await cookie.wait(\"session\", 2000);\n  return c ?? store.get(\"session\");"), Some("ok"))
        .tool("fl6", "Edit", edit("src/auth/login.test.ts", "    await page.click(\"#submit\");", "    await page.click(\"#submit\");\n    await cookie.wait(\"session\");"), Some("ok"))
        .say("The test now waits for the cookie instead of racing it. Running the auth tests 20 times to be sure.");
    let start = l.ts;
    l.ev(usage(9_800, 41_200));
    l.ts = start;
    l.tool("fl7", "Bash", json!({"command":"for i in $(seq 20); do bun test src/auth || exit 1; done"}), None);
    let mut w = workspace(
        "w-login",
        "r-web",
        "fix-login",
        "fix/login-flake",
        "claude",
        "sonnet",
        Status::Running,
        base - 40 * MIN,
    );
    w.seen_seq = l.events.len() as i64;
    w.ahead = 2;
    // The turn started 12 minutes ago... keep it visible as "thinking · 3m".
    st.events.insert(w.id.clone(), l.events.clone());
    st.workspaces.push(w);
    st.reviews.insert(
        "w-login".into(),
        DemoReview {
            files: vec![
                ("src/auth/login.test.ts".into(), LOGIN_TEST_OLD.into(), LOGIN_TEST_NEW.into(), 0),
                ("src/auth/session.ts".into(), SESSION_OLD.into(), SESSION_NEW.into(), 1),
                ("src/auth/cookie.ts".into(), String::new(), COOKIE_NEW.into(), 1),
            ],
            commits: vec![
                Commit {
                    sha: "a1f3c9e7".into(),
                    subject: "wip: wait for the session cookie in the test".into(),
                    ts: base - 2 * MIN,
                },
                Commit { sha: "7be20d41".into(), subject: "wip: add cookie.wait helper".into(), ts: base - 5 * MIN },
            ],
        },
    );

    // 4. Running: Codex tidying imports.
    let mut l = Log::new(base - 6 * MIN);
    l.user("Sort and dedupe the imports across src/components, no behaviour changes.")
        .tool("ti1", "Bash", json!({"command":"rg -l '^import' src/components | wc -l"}), Some("38"))
        .say("38 files. I'll go through them in order and keep type-only imports separate.")
        .tool("ti2", "Edit", json!({"files":["src/components/Button.tsx","src/components/Card.tsx"]}), Some("ok"))
        .tool("ti3", "Edit", json!({"files":["src/components/Header.tsx","src/components/Footer.tsx"]}), Some("ok"));
    l.tool("ti4", "Edit", json!({"files":["src/components/Nav.tsx"]}), None);
    let w = workspace(
        "w-tidy",
        "r-web",
        "tidy-imports",
        "chore/tidy-imports",
        "codex",
        "gpt-6-luna",
        Status::Running,
        base - 7 * MIN,
    );
    let mut w = w;
    w.seen_seq = l.events.len() as i64;
    st.events.insert(w.id.clone(), l.events.clone());
    st.workspaces.push(w);

    // 5. Failed turn.
    let mut l = Log::new(base - 48 * MIN);
    l.user("Retry 429 responses from the GitHub API with exponential backoff.")
        .tool("ar1", "Grep", json!({"pattern":"fetch\\(`\\$\\{GITHUB"}), Some("src/github/client.ts:31"))
        .tool("ar2", "Read", json!({"file_path":"src/github/client.ts"}), Some("…"))
        .ev(AgentEvent::TurnCompleted {
            duration_ms: Some(64_000),
            cost_usd: None,
            is_error: true,
            error: Some("API Error: 529 overloaded\nThe model is overloaded right now.\nTry again in a moment.".into()),
            interrupted: false,
        });
    let mut w = workspace(
        "w-retry",
        "r-api",
        "api-retry",
        "fix/api-retry",
        "claude",
        "opus",
        Status::Error,
        base - 3 * 60 * MIN,
    );
    w.seen_seq = 1;
    st.events.insert(w.id.clone(), l.events.clone());
    st.workspaces.push(w);

    // 6. Needs sync.
    let mut l = Log::new(base - 26 * MIN);
    l.user("Bump the minor versions of our dependencies and fix anything that breaks.")
        .tool("bd1", "Bash", json!({"command":"bun update"}), Some("12 packages updated"))
        .tool("bd2", "Bash", json!({"command":"bun run check"}), Some("ok"))
        .say("Updated 12 packages; `bun run check` passes.")
        .done(95, 12_300, 22_000);
    let mut w =
        workspace("w-deps", "r-api", "bump-deps", "chore/bump-deps", "claude", "sonnet", Status::Done, base - 2 * day);
    w.seen_seq = l.events.len() as i64;
    w.sync_conflicts = vec!["package.json".into(), "bun.lock".into()];
    w.behind = 4;
    w.ahead = 1;
    st.events.insert(w.id.clone(), l.events.clone());
    st.workspaces.push(w);

    // 7. Finished, ready to ship.
    let mut l = Log::new(base - 4 * MIN);
    l.user("Add a CI badge to the README and document `bun run check`.")
        .tool("rb1", "Read", json!({"file_path":"README.md"}), Some(README_OLD))
        .tool("rb2", "Glob", json!({"pattern":".github/workflows/*.yml"}), Some("none"))
        .tool("rb3", "Write", json!({"file_path":".github/workflows/ci.yml","content":CI_NEW}), Some("ok"))
        .tool("rb4", "Edit", edit("README.md", "The marketing site", "[![CI](…/badge.svg)](…)\n\nThe marketing site"), Some("ok"))
        .tool("rb5", "Edit", edit("README.md", "## Deploy", "## Check\n\n```sh\nbun run check\n```\n\n## Deploy"), Some("ok"))
        .say("Added the badge under the title and a **Check** section. There was no CI workflow yet, so I added `ci.yml`:\n\n```yaml\n- run: bun install --frozen-lockfile\n- run: bun run check\n```\n\nReady to ship.")
        .done(38, 12_400, 24_900);
    let mut w = workspace(
        "w-badge",
        "r-web",
        "readme-badge",
        "docs/readme-badge",
        "claude",
        "haiku",
        Status::Done,
        base - 30 * MIN,
    );
    w.seen_seq = 2;
    w.ahead = 3;
    st.events.insert(w.id.clone(), l.events.clone());
    st.workspaces.push(w);
    st.reviews.insert(
        "w-badge".into(),
        DemoReview {
            files: vec![
                ("README.md".into(), README_OLD.into(), README_NEW.into(), 0),
                (".github/workflows/ci.yml".into(), String::new(), CI_NEW.into(), 1),
            ],
            commits: vec![
                Commit { sha: "e2b7a019".into(), subject: "wip: document bun run check".into(), ts: base - MIN },
                Commit { sha: "93cd1f60".into(), subject: "wip: add CI workflow and badge".into(), ts: base - 2 * MIN },
            ],
        },
    );

    // 8. Merged.
    let mut l = Log::new(base - 5 * 60 * MIN);
    l.user("Add a dark mode toggle to the docs header.")
        .tool("dm1", "Edit", json!({"file_path":"src/components/Header.tsx","old_string":"<Nav />","new_string":"<Nav />\n<ThemeToggle />"}), Some("ok"))
        .say("Added the toggle; it follows the system setting until you pick one.")
        .done(52, 9_200, 18_000)
        .ev(user("/shipkit:ship", Some("shipkit:ship")))
        .ev(AgentEvent::TurnStarted)
        .tool("dm2", "Bash", json!({"command":"gh pr create --title \"Docs: dark mode toggle\""}), Some("#41"))
        .say("Opened PR #41.")
        .done(24, 3_100, 19_500);
    let mut w =
        workspace("w-dark", "r-web", "dark-mode", "feat/dark-mode", "claude", "sonnet", Status::Done, base - 3 * day);
    w.seen_seq = l.events.len() as i64;
    w.issue_number = Some(12);
    st.events.insert(w.id.clone(), l.events.clone());
    st.workspaces.push(w);
    st.prs.insert(
        "w-dark".into(),
        PrStatus {
            number: 41,
            title: "Docs: dark mode toggle".into(),
            url: "https://github.com/orbit/web/pull/41".into(),
            state: "MERGED".into(),
            mergeable: "UNKNOWN".into(),
            review_decision: "APPROVED".into(),
            checks: PrChecks { passed: 4, failed: 0, pending: 0, failing: vec![] },
            ..Default::default()
        },
    );

    for w in &mut st.workspaces {
        let last = st.events.get(&w.id).and_then(|e| e.last()).map(|e| e.ts).unwrap_or(w.created_at);
        w.updated_at = last;
    }
    st
}

pub fn profiles() -> Vec<Profile> {
    let p = |name: &str, title: &str, desc: &str, readonly: bool| Profile {
        id: format!("shipkit:{name}"),
        pack: "shipkit".into(),
        name: title.into(),
        description: desc.into(),
        readonly,
        path: format!("shipkit/agents/{name}.md"),
        ..Default::default()
    };
    vec![
        p(
            "builder",
            "Builder",
            "Default generalist. Implements the task end to end with tests and a short summary.",
            false,
        ),
        p(
            "debugger",
            "Debugger",
            "Reproduces the bug, finds the root cause, and makes the smallest correct fix with a regression test.",
            false,
        ),
        p(
            "planner",
            "Planner",
            "Read-only. Explores the code and writes an implementation plan; changes nothing.",
            true,
        ),
        p(
            "reviewer",
            "Reviewer",
            "Read-only adversarial pre-ship review by a second model. Findings ranked by severity.",
            true,
        ),
        p("shipper", "Shipper", "Gets the branch green, reviewed, and merged with minimal new code.", false),
        p(
            "ticket-writer",
            "Ticket writer",
            "Read-only. Turns rough notes into well-formed GitHub issues, checking the code first.",
            true,
        ),
    ]
}

pub fn skills() -> Vec<Skill> {
    let s = |name: &str, desc: &str, hint: Option<&str>| Skill {
        id: format!("shipkit:{name}"),
        pack: "shipkit".into(),
        kind: "command".into(),
        name: name.into(),
        description: desc.into(),
        argument_hint: hint.map(Into::into),
        path: format!("shipkit/commands/{name}.md"),
    };
    vec![
        s(
            "ship",
            "Commit everything, push the branch, and open (or update) a draft PR.",
            Some("[extra notes for the PR description]"),
        ),
        s(
            "fix-ci",
            "Find failing CI checks on this branch's PR, fix them, and push.",
            Some("[check name to focus on]"),
        ),
        s(
            "address-comments",
            "Address unresolved review comments on this branch's PR and push the fixes.",
            Some("[reviewer or topic]"),
        ),
        s(
            "preflight",
            "Pre-ship spot check of what this branch changes at its boundaries.",
            Some("[area to focus on]"),
        ),
        s("rebase", "Rebase this branch onto the latest base branch, resolve conflicts, and push.", None),
        s("start-issue", "Read the linked GitHub issue, plan, and implement it.", Some("[issue number]")),
        s("write-ticket", "Turn rough notes into a well-formed GitHub issue and file it.", Some("<rough notes>")),
    ]
}

// ---------------------------------------------------------------------------------------------
// scripts

type Hook = Box<dyn FnOnce(&Arc<Inner>) + Send>;

enum Step {
    Ev(AgentEvent),
    Delta(String),
    Wait(u64),
    Status(Status),
    Hook(Hook),
}

fn stream(text: &str, out: &mut Vec<Step>) {
    let words: Vec<&str> = text.split_inclusive(' ').collect();
    for chunk in words.chunks(3) {
        out.push(Step::Delta(chunk.concat()));
        out.push(Step::Wait(70));
    }
    out.push(Step::Ev(AgentEvent::Message { text: text.into() }));
    out.push(Step::Wait(250));
}

fn tool(out: &mut Vec<Step>, id: &str, name: &str, input: Value, output: &str, ms: u64) {
    out.push(Step::Ev(AgentEvent::ToolCall { id: id.into(), name: name.into(), input }));
    out.push(Step::Wait(ms));
    out.push(Step::Ev(AgentEvent::ToolResult { id: id.into(), output: output.into(), is_error: false }));
    out.push(Step::Wait(150));
}

fn finish(out: &mut Vec<Step>, secs: u64, tokens: u64, ctx: u64) {
    out.push(Step::Ev(usage(tokens, ctx)));
    out.push(Step::Ev(AgentEvent::TurnCompleted {
        duration_ms: Some(secs * 1000),
        cost_usd: Some(tokens as f64 / 400_000.0),
        is_error: false,
        error: None,
        interrupted: false,
    }));
    out.push(Step::Status(Status::Done));
}

fn begin(text: &str, skill: Option<&str>) -> Vec<Step> {
    vec![Step::Ev(user(text, skill)), Step::Status(Status::Running), Step::Ev(AgentEvent::TurnStarted), Step::Wait(600)]
}

/// A believable turn for any message.
fn reply_script(text: &str, branch: &str) -> Vec<Step> {
    let topic: String = text.split_whitespace().take(8).collect::<Vec<_>>().join(" ");
    let word = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() > 3)
        .max_by_key(|w| w.len())
        .unwrap_or("todo")
        .to_lowercase();
    let mut s = begin(text, None);
    stream(&format!("On it: {topic}. I'll find where that lives first."), &mut s);
    tool(&mut s, "d1", "Grep", json!({ "pattern": word }), "4 matches in 2 files", 700);
    tool(&mut s, "d2", "Read", json!({ "file_path": format!("src/{word}.ts") }), "…", 500);
    tool(
        &mut s,
        "d3",
        "Edit",
        edit(&format!("src/{word}.ts"), "const a = 1;\nconst b = 2;", "const a = 1;\nconst b = 3;\nexport { a, b };"),
        "ok",
        900,
    );
    tool(&mut s, "d4", "Bash", json!({ "command": "bun run check" }), "✓ 214 tests passed", 1800);
    stream(
        &format!(
            "Done. The change is in `src/{word}.ts` and `bun run check` passes.\n\n- Kept the public API the same\n- Committed a save point on `{branch}`\n\nWant me to ship it?"
        ),
        &mut s,
    );
    finish(&mut s, 9, 7_400, 33_000);
    s
}

fn skill_script(ws: &Workspace, skill: &str, args: &str) -> Vec<Step> {
    let text = if args.is_empty() { format!("/{skill}") } else { format!("/{skill} {args}") };
    let mut s = begin(&text, Some(skill));
    let id = ws.id.clone();
    match skill {
        "shipkit:ship" => {
            let title = match ws.name.as_str() {
                "readme-badge" => "Docs: CI badge and the check command".to_string(),
                n => format!("{}: {}", n, ws.branch),
            };
            tool(&mut s, "s1", "Bash", json!({"command":"git status --short"}), "", 400);
            tool(&mut s, "s2", "Bash", json!({"command": format!("git push -u origin {}", ws.branch)}), "ok", 1200);
            tool(
                &mut s,
                "s3",
                "Bash",
                json!({"command": format!("gh pr create --draft --title \"{title}\"")}),
                "https://github.com/orbit/web/pull/42",
                1500,
            );
            let t2 = title.clone();
            s.push(Step::Hook(Box::new(move |inner: &Arc<Inner>| {
                let pr = PrStatus {
                    number: 42,
                    title: t2,
                    url: "https://github.com/orbit/web/pull/42".into(),
                    state: "OPEN".into(),
                    is_draft: false,
                    mergeable: "MERGEABLE".into(),
                    review_decision: "REVIEW_REQUIRED".into(),
                    checks: PrChecks { passed: 0, failed: 0, pending: 3, failing: vec![] },
                };
                inner.st.lock().unwrap().prs.insert(id.clone(), pr);
                progress_checks(inner, id.clone());
            })));
            stream(&format!("Pushed `{}` and opened PR #42, *{title}*. CI is running.", ws.branch), &mut s);
            finish(&mut s, 6, 3_900, 26_000);
        }
        "shipkit:fix-ci" => {
            tool(&mut s, "f1", "Bash", json!({"command":"gh pr checks"}), "test (node 22)  fail", 900);
            tool(
                &mut s,
                "f2",
                "Bash",
                json!({"command":"gh run view --log-failed"}),
                "TypeError: fetch failed (undici)",
                1100,
            );
            tool(
                &mut s,
                "f3",
                "Edit",
                edit(
                    "test/setup.ts",
                    "globalThis.fetch = undici.fetch;",
                    "// Node 22 ships fetch; keep undici for 18.\nglobalThis.fetch ??= undici.fetch;",
                ),
                "ok",
                900,
            );
            tool(&mut s, "f4", "Bash", json!({"command":"bun run check && git push"}), "ok", 1600);
            s.push(Step::Hook(Box::new(move |inner: &Arc<Inner>| {
                if let Some(p) = inner.st.lock().unwrap().prs.get_mut(&id) {
                    p.checks = PrChecks { passed: 0, failed: 0, pending: 4, failing: vec![] };
                }
                progress_checks(inner, id.clone());
            })));
            stream("Node 22 has a global `fetch`, so the test setup's override broke it. It now only polyfills when missing. Pushed; CI is re-running.", &mut s);
            finish(&mut s, 7, 5_200, 29_000);
        }
        _ => {
            let short = skill.rsplit(':').next().unwrap_or(skill);
            tool(&mut s, "k1", "Bash", json!({"command":"git log --oneline origin/main..HEAD"}), "3 commits", 700);
            tool(&mut s, "k2", "Grep", json!({"pattern":"export function"}), "18 matches", 800);
            stream(&format!("Ran `{short}`. Nothing blocking: the change is contained to its own module and every caller still type-checks."), &mut s);
            finish(&mut s, 5, 4_100, 27_000);
        }
    }
    s
}

/// Continues the two running workspaces at startup.
fn continue_login() -> Vec<Step> {
    let mut s = vec![Step::Wait(4000)];
    s.push(Step::Ev(AgentEvent::ToolResult { id: "fl7".into(), output: "20/20 runs passed".into(), is_error: false }));
    s.push(Step::Wait(400));
    stream("All 20 runs pass. The flake was the cookie race: `session()` now waits up to 2s for the cookie, and the test waits for it explicitly.", &mut s);
    finish(&mut s, 14 * 60, 21_300, 47_800);
    s
}

fn continue_tidy() -> Vec<Step> {
    let mut s = vec![Step::Wait(2500)];
    s.push(Step::Ev(AgentEvent::ToolResult { id: "ti4".into(), output: "ok".into(), is_error: false }));
    for (i, f) in ["Sidebar.tsx", "Modal.tsx", "Toast.tsx", "Table.tsx"].iter().enumerate() {
        tool(&mut s, &format!("tx{i}"), "Edit", json!({"files":[format!("src/components/{f}")]}), "ok", 3500);
    }
    tool(&mut s, "tx9", "Bash", json!({"command":"bun run check"}), "ok", 4000);
    stream(
        "Sorted and deduped imports in 38 files; type-only imports are grouped last. `bun run check` passes.",
        &mut s,
    );
    finish(&mut s, 7 * 60, 15_800, 38_000);
    s
}

// ---------------------------------------------------------------------------------------------
// backend

/// PR checks go pending → passing, then the PR is approved.
fn progress_checks(inner: &Arc<Inner>, id: String) {
    let inner = inner.clone();
    tokio::spawn(async move {
        for i in 0..3u32 {
            tokio::time::sleep(Duration::from_millis(2500)).await;
            let mut st = inner.st.lock().unwrap();
            if let Some(p) = st.prs.get_mut(&id) {
                let total = p.checks.passed + p.checks.pending;
                p.checks.passed = (p.checks.passed + 1 + i).min(total);
                p.checks.pending = total - p.checks.passed;
                if p.checks.pending == 0 {
                    p.review_decision = "APPROVED".into();
                }
            }
        }
    });
}

pub struct Inner {
    st: Mutex<State>,
    tx: mpsc::Sender<Push>,
    rx: Mutex<Option<mpsc::Receiver<Push>>>,
    base: i64,
    t0: Instant,
    live: bool,
}

#[derive(Clone)]
pub struct DemoBackend {
    inner: Arc<Inner>,
}

impl Inner {
    fn now(&self) -> i64 {
        self.base + self.t0.elapsed().as_millis() as i64
    }

    fn push(&self, p: Push) {
        let _ = self.tx.try_send(p);
    }

    fn set_status(&self, id: &str, status: Status) {
        let now = self.now();
        let w = {
            let mut st = self.st.lock().unwrap();
            let Some(w) = st.ws_mut(id) else { return };
            w.status = status;
            w.updated_at = now;
            w.clone()
        };
        self.push(Push::Workspace(w));
    }

    fn persist(&self, id: &str, event: AgentEvent) {
        let now = self.now();
        let (seq, summary) = {
            let mut st = self.st.lock().unwrap();
            let evs = st.events.entry(id.to_string()).or_default();
            let seq = evs.last().map(|e| e.seq).unwrap_or(0) + 1;
            evs.push(StoredEvent { commit_sha: None, seq, ts: now, event: event.clone() });
            (seq, st.summary(id))
        };
        self.push(Push::Event(EventPush { workspace_id: id.into(), seq: Some(seq), ts: now, event }));
        self.push(Push::Summary(summary));
    }
}

impl DemoBackend {
    /// `live`: continue the running workspaces' turns in the background (the real demo);
    /// off for deterministic screen snapshots.
    pub fn new(now: i64, live: bool) -> DemoBackend {
        let (tx, rx) = mpsc::channel(4096);
        DemoBackend {
            inner: Arc::new(Inner {
                st: Mutex::new(seed(now)),
                tx,
                rx: Mutex::new(Some(rx)),
                base: now,
                t0: Instant::now(),
                live,
            }),
        }
    }

    fn run(&self, id: String, steps: Vec<Step>) {
        let inner = self.inner.clone();
        let gen = {
            let mut st = inner.st.lock().unwrap();
            let g = st.generation.entry(id.clone()).or_default();
            *g += 1;
            *g
        };
        tokio::spawn(async move {
            for step in steps {
                let current = inner.st.lock().unwrap().generation.get(&id).copied();
                if current != Some(gen) {
                    return;
                }
                match step {
                    Step::Wait(ms) => tokio::time::sleep(Duration::from_millis(ms)).await,
                    Step::Ev(e) => inner.persist(&id, e),
                    Step::Delta(t) => {
                        let now = inner.now();
                        inner.push(Push::Event(EventPush {
                            workspace_id: id.clone(),
                            seq: None,
                            ts: now,
                            event: AgentEvent::TextDelta { text: t },
                        }));
                    }
                    Step::Status(s) => inner.set_status(&id, s),
                    Step::Hook(h) => h(&inner),
                }
            }
        });
    }

    fn ws(&self, id: &str) -> Result<Workspace, String> {
        self.inner.st.lock().unwrap().workspaces.iter().find(|w| w.id == id).cloned().ok_or("unknown workspace".into())
    }

    fn review(&self, ws: &Workspace, scope: Scope) -> Result<Review, String> {
        let st = self.inner.st.lock().unwrap();
        let Some(r) = st.reviews.get(&ws.id) else {
            return Ok(Review {
                scope,
                old_ref: "0000000".into(),
                new_ref: "worktree".into(),
                files: vec![],
                commits: vec![],
                turn_available: false,
            });
        };
        let count = |old: &str, new: &str| {
            let d = similar::TextDiff::from_lines(old, new);
            let mut a = 0;
            let mut del = 0;
            for c in d.iter_all_changes() {
                match c.tag() {
                    similar::ChangeTag::Insert => a += 1,
                    similar::ChangeTag::Delete => del += 1,
                    _ => {}
                }
            }
            (a, del)
        };
        let pick: Vec<&(String, String, String, usize)> = match &scope {
            Scope::Base => r.files.iter().collect(),
            Scope::Turn => r.files.iter().filter(|f| f.3 == 0).collect(),
            Scope::Commit { sha } => {
                let i = r.commits.iter().position(|c| &c.sha == sha).ok_or(format!("unknown commit {sha}"))?;
                r.files.iter().filter(|f| f.3 == i).collect()
            }
        };
        let files = pick
            .iter()
            .map(|(p, o, n, _)| {
                let (a, d) = count(o, n);
                FileChange { path: p.clone(), additions: a, deletions: d, untracked: false }
            })
            .collect();
        let (old_ref, new_ref) = match &scope {
            Scope::Commit { sha } => (format!("{}0", &sha[..7]), sha.clone()),
            _ => ("4b1c2d0".into(), "worktree".into()),
        };
        Ok(Review { scope, old_ref, new_ref, files, commits: r.commits.clone(), turn_available: r.commits.len() > 1 })
    }

    async fn call(&self, method: &str, p: Value) -> Result<Value, String> {
        let wsid = p.get("workspaceId").and_then(Value::as_str).unwrap_or("").to_string();
        match method {
            "hello" => to(&Hello {
                settings: HelloSettings { stale_days: 7, stale_behind: 50, save_commits: true },
                version: "demo".into(),
                agents: Agents {
                    claude: AgentModels { models: vec!["sonnet".into(), "opus".into(), "haiku".into()] },
                    codex: AgentModels {
                        models: vec!["gpt-6.1-sol".into(), "gpt-6-luna".into(), "gpt-6-astra".into()],
                    },
                },
            }),
            "listProfiles" => to(&profiles()),
            "createWorkspace" => {
                let repo = p.get("repoId").and_then(Value::as_str).unwrap_or("").to_string();
                let task = p.get("task").and_then(Value::as_str).unwrap_or("").trim().to_string();
                let name = p.get("name").and_then(Value::as_str).unwrap_or("");
                let agent = p.get("agent").and_then(Value::as_str).unwrap_or("claude").to_string();
                let model = p.get("model").and_then(Value::as_str).map(str::to_string);
                let profile = p.get("profile").and_then(Value::as_str).map(str::to_string);
                let ws = {
                    let mut st = self.inner.st.lock().unwrap();
                    if !st.repos.iter().any(|r| r.id == repo) {
                        return Err("unknown repository".into());
                    }
                    // Slugify and dedupe like the app.
                    let base: String = name
                        .to_lowercase()
                        .chars()
                        .map(|c| if c.is_alphanumeric() { c } else { '-' })
                        .collect::<String>()
                        .split('-')
                        .filter(|s| !s.is_empty())
                        .take(5)
                        .collect::<Vec<_>>()
                        .join("-");
                    let base = if base.is_empty() { "workspace".to_string() } else { base };
                    let mut slug = base.clone();
                    let mut n = 2;
                    while st.workspaces.iter().any(|w| w.name == slug) {
                        slug = format!("{base}-{n}");
                        n += 1;
                    }
                    let now = self.inner.now();
                    let mut w = workspace(
                        &format!("w-{slug}"),
                        &repo,
                        &slug,
                        &format!("orbit/{slug}"),
                        &agent,
                        model.as_deref().unwrap_or(if agent == "codex" { "gpt-6.1-sol" } else { "sonnet" }),
                        Status::Idle,
                        now,
                    );
                    w.profile = profile;
                    st.workspaces.push(w.clone());
                    st.events.insert(w.id.clone(), vec![]);
                    w
                };
                self.inner.push(Push::Workspace(ws.clone()));
                if !task.is_empty() {
                    let steps = reply_script(&task, &ws.branch);
                    self.run(ws.id.clone(), steps);
                }
                to(&ws)
            }
            "archive" => {
                let ws = self.ws(&wsid)?;
                let force = p.get("force").and_then(Value::as_bool).unwrap_or(false);
                // The demo's "dirty" worktrees: anything with unpushed work that isn't merged.
                let merged = self.inner.st.lock().unwrap().prs.get(&wsid).is_some_and(|p| p.state == "MERGED");
                if !force && (ws.ahead > 0 || ws.status == Status::Running) && !merged {
                    return Err("Uncommitted changes: src/auth/session.ts, src/auth/cookie.ts".into());
                }
                *self.inner.st.lock().unwrap().generation.entry(wsid.clone()).or_default() += 1;
                {
                    let mut st = self.inner.st.lock().unwrap();
                    st.workspaces.retain(|w| w.id != wsid);
                    st.events.remove(&wsid);
                }
                self.inner.push(Push::WorkspaceRemoved(wsid));
                Ok(Value::Null)
            }
            "switchProfile" => {
                self.ws(&wsid)?;
                let profile = p.get("profile").and_then(Value::as_str).map(str::to_string);
                let w = {
                    let mut st = self.inner.st.lock().unwrap();
                    let w = st.ws_mut(&wsid).ok_or("unknown workspace")?;
                    w.profile = profile;
                    w.clone()
                };
                self.inner.push(Push::Workspace(w.clone()));
                to(&w)
            }
            "compact" => {
                self.ws(&wsid)?;
                self.inner.persist(&wsid, usage(1_200, 6_400));
                Ok(Value::Null)
            }
            "newSession" => {
                self.ws(&wsid)?;
                self.inner.persist(&wsid, AgentEvent::SessionReset);
                Ok(Value::Null)
            }
            "listFiles" => {
                self.ws(&wsid)?;
                to(&[
                    "README.md",
                    "src/auth/login.test.ts",
                    "src/auth/session.ts",
                    "src/auth/cookie.ts",
                    "src/pages/Home.tsx",
                ])
            }
            "snapshot" => {
                let st = self.inner.st.lock().unwrap();
                let summaries = st.workspaces.iter().map(|w| st.summary(&w.id)).collect();
                to(&Snapshot { repos: st.repos.clone(), workspaces: st.workspaces.clone(), summaries })
            }
            "events" => {
                self.ws(&wsid)?;
                let since = p.get("sinceSeq").and_then(Value::as_i64).unwrap_or(0);
                let st = self.inner.st.lock().unwrap();
                let evs: Vec<StoredEvent> = st
                    .events
                    .get(&wsid)
                    .map(|e| e.iter().filter(|e| e.seq > since).cloned().collect())
                    .unwrap_or_default();
                to(&evs)
            }
            "listSkills" => to(&skills()),
            "markSeen" | "dismiss" => {
                self.ws(&wsid)?;
                let mut st = self.inner.st.lock().unwrap();
                let last = st.last_seq(&wsid);
                let w = st.ws_mut(&wsid).ok_or("unknown workspace")?;
                if method == "markSeen" {
                    w.seen_seq = last;
                } else {
                    w.dismissed_seq = last;
                }
                Ok(json!(last))
            }
            "send" => {
                let ws = self.ws(&wsid)?;
                let text = p.get("text").and_then(Value::as_str).unwrap_or("").trim().to_string();
                if text.is_empty() {
                    return Err("Nothing to send".into());
                }
                if ws.status == Status::Running {
                    return Err("The demo agent is busy: wait for this turn (or esc to stop it)".into());
                }
                {
                    let mut st = self.inner.st.lock().unwrap();
                    if let Some(w) = st.ws_mut(&wsid) {
                        w.checks_failed = false;
                        w.sync_conflicts.clear();
                    }
                }
                self.run(wsid, reply_script(&text, &ws.branch));
                Ok(Value::Null)
            }
            "interrupt" => {
                let ws = self.ws(&wsid)?;
                if ws.status != Status::Running {
                    return Ok(Value::Null);
                }
                *self.inner.st.lock().unwrap().generation.entry(wsid.clone()).or_default() += 1;
                self.inner.persist(
                    &wsid,
                    AgentEvent::TurnCompleted {
                        duration_ms: None,
                        cost_usd: None,
                        is_error: false,
                        error: None,
                        interrupted: true,
                    },
                );
                self.inner.set_status(&wsid, Status::Idle);
                Ok(Value::Null)
            }
            "runSkill" => {
                let ws = self.ws(&wsid)?;
                if ws.status == Status::Running {
                    return Err("Wait for the current turn to finish first".into());
                }
                let skill = p.get("skillId").and_then(Value::as_str).unwrap_or("").to_string();
                let args = p.get("args").and_then(Value::as_str).unwrap_or("").to_string();
                if !skills().iter().any(|s| s.id == skill) {
                    return Err(format!("unknown skill {skill}"));
                }
                let steps = skill_script(&ws, &skill, &args);
                self.run(wsid, steps);
                Ok(Value::Null)
            }
            "prStatus" => {
                self.ws(&wsid)?;
                let st = self.inner.st.lock().unwrap();
                to(&st.prs.get(&wsid).cloned())
            }
            "ship" => {
                let ws = self.ws(&wsid)?;
                if ws.status == Status::Running {
                    return Err("Wait for the current turn to finish before shipping".into());
                }
                let skip = p.get("skipChecks").and_then(Value::as_bool).unwrap_or(false);
                if !skip {
                    tokio::time::sleep(Duration::from_millis(1600)).await;
                }
                let fails = ws.name == "ci-node-22" || ws.name == "bump-deps";
                if fails && !skip {
                    let out = "$ bun run check\n✓ lint\n✓ typecheck\n✗ test/github.test.ts > retries 429s\n  TypeError: fetch failed\n    at undici/index.js:112:13\n    at test/setup.ts:4:3\n\n213 pass, 1 fail";
                    let checks = CheckResult {
                        ok: false,
                        kind: "fail".into(),
                        command: "bun run check".into(),
                        output_tail: out.into(),
                        duration_ms: 14_200,
                    };
                    {
                        let mut st = self.inner.st.lock().unwrap();
                        if let Some(w) = st.ws_mut(&wsid) {
                            w.checks_failed = true;
                            w.checks_command = Some(checks.command.clone());
                            w.checks_output = Some(out.into());
                        }
                    }
                    return to(&PrepareShip { ok: false, checks: Some(checks), squashed: 0, notes: None });
                }
                let checks = (!skip).then(|| CheckResult {
                    ok: true,
                    kind: "pass".into(),
                    command: "bun run check".into(),
                    output_tail: "214 pass".into(),
                    duration_ms: 12_900,
                });
                let squashed = ws.ahead.max(0) as u32;
                let steps = skill_script(&ws, "shipkit:ship", "");
                self.run(wsid, steps);
                to(&PrepareShip { ok: true, checks, squashed, notes: None })
            }
            "merge" => {
                self.ws(&wsid)?;
                tokio::time::sleep(Duration::from_millis(900)).await;
                {
                    let mut st = self.inner.st.lock().unwrap();
                    let Some(pr) = st.prs.get_mut(&wsid) else { return Err("No pull request".into()) };
                    if pr.checks.failed > 0 {
                        return Err("Checks are failing".into());
                    }
                    pr.state = "MERGED".into();
                    if let Some(w) = st.ws_mut(&wsid) {
                        w.ahead = 0;
                    }
                }
                let w = self.ws(&wsid)?;
                self.inner.push(Push::Workspace(w));
                to(&MergeOutcome { archived: false })
            }
            "review" => {
                let ws = self.ws(&wsid)?;
                let scope: Scope = serde_json::from_value(p.get("scope").cloned().unwrap_or(json!({"kind":"base"})))
                    .map_err(|e| e.to_string())?;
                let r = self.review(&ws, scope)?;
                if matches!(r.scope, Scope::Turn) && !r.turn_available {
                    return Err("No turn to review: save points are off or no turn has been committed yet".into());
                }
                to(&r)
            }
            "fileAt" => {
                self.ws(&wsid)?;
                let path = p.get("path").and_then(Value::as_str).unwrap_or("");
                let rf = p.get("ref").and_then(Value::as_str).unwrap_or("");
                let st = self.inner.st.lock().unwrap();
                let r = st.reviews.get(&wsid).ok_or("no review")?;
                let f = r.files.iter().find(|f| f.0 == path);
                let is_new = rf == "worktree" || r.commits.iter().any(|c| c.sha == rf);
                let text =
                    f.map(|f| if is_new { f.2.clone() } else { f.1.clone() }).filter(|t| !t.is_empty() || is_new);
                to(&FileAt { text, binary: false, too_large: false })
            }
            "sendReview" => {
                let ws = self.ws(&wsid)?;
                let comments = p.get("comments").and_then(Value::as_array).cloned().unwrap_or_default();
                if comments.is_empty() {
                    return Err("No comments".into());
                }
                let mut msg = String::from("Review comments:\n");
                for c in &comments {
                    msg.push_str(&format!(
                        "\n- {}:{} {}",
                        c.get("path").and_then(Value::as_str).unwrap_or(""),
                        c.get("startLine").and_then(Value::as_i64).unwrap_or(0),
                        c.get("text").and_then(Value::as_str).unwrap_or("")
                    ));
                }
                let mut s = begin(&msg, None);
                stream(
                    &format!(
                        "Going through the {} comment{}.",
                        comments.len(),
                        if comments.len() == 1 { "" } else { "s" }
                    ),
                    &mut s,
                );
                tool(
                    &mut s,
                    "rv1",
                    "Edit",
                    edit(
                        "src/auth/session.ts",
                        "cookie.wait(\"session\", 2000)",
                        "waitFor(() => cookie.get(\"session\"), 2000)",
                    ),
                    "ok",
                    1200,
                );
                stream("Switched to the existing `waitFor` helper and removed the new API from `cookie.ts`.", &mut s);
                finish(&mut s, 6, 4_400, 44_000);
                self.run(ws.id, s);
                Ok(Value::Null)
            }
            other => Err(format!("unknown method {other}")),
        }
    }
}

fn to<T: serde::Serialize>(v: &T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

#[async_trait]
impl Backend for DemoBackend {
    async fn rpc(&self, method: &str, params: Value) -> Result<Value, String> {
        self.call(method, params).await
    }

    fn subscribe(&self) -> mpsc::Receiver<Push> {
        let rx = self.inner.rx.lock().unwrap().take().unwrap_or_else(|| mpsc::channel(1).1);
        if self.inner.live {
            self.run("w-login".into(), continue_login());
            self.run("w-tidy".into(), continue_tidy());
        }
        rx
    }
}
