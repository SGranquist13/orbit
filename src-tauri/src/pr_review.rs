//! GitHub pull request review and local workspace review.

use crate::{gh::Checks, AppState, CmdResult};
use anyhow::{anyhow, bail, ensure, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    io::Write,
    path::Path,
    process::{Command, Stdio},
    sync::{LazyLock, Mutex},
};
use tauri::State;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrRef {
    pub repo: String,
    pub number: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewQueueItem {
    pub repo: String,
    pub number: u64,
    pub title: String,
    pub url: String,
    pub author: String,
    pub updated_at: String,
    pub is_draft: bool,
    pub review_decision: String,
    pub sources: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrFile {
    pub path: String,
    pub previous_path: Option<String>,
    pub additions: u64,
    pub deletions: u64,
    pub status: String,
    pub viewed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrComment {
    pub id: u64,
    pub author: String,
    pub avatar_url: String,
    pub body: String,
    pub created_at: String,
    pub is_mine: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrThread {
    pub id: String,
    pub path: String,
    pub side: String,
    pub line: Option<u64>,
    pub start_line: Option<u64>,
    pub original_line: Option<u64>,
    pub is_resolved: bool,
    pub is_outdated: bool,
    pub can_resolve: bool,
    pub comments: Vec<PrComment>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrReviewSummary {
    pub id: String,
    pub author: String,
    pub avatar_url: String,
    pub state: String,
    pub body: String,
    pub submitted_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrTimelineComment {
    pub id: u64,
    pub author: String,
    pub avatar_url: String,
    pub body: String,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrDetail {
    pub id: String,
    pub repo: String,
    pub number: u64,
    pub title: String,
    pub body: String,
    pub url: String,
    pub author: String,
    pub author_avatar_url: String,
    pub state: String,
    pub is_draft: bool,
    pub viewer_login: String,
    pub viewer_did_author: bool,
    pub head_ref: String,
    pub base_ref: String,
    pub head_sha: String,
    pub merge_base_sha: String,
    pub review_decision: String,
    pub mergeable: String,
    pub checks: Checks,
    pub created_at: String,
    pub updated_at: String,
    pub files: Vec<PrFile>,
    pub threads: Vec<PrThread>,
    pub reviews: Vec<PrReviewSummary>,
    pub comments: Vec<PrTimelineComment>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPrComment {
    pub path: String,
    pub side: String,
    pub line: u64,
    pub start_line: Option<u64>,
    pub body: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalReview {
    pub workspace_id: String,
    pub root: String,
    pub base_sha: String,
    pub head_sha: String,
    pub dirty: bool,
    pub files: Vec<crate::git::FileChange>,
}

fn s(v: &Value, key: &str) -> String {
    v[key].as_str().unwrap_or_default().into()
}
fn b(v: &Value, key: &str) -> bool {
    v[key].as_bool().unwrap_or(false)
}
fn nodes(v: &Value) -> impl Iterator<Item = &Value> {
    v["nodes"].as_array().into_iter().flatten()
}
fn author(v: &Value) -> String {
    v["author"]["login"].as_str().unwrap_or("ghost").into()
}
fn avatar(v: &Value) -> String {
    s(&v["author"], "avatarUrl")
}

fn gh_error(e: impl std::fmt::Display) -> String {
    let message = e.to_string();
    let lower = message.to_lowercase();
    if [
        "gh auth login",
        "not logged",
        "authentication",
        "http 401",
        "bad credentials",
    ]
    .iter()
    .any(|s| lower.contains(s))
    {
        "gh is not logged in. Run `gh auth login` in a terminal.".into()
    } else if lower.contains("could not resolve to a repository")
        || lower.contains("could not resolve to a pullrequest")
    {
        "Repository or PR not found (or you do not have access)".into()
    } else {
        message
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(crate::err)?
        .map_err(gh_error)
}
fn gh(args: &[&str]) -> Result<String> {
    crate::git::exec("gh", &std::env::temp_dir(), args)
}
fn gh_json(args: &[&str]) -> Result<Value> {
    Ok(serde_json::from_str(&gh(args)?)?)
}
fn graphql(query: &str, variables: &[(&str, String)]) -> Result<Value> {
    let mut args = vec![
        "api".to_string(),
        "graphql".into(),
        "-f".into(),
        format!("query={query}"),
    ];
    // -f sends a raw string; -F would read "@path" as a file and turn "123" into a number.
    for (key, value) in variables {
        let flag = if *key == "number" { "-F" } else { "-f" };
        args.extend([flag.into(), format!("{key}={value}")]);
    }
    let v = gh_json(&args.iter().map(String::as_str).collect::<Vec<_>>())?;
    if let Some(errors) = v["errors"].as_array().filter(|a| !a.is_empty()) {
        bail!("{}", Value::Array(errors.clone()));
    }
    Ok(v)
}

fn valid_repo(repo: &str) -> bool {
    let parts: Vec<_> = repo.split('/').collect();
    parts.len() == 2
        && parts.iter().all(|p| {
            !p.is_empty()
                && *p != "."
                && *p != ".."
                && p.bytes().all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
        })
}

pub fn parse_ref(input: &str, default_repo: Option<&str>) -> Result<PrRef> {
    let input = input.trim();
    let (repo, number) = if let Some(url) = input.strip_prefix("https://github.com/") {
        let path = url.split(['?', '#']).next().unwrap_or_default();
        let parts: Vec<_> = path.split('/').collect();
        ensure!(parts.len() >= 4 && parts[2] == "pull", "Not a PR link or number");
        (Some(format!("{}/{}", parts[0], parts[1])), parts[3])
    } else if let Some((repo, n)) = input.rsplit_once('#') {
        (if repo.is_empty() { None } else { Some(repo.into()) }, n)
    } else {
        (None, input)
    };
    ensure!(
        !number.is_empty() && number.bytes().all(|c| c.is_ascii_digit()),
        "Not a PR link or number"
    );
    let number: u64 = number.parse().map_err(|_| anyhow!("Not a PR link or number"))?;
    ensure!(number > 0, "Not a PR link or number");
    let repo = repo
        .or_else(|| default_repo.map(String::from))
        .ok_or_else(|| anyhow!("Pick a repository for #{number}"))?;
    ensure!(valid_repo(&repo), "Not a PR link or number");
    Ok(PrRef { repo, number })
}

fn remote_repo(remote: &str) -> Option<String> {
    let repo = remote
        .trim()
        .strip_prefix("https://github.com/")
        .or_else(|| remote.trim().strip_prefix("git@github.com:"))
        .or_else(|| remote.trim().strip_prefix("ssh://git@github.com/"))?;
    let repo = repo
        .trim_end_matches('/')
        .strip_suffix(".git")
        .unwrap_or(repo.trim_end_matches('/'));
    valid_repo(repo).then(|| repo.into())
}

#[tauri::command]
pub async fn pr_review_parse_ref(
    state: State<'_, AppState>,
    input: String,
    repo_id: Option<String>,
) -> CmdResult<PrRef> {
    match parse_ref(&input, None) {
        Ok(reference) => return Ok(reference),
        Err(error) if !error.to_string().starts_with("Pick a repository") => return Err(gh_error(error)),
        Err(_) => {}
    }
    let repo = repo_id.map(|id| state.db().repo(&id)).transpose().map_err(crate::err)?;
    blocking(move || {
        let Some(repo) = repo else {
            return parse_ref(&input, None);
        };
        let path = Path::new(&repo.path);
        let remote = crate::git::exec("gh", path, &["repo", "view", "--json", "nameWithOwner"])
            .and_then(|out| Ok(s(&serde_json::from_str::<Value>(&out)?, "nameWithOwner")))
            .or_else(|_| {
                crate::git::run(path, &["remote", "get-url", "origin"])
                    .and_then(|out| remote_repo(&out).ok_or_else(|| anyhow!("No GitHub remote")))
            })?;
        parse_ref(&input, Some(&remote))
    })
    .await
}

const QUEUE_SOURCES: &[(&str, &str)] = &[
    ("requested", "review-requested:@me"),
    ("mine", "author:@me"),
    ("involves", "involves:@me"),
];
fn queue_query(sources: &[String]) -> String {
    let fields = "number title url author{login} updatedAt isDraft reviewDecision repository{nameWithOwner}";
    let blocks = QUEUE_SOURCES.iter().filter(|(source, _)| sources.iter().any(|s| s == source))
        .map(|(source, search)| format!("{source}:search(type:ISSUE,first:50,query:\"is:pr is:open archived:false {search}\"){{nodes{{... on PullRequest{{{fields}}}}}}}"))
        .collect::<Vec<_>>().join(" ");
    format!("query{{{blocks}}}")
}
fn parse_queue(v: &Value) -> Vec<ReviewQueueItem> {
    let mut items: HashMap<(String, u64), ReviewQueueItem> = HashMap::new();
    for (source, _) in QUEUE_SOURCES {
        for pr in nodes(&v["data"][source]) {
            let repo = s(&pr["repository"], "nameWithOwner");
            let Some(number) = pr["number"].as_u64() else { continue };
            let item = items.entry((repo.clone(), number)).or_insert_with(|| ReviewQueueItem {
                repo,
                number,
                title: s(pr, "title"),
                url: s(pr, "url"),
                author: author(pr),
                updated_at: s(pr, "updatedAt"),
                is_draft: b(pr, "isDraft"),
                review_decision: s(pr, "reviewDecision"),
                sources: vec![],
            });
            if !item.sources.iter().any(|s| s == source) {
                item.sources.push((*source).into());
            }
        }
    }
    let mut items: Vec<_> = items.into_values().collect();
    items.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then(a.repo.cmp(&b.repo))
            .then(a.number.cmp(&b.number))
    });
    items
}
#[tauri::command]
pub async fn pr_review_queue(state: State<'_, AppState>) -> CmdResult<Vec<ReviewQueueItem>> {
    let sources = state.settings().review_queue_sources;
    blocking(move || {
        if sources.is_empty() {
            Ok(vec![])
        } else {
            Ok(parse_queue(&graphql(&queue_query(&sources), &[])?))
        }
    })
    .await
}

pub fn parse_detail(graphql: &Value, rest_files: &Value, merge_base: &str, checks: Checks) -> Result<PrDetail> {
    let data = &graphql["data"];
    let pr = &data["repository"]["pullRequest"];
    ensure!(pr.is_object(), "Repository or PR not found (or you do not have access)");
    let url = s(pr, "url");
    let repo = data["repository"]["nameWithOwner"]
        .as_str()
        .map(String::from)
        .or_else(|| parse_ref(&url, None).ok().map(|r| r.repo))
        .ok_or_else(|| anyhow!("PR has no repository"))?;
    Ok(PrDetail {
        id: s(pr, "id"),
        repo,
        number: pr["number"].as_u64().ok_or_else(|| anyhow!("PR has no number"))?,
        title: s(pr, "title"),
        body: s(pr, "body"),
        url,
        author: author(pr),
        author_avatar_url: avatar(pr),
        state: s(pr, "state"),
        is_draft: b(pr, "isDraft"),
        viewer_login: s(&data["viewer"], "login"),
        viewer_did_author: b(pr, "viewerDidAuthor"),
        head_ref: s(pr, "headRefName"),
        base_ref: s(pr, "baseRefName"),
        head_sha: s(pr, "headRefOid"),
        merge_base_sha: merge_base.into(),
        review_decision: s(pr, "reviewDecision"),
        mergeable: s(pr, "mergeable"),
        checks,
        created_at: s(pr, "createdAt"),
        updated_at: s(pr, "updatedAt"),
        files: rest_files
            .as_array()
            .into_iter()
            .flatten()
            .map(|f| PrFile {
                path: s(f, "filename"),
                previous_path: f["previous_filename"].as_str().map(String::from),
                additions: f["additions"].as_u64().unwrap_or(0),
                deletions: f["deletions"].as_u64().unwrap_or(0),
                status: s(f, "status"),
                viewed: nodes(&pr["files"]).any(|n| n["path"] == f["filename"] && n["viewerViewedState"] == "VIEWED"),
            })
            .collect(),
        threads: nodes(&pr["reviewThreads"])
            .map(|t| PrThread {
                id: s(t, "id"),
                path: s(t, "path"),
                side: if t["diffSide"] == "LEFT" { "old" } else { "new" }.into(),
                line: t["line"].as_u64(),
                start_line: t["startLine"].as_u64(),
                original_line: t["originalLine"].as_u64(),
                is_resolved: b(t, "isResolved"),
                is_outdated: b(t, "isOutdated"),
                can_resolve: b(t, "viewerCanResolve") || b(t, "viewerCanUnresolve"),
                comments: nodes(&t["comments"])
                    .map(|c| PrComment {
                        id: c["databaseId"].as_u64().unwrap_or(0),
                        author: author(c),
                        avatar_url: avatar(c),
                        body: s(c, "body"),
                        created_at: s(c, "createdAt"),
                        is_mine: b(c, "viewerDidAuthor"),
                    })
                    .collect(),
            })
            .collect(),
        reviews: nodes(&pr["reviews"])
            .map(|r| PrReviewSummary {
                id: s(r, "id"),
                author: author(r),
                avatar_url: avatar(r),
                state: s(r, "state"),
                body: s(r, "body"),
                submitted_at: r["submittedAt"].as_str().map(String::from),
            })
            .collect(),
        comments: nodes(&pr["comments"])
            .map(|c| PrTimelineComment {
                id: c["databaseId"].as_u64().unwrap_or(0),
                author: author(c),
                avatar_url: avatar(c),
                body: s(c, "body"),
                created_at: s(c, "createdAt"),
            })
            .collect(),
    })
}

const FILE_FIELDS: &str = "path viewerViewedState";
const THREAD_FIELDS: &str = "id path line startLine originalLine diffSide isResolved isOutdated viewerCanResolve viewerCanUnresolve comments(first:100){nodes{databaseId body createdAt author{login avatarUrl} viewerDidAuthor}}";
#[tauri::command]
pub async fn pr_review_detail(repo: String, number: u64) -> CmdResult<PrDetail> {
    blocking(move || {
        ensure!(valid_repo(&repo), "Not a repository name");
        let (owner, name) = repo.split_once('/').unwrap();
        let variables = [("owner",owner.into()),("name",name.into()),("number",number.to_string())];
        let query = format!("query($owner:String!,$name:String!,$number:Int!){{viewer{{login}} repository(owner:$owner,name:$name){{nameWithOwner pullRequest(number:$number){{id number title body url author{{login avatarUrl}} state isDraft viewerDidAuthor headRefName baseRefName headRefOid baseRefOid reviewDecision mergeable createdAt updatedAt files(first:100){{nodes{{{FILE_FIELDS}}} pageInfo{{hasNextPage endCursor}}}} reviewThreads(first:100){{nodes{{{THREAD_FIELDS}}} pageInfo{{hasNextPage endCursor}}}} reviews(last:50){{nodes{{id state body submittedAt author{{login avatarUrl}}}}}} comments(first:100){{nodes{{databaseId body createdAt author{{login avatarUrl}}}}}}}}}}}}");
        let mut detail = graphql(&query, &variables)?;
        ensure!(detail["data"]["repository"]["pullRequest"].is_object(), "Repository or PR not found (or you do not have access)");
        for (connection, fields) in [("files",FILE_FIELDS),("reviewThreads",THREAD_FIELDS)] {
            loop {
                let page = &detail["data"]["repository"]["pullRequest"][connection]["pageInfo"];
                if !b(page,"hasNextPage") { break; }
                let cursor = page["endCursor"].as_str().ok_or_else(|| anyhow!("Missing GitHub pagination cursor"))?;
                let mut vars = variables.to_vec(); vars.push(("cursor",cursor.into()));
                let q = format!("query($owner:String!,$name:String!,$number:Int!,$cursor:String!){{repository(owner:$owner,name:$name){{pullRequest(number:$number){{{connection}(first:100,after:$cursor){{nodes{{{fields}}} pageInfo{{hasNextPage endCursor}}}}}}}}}}");
                let next = graphql(&q,&vars)?;
                let next = &next["data"]["repository"]["pullRequest"][connection];
                let target = &mut detail["data"]["repository"]["pullRequest"][connection];
                target["nodes"].as_array_mut().ok_or_else(|| anyhow!("Missing GitHub nodes"))?.extend(nodes(next).cloned());
                target["pageInfo"] = next["pageInfo"].clone();
            }
        }
        let output = gh(&["api","--paginate",&format!("repos/{repo}/pulls/{number}/files")])?;
        let mut rest = vec![];
        for page in serde_json::Deserializer::from_str(&output).into_iter::<Vec<Value>>() { rest.extend(page?); }
        let pr = &detail["data"]["repository"]["pullRequest"];
        let merge_base = gh(&["api", &format!("repos/{repo}/compare/{}...{}",s(pr,"baseRefOid"),s(pr,"headRefOid")),"--jq",".merge_base_commit.sha"])?;
        let checks = gh_json(&["pr","view",&number.to_string(),"-R",&repo,"--json","statusCheckRollup"])?;
        parse_detail(&detail,&Value::Array(rest),&merge_base,crate::gh::summarize_checks(&checks["statusCheckRollup"]))
    }).await
}

fn comment_payload(comment: &NewPrComment) -> Result<Value> {
    let side = match comment.side.as_str() {
        "old" => "LEFT",
        "new" => "RIGHT",
        _ => bail!("Invalid comment side"),
    };
    ensure!(comment.line > 0, "Comment line must be positive");
    let mut payload = json!({"path":comment.path,"body":comment.body,"line":comment.line,"side":side});
    if let Some(start) = comment.start_line.filter(|start| *start < comment.line) {
        ensure!(start > 0, "Comment start line must be positive");
        payload["start_line"] = json!(start);
        payload["start_side"] = json!(side);
    }
    Ok(payload)
}
pub fn submit_payload(commit_id: &str, event: &str, body: &str, comments: &[NewPrComment]) -> Result<Value> {
    ensure!(
        ["COMMENT", "APPROVE", "REQUEST_CHANGES"].contains(&event),
        "Invalid review event"
    );
    ensure!(
        event == "APPROVE" || !body.trim().is_empty() || !comments.is_empty(),
        "Write a summary or add a comment first"
    );
    Ok(
        json!({"commit_id":commit_id,"event":event,"body":body,"comments":comments.iter().map(comment_payload).collect::<Result<Vec<_>>>()?}),
    )
}
fn post(endpoint: &str, payload: Value) -> Result<()> {
    let mut cmd = Command::new("gh");
    cmd.args(["api", "--method", "POST", endpoint, "--input", "-"])
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = crate::agent::process::spawn_std(&mut cmd)?;
    let written = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("gh stdin unavailable"))?
        .write_all(&serde_json::to_vec(&payload)?);
    let out = child.wait_with_output()?;
    written?;
    ensure!(
        out.status.success(),
        "GitHub request failed: {}",
        String::from_utf8_lossy(&out.stderr).trim()
    );
    Ok(())
}
#[tauri::command]
pub async fn pr_review_submit(
    repo: String,
    number: u64,
    commit_id: String,
    event: String,
    body: String,
    comments: Vec<NewPrComment>,
) -> CmdResult<()> {
    blocking(move || {
        let head = gh(&["api", &format!("repos/{repo}/pulls/{number}"), "--jq", ".head.sha"])?;
        ensure!(
            head == commit_id,
            "stale: the PR changed since you loaded it; reload to review the new commits"
        );
        post(
            &format!("repos/{repo}/pulls/{number}/reviews"),
            submit_payload(&commit_id, &event, &body, &comments)?,
        )
    })
    .await
}
#[tauri::command]
pub async fn pr_review_comment(repo: String, number: u64, commit_id: String, comment: NewPrComment) -> CmdResult<()> {
    blocking(move || {
        let mut payload = comment_payload(&comment)?;
        payload["commit_id"] = json!(commit_id);
        post(&format!("repos/{repo}/pulls/{number}/comments"), payload)
    })
    .await
}
#[tauri::command]
pub async fn pr_review_reply(repo: String, number: u64, comment_id: u64, body: String) -> CmdResult<()> {
    blocking(move || {
        post(
            &format!("repos/{repo}/pulls/{number}/comments/{comment_id}/replies"),
            json!({"body":body}),
        )
    })
    .await
}
#[tauri::command]
pub async fn pr_review_issue_comment(repo: String, number: u64, body: String) -> CmdResult<()> {
    blocking(move || post(&format!("repos/{repo}/issues/{number}/comments"), json!({"body":body}))).await
}
#[tauri::command]
pub async fn pr_review_resolve(thread_id: String, resolved: bool) -> CmdResult<()> {
    blocking(move || {
        let action = if resolved {
            "resolveReviewThread"
        } else {
            "unresolveReviewThread"
        };
        let query = format!("mutation($threadId:ID!){{{action}(input:{{threadId:$threadId}}){{thread{{id}}}}}}");
        graphql(&query, &[("threadId", thread_id)])?;
        Ok(())
    })
    .await
}
#[tauri::command]
pub async fn pr_review_viewed(pr_id: String, path: String, viewed: bool) -> CmdResult<()> {
    blocking(move || {
        let action = if viewed { "markFileAsViewed" } else { "unmarkFileAsViewed" };
        let query = format!("mutation($prId:ID!,$path:String!){{{action}(input:{{pullRequestId:$prId,path:$path}}){{clientMutationId}}}}");
        graphql(&query,&[("prId",pr_id),("path",path)])?; Ok(())
    }).await
}

fn percent_encode(path: &str) -> String {
    let mut out = String::new();
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~/".contains(&byte) {
            out.push(byte as char);
        } else {
            use std::fmt::Write;
            write!(out, "%{byte:02X}").expect("string write");
        }
    }
    out
}
fn file_text(bytes: Vec<u8>) -> Option<String> {
    if bytes.len() > 1024 * 1024 || bytes.iter().take(8192).any(|b| *b == 0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}
type FileKey = (String, String, String);
#[derive(Default)]
struct FileCache {
    values: HashMap<FileKey, Option<String>>,
    order: VecDeque<FileKey>,
}
impl FileCache {
    fn insert(&mut self, key: FileKey, value: Option<String>) {
        if self.values.contains_key(&key) {
            return;
        }
        if self.order.len() >= 300 {
            if let Some(old) = self.order.pop_front() {
                self.values.remove(&old);
            }
        }
        self.order.push_back(key.clone());
        self.values.insert(key, value);
    }
}
static FILE_CACHE: LazyLock<Mutex<FileCache>> = LazyLock::new(|| Mutex::new(FileCache::default()));
#[tauri::command]
pub async fn pr_review_file(repo: String, sha: String, path: String) -> CmdResult<Option<String>> {
    blocking(move || {
        let key = (repo.clone(), sha.clone(), path.clone());
        let cached = FILE_CACHE
            .lock()
            .map_err(|_| anyhow!("File cache unavailable"))?
            .values
            .get(&key)
            .cloned();
        if let Some(value) = cached {
            return Ok(value);
        }
        let endpoint = format!(
            "repos/{repo}/contents/{}?ref={}",
            percent_encode(&path),
            percent_encode(&sha)
        );
        // Preserve trailing newlines and inspect the original bytes before decoding.
        let mut cmd = Command::new("gh");
        cmd.args(["api", "-H", "Accept: application/vnd.github.raw", &endpoint])
            .current_dir(std::env::temp_dir())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let out = crate::agent::process::spawn_std(&mut cmd)?.wait_with_output()?;
        let value = if out.status.success() {
            file_text(out.stdout)
        } else {
            let error = String::from_utf8_lossy(&out.stderr);
            if error.contains("404") || error.contains("Not Found") || error.contains("too large") {
                None
            } else {
                bail!("{error}");
            }
        };
        FILE_CACHE
            .lock()
            .map_err(|_| anyhow!("File cache unavailable"))?
            .insert(key, value.clone());
        Ok(value)
    })
    .await
}
#[tauri::command]
pub async fn local_review(state: State<'_, AppState>, workspace_id: String) -> CmdResult<LocalReview> {
    let ws = state.db().workspace(&workspace_id).map_err(crate::err)?;
    let repo = state.db().repo(&ws.repo_id).map_err(crate::err)?;
    blocking(move || {
        let path = Path::new(&ws.path);
        let base = crate::git::changes_merge_base(path, &repo.base_branch);
        Ok(LocalReview {
            workspace_id,
            root: ws.path.clone(),
            base_sha: crate::git::run(path, &["rev-parse", &base])?,
            head_sha: crate::git::run(path, &["rev-parse", "HEAD"])?,
            dirty: !crate::git::run(path, &["status", "--porcelain"])?.is_empty(),
            files: crate::git::changes(path, &repo.base_branch)?,
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live: real GraphQL/REST calls through gh against a recent merged PR in cli/cli (needs `gh auth login`).
    #[test]
    #[ignore]
    fn live_detail_file_and_queue() {
        let list = gh_json(&["pr", "list", "-R", "cli/cli", "--state", "merged", "-L", "1", "--json", "number"]).unwrap();
        let number = list[0]["number"].as_u64().unwrap();
        let d = tauri::async_runtime::block_on(pr_review_detail("cli/cli".into(), number)).unwrap();
        assert_eq!(d.number, number);
        assert_eq!(d.merge_base_sha.len(), 40, "{}", d.merge_base_sha);
        assert!(!d.files.is_empty() && !d.viewer_login.is_empty());
        let f = d.files.iter().find(|f| f.status != "removed").unwrap();
        let text = tauri::async_runtime::block_on(pr_review_file(d.repo.clone(), d.head_sha.clone(), f.path.clone())).unwrap();
        assert!(text.is_some() || f.path.ends_with(".png"), "{}", f.path);
        let all = ["requested", "mine", "involves"].map(String::from);
        let queue = parse_queue(&graphql(&queue_query(&all), &[]).unwrap());
        assert!(queue.iter().all(|q| valid_repo(&q.repo)));
    }

    #[test]
    fn parse_ref_forms_and_errors() {
        for input in [
            "https://github.com/o/r/pull/12",
            "https://github.com/o/r/pull/12/files?diff=split#x",
            "o/r#12",
            "#12",
            "12",
            " 12 ",
        ] {
            assert_eq!(
                parse_ref(input, Some("o/r")).unwrap(),
                PrRef {
                    repo: "o/r".into(),
                    number: 12
                }
            );
        }
        for input in [
            "",
            "foo",
            "o/r#0",
            "o/r#-1",
            "o/r#12x",
            "https://example.com/o/r/pull/12",
            "https://github.com/o/r/issues/12",
            "a/b/c#12",
            "o/r#18446744073709551616",
        ] {
            assert_eq!(
                parse_ref(input, None).unwrap_err().to_string(),
                "Not a PR link or number",
                "{input}"
            );
        }
        for input in ["12", "#12"] {
            assert_eq!(
                parse_ref(input, None).unwrap_err().to_string(),
                "Pick a repository for #12"
            );
        }
        for remote in [
            "https://github.com/o/r.git",
            "git@github.com:o/r.git",
            "ssh://git@github.com/o/r.git",
        ] {
            assert_eq!(remote_repo(remote).as_deref(), Some("o/r"));
        }
        assert!(remote_repo("https://example.com/o/r.git").is_none());
    }

    #[test]
    fn detail_fixture() {
        let graphql: Value = serde_json::from_str(include_str!("../tests/fixtures/gh_pr_review_detail.json")).unwrap();
        let files: Value = serde_json::from_str(include_str!("../tests/fixtures/gh_pr_review_files.json")).unwrap();
        let detail = parse_detail(
            &graphql,
            &files,
            "merge",
            Checks {
                passed: 2,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(detail.repo, "o/r");
        assert_eq!(detail.viewer_login, "me");
        assert_eq!(detail.head_sha, "head");
        assert_eq!(detail.merge_base_sha, "merge");
        assert_eq!(detail.checks.passed, 2);
        assert_eq!(detail.files[0].status, "renamed");
        assert_eq!(detail.files[0].previous_path.as_deref(), Some("old.rs"));
        assert!(detail.files[0].viewed);
        assert!(!detail.files[1].viewed);
        assert_eq!(detail.files[1].status, "removed");
        assert!(detail.threads[0].is_resolved && detail.threads[0].can_resolve);
        assert_eq!(detail.threads[0].side, "old");
        assert_eq!(detail.threads[0].start_line, Some(2));
        assert!(detail.threads[0].comments[0].is_mine);
        assert!(detail.threads[1].is_outdated);
        assert_eq!(detail.threads[1].line, None);
        assert_eq!(detail.threads[1].comments[0].author, "ghost");
        assert_eq!(detail.threads[1].comments[0].avatar_url, "");
        assert_eq!(detail.reviews[0].submitted_at, None);
        assert_eq!(detail.comments[0].author, "ghost");
        assert_eq!(detail.review_decision, "");
        let wire = serde_json::to_value(&detail).unwrap();
        assert_eq!(wire["authorAvatarUrl"], "avatar");
        assert_eq!(wire["threads"][0]["startLine"], 2);
        assert!(parse_detail(&json!({"data":{"repository":null}}), &files, "", Checks::default()).is_err());
    }

    #[test]
    fn queue_merges_and_sorts() {
        let a = json!({"number":1,"repository":{"nameWithOwner":"o/r"},"updatedAt":"2026-01-01","reviewDecision":null});
        let b = json!({"number":2,"repository":{"nameWithOwner":"o/r"},"updatedAt":"2026-02-01"});
        let other = json!({"number":1,"repository":{"nameWithOwner":"o/other"},"updatedAt":"2026-03-01"});
        let items = parse_queue(
            &json!({"data":{"requested":{"nodes":[a,b]},"mine":{"nodes":[a,other]},"involves":{"nodes":[a]}}}),
        );
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].repo, "o/other");
        assert_eq!(items[1].number, 2);
        assert_eq!(items[2].sources, ["requested", "mine", "involves"]);
        assert_eq!(items[2].review_decision, "");
        let query = queue_query(&["mine".into()]);
        assert!(query.contains("mine:search"));
        assert!(!query.contains("requested:search"));
        assert!(!query.contains("involves:search"));
    }
    fn comment(side: &str, start_line: Option<u64>) -> NewPrComment {
        NewPrComment {
            path: "file.rs".into(),
            side: side.into(),
            line: 8,
            start_line,
            body: "Comment".into(),
        }
    }
    #[test]
    fn submit_payload_rules() {
        let p = submit_payload("sha", "COMMENT", "", &[comment("new", None)]).unwrap();
        assert_eq!(
            p["comments"][0],
            json!({"path":"file.rs","body":"Comment","line":8,"side":"RIGHT"})
        );
        let p = submit_payload("sha", "REQUEST_CHANGES", " summary ", &[comment("old", Some(2))]).unwrap();
        assert_eq!(p["body"], " summary ");
        assert_eq!(p["commit_id"], "sha");
        assert_eq!(p["comments"][0]["start_line"], 2);
        assert_eq!(p["comments"][0]["start_side"], "LEFT");
        for start in [Some(8), Some(9)] {
            assert!(comment_payload(&comment("new", start))
                .unwrap()
                .get("start_line")
                .is_none());
        }
        for event in ["COMMENT", "REQUEST_CHANGES"] {
            assert_eq!(
                submit_payload("sha", event, " \n", &[]).unwrap_err().to_string(),
                "Write a summary or add a comment first"
            );
        }
        assert!(submit_payload("sha", "APPROVE", "", &[]).is_ok());
        assert!(submit_payload("sha", "BAD", "body", &[]).is_err());
        assert!(comment_payload(&comment("bad", None)).is_err());
    }
    #[test]
    fn binary_and_size_limits() {
        assert_eq!(file_text(b"hello\n".to_vec()).as_deref(), Some("hello\n"));
        assert_eq!(file_text(b"hi\0there".to_vec()), None);
        assert_eq!(file_text(vec![b'x'; 1024 * 1024 + 1]), None);
        assert!(file_text(vec![b'x'; 1024 * 1024]).is_some());
        let mut bytes = vec![b'x'; 8193];
        bytes[8192] = 0;
        assert!(file_text(bytes).is_some());
    }
    #[test]
    fn path_encoding() {
        assert_eq!(percent_encode("src/a b#?%.rs"), "src/a%20b%23%3F%25.rs");
        assert_eq!(percent_encode("caf\u{e9}/a+b"), "caf%C3%A9/a%2Bb");
    }
    #[test]
    fn cache_is_bounded() {
        let mut cache = FileCache::default();
        for i in 0..301 {
            cache.insert(("o/r".into(), i.to_string(), "a".into()), None);
        }
        assert_eq!(cache.values.len(), 300);
        assert!(!cache.values.contains_key(&("o/r".into(), "0".into(), "a".into())));
    }
    #[test]
    fn friendly_errors() {
        assert!(gh_error("HTTP 401: Bad credentials").starts_with("gh is not logged in."));
        assert_eq!(
            gh_error("Could not resolve to a PullRequest"),
            "Repository or PR not found (or you do not have access)"
        );
    }
}
