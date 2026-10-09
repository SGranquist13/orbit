---
description: Rebase this branch onto the latest base branch, resolve conflicts, and push.
---

Bring this branch up to date with the base branch from your workspace context.

1. Commit or stash any uncommitted work first.
2. `git fetch origin` then `git rebase origin/<base>`.
3. Resolve conflicts by understanding both sides: keep the base branch's changes and re-apply this branch's intent on top. Never drop either side's work just to make the conflict go away.
4. After the rebase, run the build and the tests touching changed files.
5. If the branch was already pushed, `git push --force-with-lease`; otherwise `git push -u origin HEAD`.

Finish with a summary of any conflicts and how you resolved them.
