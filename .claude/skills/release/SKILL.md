---
name: release
description: Cut an Orbit release (consolidate `next` into `main`, bump, tag, draft the GitHub release, showcase it in the README). Use when the user asks to release, cut, tag or ship a version, or asks whether it's time for one.
---

# Release Orbit

The release train is described in CLAUDE.md under "Releases". Code reaches `main` only through this checklist. Work through it in order and stop at each **ask** for the user's yes.

## 1. Is it time?
- `git log --oneline main..next` and the `## Unreleased` section of `CHANGELOG.md` on `next`. Nothing user-facing there means no release.
- Pick the version: a minor bump if Unreleased has any feature, a patch if it only has fixes.
- List feature branches not yet merged into `next` (`git branch -a --no-merged next`) and ask which belong in this release. Each must have passed its own e2e step before it merges into `next`.

## 2. Consolidate on `next`
- Merge the chosen branches into `next` (resolve conflicts as CLAUDE.md's merge notes say), then merge `main` into `next` for any docs-only commits.
- Make sure every user-facing change has a line under Unreleased, in FEATURES.md's public tone (🧪 items say "Preview:"), and that Unreleased **starts with a one-sentence summary paragraph**: it becomes the README's "New in" line.
- Check FEATURES.md statuses (✅ only for real-app e2e) and the README's Features, shortcuts and Roadmap sections against what is shipping.

## 3. Prove it
- **Ask** before running e2e (it opens its own Orbit window and needs Vite on :1420). Then run in the background: `bun run e2e`, `bun run e2e:github`, `cmd //c "scripts\\cargo.cmd test"`, `bun run check:guards`, `bunx tsc --noEmit`.
- Record the results in `VERIFICATION.md` (local). A failure blocks the release unless it's an outside cause (e.g. an agent usage limit) and the user agrees.

## 4. Cut it
```
bun run release X.Y.Z            # on next: versions, changelog date, README "New in", FEATURES version row
git commit -am "chore(release): vX.Y.Z"
git switch main && git merge --no-ff next -m "release: vX.Y.Z"
git tag -a vX.Y.Z -m "Orbit X.Y.Z"
git switch next && git merge --ff-only main
```
Show the user the README "New in" line and the changelog section.

## 5. Publish
- **Ask**, then `git push origin main next vX.Y.Z`.
- The tag starts `.github/workflows/release.yml`: watch it (`gh run watch`, in the background). It drafts the GitHub release with `Orbit_X.Y.Z_x64-setup.exe` and the changelog section.
- Smoke-test the installer (silent install, launch, one turn, uninstall), then **ask** and publish: `gh release edit vX.Y.Z --draft=false --latest`.
- Check the README's release badge and Download link now point to vX.Y.Z.

## Patch releases
For an urgent fix to the released version: branch from `main`, fix, test, then run steps 4–5 on `main` (`bun run release X.Y.Z+1` there) and merge `main` back into `next`.
