// Dev helper: contact sheet of stills. node video/sheet.mjs out.png cols width file1 file2 ...
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [out, cols, width, ...files] = process.argv.slice(2);
const rows = Math.ceil(files.length / Number(cols));
const list = path.join(os.tmpdir(), "orbit-sheet.txt");
const lines = files.map((f) => `file '${path.resolve(f).split(path.sep).join("/")}'\nduration 1`);
fs.writeFileSync(list, lines.join("\n") + "\n");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", `scale=${width}:-1,tile=${cols}x${rows}:padding=6:color=0x333333`, "-frames:v", "1", out]);
console.log(out);
