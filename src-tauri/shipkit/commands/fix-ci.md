---
description: Find failing CI checks on this branch's PR, fix them, and push.
argument-hint: "[check name to focus on]"
---

Fix CI for this branch.

1. List checks: `gh pr checks` (if there is no PR, use `gh run list --branch "$(git branch --show-current)" --limit 5`).
2. For each failing check (or only `$ARGUMENTS` if given), read the failure: `gh run view <run-id> --log-failed`. Focus on the first real error, not cascading noise.
3. Reproduce locally with the same command when feasible, then fix the root cause. Don't skip tests, loosen assertions, or disable checks to make CI green.
4. Run the relevant checks locally, commit (`fix(ci): …`), and `git push`.
5. If a failure is flaky or unrelated to this branch (it also fails on the base branch), say so instead of changing code.

Finish with a short summary: what failed, the cause, the fix.
