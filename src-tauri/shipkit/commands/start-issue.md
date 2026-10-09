---
description: Read the linked GitHub issue, plan, and implement it.
argument-hint: "[issue number, if not linked]"
---

Implement the GitHub issue linked in your workspace context (or #$ARGUMENTS if given).

1. Read it fully: `gh issue view <number> --comments`.
2. Explore the relevant code, then write a short plan (3–7 bullets) mapped to the acceptance criteria.
3. Implement it with tests for the new behaviour. Keep the change focused on this issue.
4. Run the relevant checks until they pass.
5. Don't commit or push. The user will review and then run /shipkit:ship.

Finish with: what changed, how each acceptance criterion is met, and anything left open.
