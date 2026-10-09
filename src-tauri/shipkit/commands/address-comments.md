---
description: Address unresolved review comments on this branch's PR and push the fixes.
argument-hint: "[reviewer or topic to focus on]"
---

Address the review feedback on this branch's PR.

1. Get the PR number: `gh pr view --json number,url`.
2. Read the review threads and comments:
   - `gh pr view --comments`
   - `gh api repos/{owner}/{repo}/pulls/<number>/comments` (inline code comments)
3. Make a checklist of actionable, unresolved items (`$ARGUMENTS` narrows the focus if given). Skip ones already addressed by later commits.
4. Fix each item. If you disagree with a comment or it needs a product decision, don't change the code: list it under "Needs your call" with your reasoning.
5. Run relevant checks, commit (`fix: address review feedback`), and `git push`.

Don't post replies on the PR. Finish with a checklist of each comment and what you did.
