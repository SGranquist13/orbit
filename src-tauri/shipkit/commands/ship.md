---
description: Commit everything, push the branch, and open (or update) a draft PR.
argument-hint: "[extra notes for the PR description]"
---

Ship the work in this workspace.

1. **Check it.** Run the project's fast checks (typecheck, lint, the tests touching changed files) if they exist. Fix any failures before continuing. If something can't be fixed, stop and explain.
2. **Commit.** Stage all intended changes (never secrets, build output, or stray debug files). Write conventional commit messages (`feat:`, `fix:`, `refactor:`, …). Split into multiple commits only if the changes are clearly unrelated.
3. **Push.** Push the current branch with `git push -u origin HEAD`.
4. **PR.** If no PR exists for this branch (`gh pr view --json url` fails), create a draft one against the base branch from your workspace context: `gh pr create --draft --base <base> --title "<conventional title>" --body-file <tmpfile>`. If a PR exists, update its body only if the scope changed.

5. **Attached folders.** If your workspace context lists editable attached folders (worktrees on their own branch) and they have changes, ship each of them the same way: run its checks, commit, push its branch, and open a draft PR in that repo against that repo's default branch. Skip read-only attached folders. Cross-link the PRs: mention each related PR URL in the others' descriptions.

PR body template:

```
## What
<1–3 sentences on the change and why>

## Changes
- <bullet per meaningful change>

## Testing
- <what you ran and the result>

<"Closes #N" if your workspace context names a linked issue>
```

Extra notes from the user: $ARGUMENTS

Finish with one line: the PR URL.
