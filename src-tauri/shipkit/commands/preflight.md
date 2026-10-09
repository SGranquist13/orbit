---
description: Pre-ship spot check. Find what this branch changes at its boundaries and verify nothing upstream or downstream breaks, including in attached projects.
argument-hint: "[area to focus on]"
---

Run a pre-ship spot check of this branch. Developers work across many projects at once, so the goal is to catch changes that silently break **another** project or a dependency, not to review code style.

This is **read-only**: do not edit files, commit, or push. Report only.

## 1. Find boundary changes

Diff against the base branch from your workspace context (`git diff <base>...HEAD`, plus uncommitted changes). List every change that crosses a boundary:
- exported functions, classes, types, constants (renamed, removed, signature or behaviour changed)
- public APIs: HTTP routes, RPC/IPC commands, request/response shapes, status codes
- CLI commands and flags, scripts other tools call
- config keys, environment variables, feature flags, defaults
- database schemas, migrations, queries other services rely on
- events, messages, queues, file formats, serialized data
- package name/version, peer dependencies, build outputs

Ignore purely internal changes. If there are no boundary changes, say so and stop.

## 2. Look downstream: who consumes this?

For each boundary change, search for consumers:
- in this repository (other modules, tests, docs, examples)
- in **every attached folder listed in your workspace context**. These are other projects the developer works on; treat them as likely consumers.

Search by name, route, key, and string literal (e.g. `rg -n "<symbol>|<route>|<KEY>"`), including dynamic uses (string-built routes, config lookups, reflection). Note each consumer as file:line.

## 3. Look upstream: what does this rely on?

Check whether the change depends on something its dependencies may not provide: a newer API or version than the lockfile pins, a field or env var that isn't guaranteed, a service behaviour, a migration that hasn't run.

## 4. Verify where it's cheap

For affected consumers, run the cheapest real check that would catch a break: typecheck, build, or the specific tests touching the call site. Do it in this repo and in attached folders (read-only commands only, no installs that modify lockfiles). If a check is too slow or needs setup, say so instead of skipping silently.

## 5. Report

Start with a one-line verdict: **Safe to ship**, **Risky**, or **Breaking**.

Then a table, one row per boundary change:

| Change | Affected | Verdict | Evidence | Suggested fix |
|---|---|---|---|---|

- **Verdict**: Safe (no consumers, or consumers verified compatible), Risky (consumers found, compatibility unverified), Breaking (a consumer will fail, with proof).
- **Evidence**: file:line of the consumer and what you ran.
- **Suggested fix**: the smallest change to make it safe (e.g. keep the old name as an alias, make the field optional, add a migration, bump the major version).

Finish with "Not checked" for anything you couldn't verify and why.

Focus area from the user (optional): $ARGUMENTS
