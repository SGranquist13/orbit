---
description: Turn rough notes into a well-formed GitHub issue and file it.
argument-hint: "<rough notes about the bug or feature>"
---

Turn these rough notes into a GitHub issue for this repository:

$ARGUMENTS

1. Investigate briefly so the ticket is accurate: find the relevant code, and reproduce the bug if that's cheap. Don't change any code.
2. Write the issue:
   - **Title:** imperative, specific, under 70 chars (e.g. "Fix crash when org name is empty during onboarding").
   - **Body:**
     ```
     ## Context
     <what's wrong or missing, and who it affects>

     ## Details
     <repro steps for bugs (expected vs actual), or the proposed behaviour for features; point to relevant files>

     ## Acceptance criteria
     - [ ] <observable, testable outcome>
     - [ ] <…>
     ```
3. Pick labels only from existing ones (`gh label list`): typically bug/enhancement plus an area.
4. Use the Write tool to save the formatted body to a new, uniquely named file (e.g. `ticket-<timestamp>.md`) in the scratch folder given in your workspace context (`~/.orbit/tmp`). Then run the single-line command `gh issue create --title "…" --body-file "<absolute path to that file>" [--label …]`. Never pipe, use heredocs, or pass a multi-line `--body`. If you cannot write to the scratch folder (e.g. in a read-only sandbox), fall back to a single-line `gh issue create --title "…" --body "…" [--label …]` with plain text and no newlines in the body.

Finish with one line: the issue URL.
