// Prepares a release: `bun run release 0.3.0`.
// Bumps the app version everywhere it lives (package.json, tauri.conf.json, Cargo.toml, Cargo.lock)
// and turns CHANGELOG.md's "## Unreleased" section into "## <version> - <today>" under a fresh,
// empty Unreleased heading. It only edits files; committing and tagging are printed as next steps.
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("usage: bun run release <major.minor.patch>");
  process.exit(1);
}

const read = (p) => readFileSync(p, "utf8");
const fail = (msg) => {
  console.error(`release: ${msg}`);
  process.exit(1);
};

// Uncommitted release notes are fine; anything else must be committed first.
const dirty = execSync("git status --porcelain", { encoding: "utf8" })
  .split("\n")
  .filter((l) => l.trim() && !l.endsWith("CHANGELOG.md"));
if (dirty.length) fail("working tree is not clean (only CHANGELOG.md may have changes)");
if (execSync("git tag -l v" + version, { encoding: "utf8" }).trim()) fail(`tag v${version} already exists`);

const pkg = JSON.parse(read("package.json"));
const current = pkg.version;
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};
if (!newer(version, current)) fail(`${version} is not newer than the current ${current}`);

// CHANGELOG first: refusing an empty Unreleased section before touching anything else.
const changelog = read("CHANGELOG.md");
const unreleased = changelog.match(/^## Unreleased\s*\n([\s\S]*?)(?=^## )/m);
if (!unreleased || !unreleased[1].trim()) fail("CHANGELOG.md has no notes under '## Unreleased'");
const today = new Date().toISOString().slice(0, 10);
writeFileSync(
  "CHANGELOG.md",
  changelog.replace(/^## Unreleased\s*\n/m, `## Unreleased\n\n## ${version} - ${today}\n\n`),
);

const replaceOnce = (path, pattern, replacement) => {
  const text = read(path);
  if (!pattern.test(text)) fail(`version not found in ${path}`);
  writeFileSync(path, text.replace(pattern, replacement));
};
replaceOnce("package.json", /("version":\s*")[^"]+(")/, `$1${version}$2`);
replaceOnce("src-tauri/tauri.conf.json", /("version":\s*")[^"]+(")/, `$1${version}$2`);
replaceOnce("src-tauri/Cargo.toml", /^(version\s*=\s*")[^"]+(")/m, `$1${version}$2`);
replaceOnce("src-tauri/Cargo.lock", /(name = "orbit"\r?\nversion = ")[^"]+(")/, `$1${version}$2`);

console.log(`Orbit ${current} → ${version}. Next:
  1. Review CHANGELOG.md, then run the release checks (bun run e2e, bun run e2e:github, cargo test).
  2. git commit -am "chore(release): v${version}"
  3. git tag -a v${version} -m "Orbit ${version}"
  4. git push origin main v${version}   (the Release workflow builds the installer into a draft release)`);
