#!/usr/bin/env python3
"""End-to-end check of the real `orb` binary in a pseudo-terminal (Linux/macOS).

Drives `orb --demo` through every feature with real key bytes and reads the screen back with a
terminal emulator (pyte), asserting what should be visible at each step.

    pip install pyte
    cd crates && cargo build --release
    python3 orbit-tui/e2e/demo_e2e.py target/release/orb
"""
import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

import pyte

BIN = sys.argv[1] if len(sys.argv) > 1 else "target/release/orb"
W, H = 120, 36

CTRL = lambda c: bytes([ord(c) & 0x1F])  # noqa: E731
ESC = b"\x1b"
ENTER = b"\r"
TAB = b"\t"
DOWN = b"\x1b[B"
ALT = lambda c: b"\x1b" + c.encode()  # noqa: E731

screen = pyte.Screen(W, H)
stream = pyte.ByteStream(screen)
pid, fd = pty.fork()
if pid == 0:
    os.environ.update(TERM="xterm-256color", COLORTERM="truecolor", ORBIT_HOME="/tmp/orb-e2e-home")
    os.execv(BIN, [BIN, "--demo"])


def set_size(w, h):
    screen.resize(h, w)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", h, w, 0, 0))


set_size(W, H)
raw = bytearray()


def pump(t):
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if not r:
            continue
        try:
            d = os.read(fd, 65536)
        except OSError:
            return
        raw.extend(d)
        stream.feed(d)
        # Answer the terminal queries crossterm makes.
        if b"\x1b[6n" in d:
            os.write(fd, b"\x1b[1;1R")
        if b"\x1b[c" in d:
            os.write(fd, b"\x1b[?62c")


def text():
    return "\n".join(line.rstrip() for line in screen.display)


passed = 0


def expect(what, timeout=6.0, step=""):
    global passed
    end = time.time() + timeout
    while time.time() < end:
        pump(0.1)
        if re.search(what, text(), re.M):
            passed += 1
            print(f"  ✓ {step or what}")
            return
    print(f"  ✗ {step or what}: not on screen after {timeout}s\n{text()}")
    os.kill(pid, signal.SIGKILL)
    sys.exit(1)


def absent(what, step=""):
    global passed
    pump(0.3)
    if re.search(what, text(), re.M):
        print(f"  ✗ {step}: {what!r} is still on screen\n{text()}")
        os.kill(pid, signal.SIGKILL)
        sys.exit(1)
    passed += 1
    print(f"  ✓ {step}")


def send(*keys, wait=0.25):
    for k in keys:
        os.write(fd, k if isinstance(k, bytes) else k.encode())
        pump(wait)


print("start")
expect(r"Inbox · \d+ need you", step="opens on the Inbox (something needs you)")
expect(r"Checks failing: 1 of 4", step="PR state fetched at startup")
send("?")
expect(r"Keys", step="? shows key help")
send(ESC)
absent(r"╭─ Keys", step="esc closes it")

print("chat")
send(ENTER)
expect(r"readme-badge · claude haiku", step="enter opens the selected workspace")
send(CTRL("p"), "profile", wait=0.1)
send(ENTER)
expect(r"╭─ Profile", step="palette → Switch profile…")
send(DOWN, DOWN, ENTER)
expect(r"planner\s*$", step="profile switched (chips row shows it)")
send("hello there", wait=0.05)
send(ENTER)
expect(r"On it: hello there", step="message sent and streaming")
expect(r"Want me to ship it\?", timeout=20, step="turn finished")
send("/")
expect(r"skills · shipkit", step="/ opens skills")
send("pre", wait=0.05)
send(ENTER)
expect(r"Ran preflight", timeout=15, step="skill ran")
send("\x1b[200~pasted text\x1b[201~")
expect(r"▎ pasted text", step="bracketed paste lands in the input")
send(CTRL("c"))
absent(r"▎ pasted text", step="ctrl+c clears the input")

print("ship")
send(CTRL("s"))
expect(r"Ship · readme-badge → main", step="ctrl+s opens Ship")
expect(r"#42", timeout=15, step="PR opened by the agent")
expect(r"Ready to merge\.", timeout=20, step="checks pass")
send("m")
expect(r"Merge #42 into main\?", step="m asks to merge")
send("y")
expect(r"Merged #42 into main", timeout=5, step="merged")
send(ESC)

print("review")
send(ALT("3"))
expect(r"Review · readme-badge · vs main", step="alt+3 opens Review")
expect(r"@@ ", step="diff shows")
send("c")
send("Use a shorter alt text", wait=0.03)
send(ENTER)
expect(r"✎ Use a shorter alt text", step="comment drafted under the line")
expect(r"1 comment · enter send", step="draft count")
send(ENTER)
expect(r"Send 1 comment to readme-badge\?", step="enter asks to send")
send("y")
expect(r"Review comments", timeout=5, step="sent to the agent as a message")

print("palette, new workspace")
send(CTRL("p"))
expect(r"╭─ Actions", step="ctrl+p opens the palette")
send("new", wait=0.05)
send(ENTER)
expect(r"╭─ New workspace", step="New workspace dialog")
send("Add tests for the badge", wait=0.03)
send(CTRL("s"))
expect(r"add-tests-for-the-badge", timeout=5, step="created and opened")
expect(r"On it: Add tests for the badge", timeout=10, step="its first turn runs")
send(ESC)
expect(r"● stopped", timeout=5, step="esc stops the running agent")

print("switch, stop, rail")
send(CTRL("k"), "fix-l", wait=0.05)
send(ENTER)
expect(r"fix-login · claude sonnet", step="ctrl+k switches")
send(TAB)
expect(r"x archive", step="tab focuses the rail")
send(ESC, CTRL("b"))
absent(r"^ orbit\b", step="ctrl+b hides the rail")
send(CTRL("b"))

print("archive")
send(CTRL("x"), "2")
expect(r"Inbox ·", step="ctrl+x 2 → Inbox")
before = text().count("●")
send("x")
expect(r"Archive .*\? Its worktree is removed\.", step="x asks to archive")
send("y")
pump(1)
if "uncommitted changes" in text():
    print("  ✓ uncommitted changes → asks again")
    passed += 1
    send("y")
expect(r"Archived ", timeout=5, step="archived")

print("resize")
set_size(90, 30)
expect(r"Inbox ·", step="resized to 90×30")
send(ALT("1"))
absent(r"needs you\s*│", step="rail auto-hides under 100 columns")
set_size(50, 12)
expect(r"Orbit needs at least 60×16", step="too small → message")
set_size(W, H)
expect(r"^ orbit\b", step="back to full size, rail returns")

print("theme")
send(CTRL("p"), "paper", wait=0.05)
send(ENTER)
pump(0.5)
# The input box (raised) is painted with Paper's #fbfbfa; Void's is #121215.
bg = screen.buffer[H - 3][60].bg
assert bg.lower() == "fbfbfa", f"input background {bg}"
print(f"  ✓ theme switched to Paper (input background #{bg})")
passed += 1

print("quit")
send(CTRL("c"))
expect(r"Press Ctrl\+C again to quit", step="first ctrl+c warns")
send(CTRL("c"), wait=0.1)
pump(1)
_, status = os.waitpid(pid, 0)
code = os.waitstatus_to_exitcode(status)
assert code == 0, f"exit code {code}"
assert b"\x1b[?1049l" in raw, "left the alternate screen"
print(f"  ✓ quit cleanly (exit 0, terminal restored)")
passed += 1
print(f"\nall {passed} checks passed")
