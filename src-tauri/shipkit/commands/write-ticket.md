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
4. Create it: `gh issue create --title "…" --body-file <tmpfile> [--label …]`.

Finish with one line: the issue URL.
