# Orbit v0.1 launch video: storyboard

**Goal:** a 45-second product launch video for LinkedIn (and the README / release page).
**Format:** 1080×1350 (4:5, best in the LinkedIn feed) with a 1920×1080 export for GitHub/YouTube. 30 fps.
**Sound:** LinkedIn autoplays muted, so every point is carried by on-screen text; a subtle synth bed is optional.
**Look:** Orbit's own design language: near-black "Void" background, greyscale chrome, colour only for meaning (amber = running, green = done, red = failing), Inter type, 1-bit dither transitions, hard offset shadows. No stock footage, no voice-over.

**Build (proposed):** [Remotion](https://www.remotion.dev) (React → MP4) in `docs/launch-video/` as its own small project.
- App scenes render Orbit's **real React components** with the mock launch seed (`src/lib/mock-launch.ts`), so the footage is the actual product.
- The opener uses `@remotion/three` (three.js) for the black hole: a particle disc, dithered, with the planet passing behind the horizon (matches `OrbitHero`).
- Captions are a shared `<Caption>` component (Inter 600, white, fade/slide in).

---

## Scenes

| # | Time | Visual | On-screen text | Notes |
|---|---|---|---|---|
| 1 | 0:00–0:04 | Black screen. Dithered particles swirl into the Orbit black hole (three.js); the small planet arcs behind the horizon. | — | Hook. Particles resolve from noise to the logo shape at ~3s. |
| 2 | 0:04–0:09 | Six terminal windows tile in fast and overlap, each streaming agent output; one blinks "waiting for input…", one goes red. Slight camera shake. | **"One terminal per agent doesn't scale."** | The problem. Keep terminals monochrome; only the red error carries colour. |
| 3 | 0:09–0:14 | The terminals collapse (dither wipe) into Orbit's sidebar; each becomes a workspace row with a status square. | **"Orbit gives every task its own worktree, branch and agent."** | The idea. Rows show repo groups (relay, marketing-site, api-gateway). |
| 4 | 0:14–0:20 | Full app: the fleet. Three rows with amber running sweeps, Claude and Codex icons side by side; the chat streams a fix in "Onboarding crash". | **"Run Claude Code and Codex in parallel."** | Real UI, launch seed workspace `w1`. Slow push-in. |
| 5 | 0:20–0:26 | Inbox (Ctrl+I): rows "Finished", "Asked you something", "Checks failed". A key press "2" sends a suggested reply; the row slides away. | **"One inbox for everything that needs you."** | Show the number-key hint chip being pressed. |
| 6 | 0:26–0:33 | Ship panel: PR #827, checks red → click **Fix CI** → agent turn → checks turn green → **Squash & merge** → workspace archives itself. | **"From diff to merged PR, in one panel."** | The money shot. Speed-ramp the CI wait. |
| 7 | 0:33–0:39 | Teammates view: message Chief "Add CSV export with tests"; the plan card splits into parts for Builder → Reviewer; avatars blink as they work. | **"AI teammates that plan, build and review."** | The colourful avatars are the one place colour is decorative. |
| 8 | 0:39–0:45 | Back to the black hole, smaller; logo and type lock up. | **Orbit v0.1**<br/>Free & open source · Windows<br/>Works with Claude Code & Codex<br/>**github.com/SGranquist13/orbit** | Hold 3 s on the URL. |

**Optional extra beats** (to make it 60 s): Routines ("every Monday at 9"), and the Simplify pass committing three small refactors and reverting one that broke the tests.

---

## Open questions for you
1. **Length:** 45 s (recommended for the feed) or 60 s with the extra beats?
2. **Music:** silent with captions, or a light synth bed (royalty-free)?
3. **Your face / voice:** a 5-second "I built this" intro clip at the start, or keep it purely product?
4. **Aspect:** 4:5 feed version only, or also 16:9 for GitHub/YouTube?

## Effort estimate
- Remotion project setup + caption/transition components: small.
- Scenes 3–7 reuse real components: moderate (needs a small "director" layer to script clicks and state over time).
- Black-hole opener in three.js: moderate.
- Render: local, a few minutes per export.
