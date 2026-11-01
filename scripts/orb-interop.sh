#!/usr/bin/env bash
# Runs orb's client (crates/) against the app's real local bridge server (src-tauri).
# Usage: scripts/orb-interop.sh   (from the repo root; Linux/macOS/Git Bash)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$root/crates/target"
out="$root/crates/target/orb-interop.port"
rm -f "$out"
# The app's test writes "port token" here; it needs a native path on Windows.
out_native="$out"
command -v cygpath >/dev/null && out_native="$(cygpath -w "$out")"
# On Windows the app builds through scripts\cargo.cmd (MSVC env); ORB_PLAIN_CARGO=1 (CI) uses cargo.
if [[ "${OS:-}" == "Windows_NT" && -z "${ORB_PLAIN_CARGO:-}" ]]; then
  ( cd "$root" && ORB_INTEROP_OUT="$out_native" cmd //c "scripts\\cargo.cmd test orb_interop_server -- --ignored --nocapture" ) &
else
  ( cd "$root/src-tauri" && ORB_INTEROP_OUT="$out_native" cargo test orb_interop_server -- --ignored --nocapture ) &
fi
server=$!
# The first build of src-tauri can take a while.
for _ in $(seq 1 1800); do [[ -s "$out" ]] && break; sleep 1; done
[[ -s "$out" ]] || { echo "server did not start"; kill $server 2>/dev/null; exit 1; }
read -r port token < "$out"
status=0
( cd "$root/crates" && ORBIT_LOCAL_PORT="$port" ORBIT_LOCAL_TOKEN="$token" cargo test -p orbit-tui --test interop -- --ignored --nocapture ) || status=$?
kill $server 2>/dev/null || true
rm -f "$out"
exit $status
