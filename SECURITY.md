# Security policy

## Reporting a vulnerability

Please report security issues privately using GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for something exploitable.

Include what you found, how to reproduce it, and the Orbit version. You can expect an acknowledgement within a few days; this is a one-person project, so fixes are best effort.

## What to know about Orbit's trust model

- Agents run unattended inside their worktree by default (Claude `bypassPermissions`, Codex `never` / `danger-full-access`) and can run any command your user account can. Settings > Agents lets you tighten this. Read-only profiles are enforced regardless.
- Skill packs installed from a git URL are executable instructions for those agents. Only install packs you trust.
- The mobile bridge is off by default. When enabled it listens on all network interfaces on the configured port; connections require pairing and are end-to-end encrypted. Turn it off when not in use, and keep the port behind your firewall.
- Orbit has no telemetry. Its state lives in `~/.orbit`.

Reports about any of the above being bypassed (for example a read-only profile that can write, or the bridge accepting unpaired devices) are in scope.
