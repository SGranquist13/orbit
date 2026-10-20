// Prepares a release: `bun run release 0.3.0`, run on `next` (the `/release` skill walks through the cycle).
// Bumps the app version everywhere it lives (package.json, tauri.conf.json, Cargo.toml, Cargo.lock),
// turns CHANGELOG.md's "## Unreleased" section into "## <version> - <today>" under a fresh, empty
// Unreleased heading, and showcases the release: the section's summary sentence goes in the README's
// "New in" line and the version in FEATURES.md's Platform row. It only edits files; merging, tagging
// and pushing are printed as next steps.
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

// Validate the release notes before touching any file.
const changelog = read("CHANGELOG.md");
const unreleased = changelog.match(/^## Unreleased\s*\n([\s\S]*?)(?=^## )/m);
if (!unreleased || !unreleased[1].trim()) fail("CHANGELOG.md has no notes under '## Unreleased'");
// The first plain paragraph is the release's one-line summary, shown in the README.
const summary = unreleased[1]
  .split(/\r?\n\s*\r?\n/)
  .map((p) => p.trim().replace(/\s*\r?\n\s*/g, " "))
  .find((p) => p && !p.startsWith("#") && !p.startsWith("-"));
if (!summary) fail("start '## Unreleased' with a one-sentence summary paragraph (it goes in the README)");

const edits = [
  ["package.json", /("version":\s*")[^"]+(")/, `$1${version}$2`],
  ["src-tauri/tauri.conf.json", /("version":\s*")[^"]+(")/, `$1${version}$2`],
  ["src-tauri/Cargo.toml", /^(version\s*=\s*")[^"]+(")/m, `$1${version}$2`],
  ["src-tauri/Cargo.lock", /(name = "orbit"\r?\nversion = ")[^"]+(")/, `$1${version}$2`],
  [
    "README.md",
    /(<!-- release:start[^>]*-->\r?\n)[\s\S]*?(\r?\n<!-- release:end -->)/,
    `$1**New in [v${version}](https://github.com/SGranquist13/orbit/releases/tag/v${version}):** ${summary.replace(/\$/g, "$$$$")}$2`,
  ],
  ["FEATURES.md", /Latest: v\d+\.\d+\.\d+/, `Latest: v${version}`],
];
for (const [path, pattern] of edits) if (!pattern.test(read(path))) fail(`release marker not found in ${path}`);

const today = new Date().toISOString().slice(0, 10);
writeFileSync(
  "CHANGELOG.md",
  changelog.replace(/^## Unreleased\s*\n/m, `## Unreleased\n\n## ${version} - ${today}\n\n`),
);
for (const [path, pattern, replacement] of edits) writeFileSync(path, read(path).replace(pattern, replacement));

console.log(`Orbit ${current} → ${version}. Next (see the /release skill):
  1. Review CHANGELOG.md and the README's "New in" line.
  2. git commit -am "chore(release): v${version}"
  3. git switch main && git merge --no-ff next -m "release: v${version}"
  4. git tag -a v${version} -m "Orbit ${version}"
  5. git switch next && git merge --ff-only main
  6. git push origin main next v${version}   (the Release workflow builds the installer into a draft release)
  7. Smoke-test the installer, then publish the draft release.`);
