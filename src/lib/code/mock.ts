import { emit } from "@tauri-apps/api/event";
import type { AgentEvent, CodeFsEvent, DirEntry, SearchMatch, SearchOptions } from "../ipc";

interface MockFile {
  text: string;
  dir: boolean;
  binary: boolean;
  mtime: number;
}
const revisions = new Map<string, Map<string, string>>();
const shells = new Map<string, { root: string; line: string }>();
const trees = new Map<string, Map<string, MockFile>>();
let clock = Date.now(),
  terminal = 0;
const tick = () => (clock = Math.max(Date.now(), clock + 1));
const ignored = (rel: string) => rel === "dist" || rel.startsWith("dist/");
const beneath = (p: string, parent: string) => p === parent || p.startsWith(`${parent}/`);
function safe(rel: string) {
  if (rel.startsWith("/") || rel.includes("\\") || rel.includes(":") || rel.split("/").some((s) => s === ".." || s === "."))
    throw new Error("Invalid relative path");
  return rel.replace(/\/$/, "");
}
function tree(root: string) {
  let files = trees.get(root);
  if (files) return files;
  files = new Map();
  trees.set(root, files);
  const seed: Record<string, string> = {
    "package.json":
      JSON.stringify(
        {
          name: "superset",
          private: true,
          scripts: { dev: "vite", build: "tsc && vite build" },
          dependencies: { react: "^19.1.0" },
        },
        null,
        2,
      ) + "\n",
    "README.md":
      "# Superset\n\nA focused workspace for your team.\n\n## Development\n\nRun `bun install`, then `bun run dev`.\n\n## Authentication\n\nSessions expire after 24 hours.\n",
    "src/main.ts":
      'import { restoreSession } from "./auth/session";\nimport "./styles.css";\n\nasync function main() {\n  const session = await restoreSession();\n  console.info("Welcome", session?.user.name ?? "guest");\n}\n\nvoid main();\n',
    "src/auth/session.ts":
      'export interface Session {\n  token: string;\n  user: { id: string; name: string };\n  expiresAt: number;\n}\n\nconst SESSION_KEY = "superset.session";\n\n/** Restore a session only while its token remains valid. */\nexport async function restoreSession(): Promise<Session | null> {\n  const raw = localStorage.getItem(SESSION_KEY);\n  if (!raw) return null;\n  const session: Session = JSON.parse(raw);\n  if (session.expiresAt < Date.now()) {\n    localStorage.removeItem(SESSION_KEY);\n    return null;\n  }\n  return session;\n}\n\nexport function signOut() {\n  localStorage.removeItem(SESSION_KEY);\n}\n',
    "src/components/Login.tsx":
      'import { useState } from "react";\n\nexport function Login() {\n  const [email, setEmail] = useState("");\n  return (\n    <form onSubmit={(event) => event.preventDefault()}>\n      <label htmlFor="email">Email address</label>\n      <input id="email" type="email" value={email}\n        onChange={(event) => setEmail(event.target.value)} />\n      <button type="submit">Continue</button>\n    </form>\n  );\n}\n',
    "src/styles.css":
      ":root {\n  font-family: Inter, sans-serif;\n  color-scheme: light dark;\n}\n\nbody { margin: 0; }\nbutton { cursor: pointer; }\n",
    "src-tauri/src/lib.rs":
      '#[tauri::command]\nfn greet(name: &str) -> String {\n    format!("Hello, {name}!")\n}\n\npub fn run() {\n    tauri::Builder::default()\n        .invoke_handler(tauri::generate_handler![greet])\n        .run(tauri::generate_context!())\n        .expect("error running application");\n}\n',
    ".gitignore": "node_modules/\ndist/\n.env\n",
    "dist/bundle.js": '(()=>{console.log("production bundle")})();\n',
    "logo.png": "\u0089PNG\u0000\u0001",
    "tsconfig.json": '{\n  "compilerOptions": { "strict": true, "target": "ES2022", "jsx": "react-jsx" }\n}\n',
    "config/app.toml": '[app]\nname = "Superset"\nport = 1420\n',
  };
  for (const [rel, text] of Object.entries(seed)) {
    const segments = rel.split("/");
    for (let i = 1; i < segments.length; i++)
      files.set(segments.slice(0, i).join("/"), { text: "", dir: true, binary: false, mtime: tick() });
    files.set(rel, { text, dir: false, binary: rel.endsWith(".png"), mtime: tick() });
  }
  const head = new Map<string, string>();
  for (const [rel, text] of Object.entries(seed)) {
    if (rel === "src/components/Login.tsx") continue;
    head.set(
      rel,
      rel === "README.md"
        ? text
            .replace("24 hours", "12 hours")
            .replace("A focused workspace for your team.\n", "A workspace for your team.\nLegacy documentation.\n")
        : rel === "src/main.ts"
          ? text
              .replace('  console.info("Welcome", session?.user.name ?? "guest");', "  console.log(session);")
              .replace("\nvoid main();", "\n// Start the app\nvoid main();")
          : text,
    );
  }
  revisions.set(root, head);
  return files;
}
function fs(root: string, paths: string[], kind: CodeFsEvent["kind"]) {
  setTimeout(() => void emit("code-fs", { root, paths, kind }), 0);
}

/** Exercise the same event/filesystem path as the desktop agents. */
export async function simulateCodeTurn(root: string, send: (event: AgentEvent) => void, stopped: () => boolean = () => false) {
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const files = tree(root);
  send({ type: "turnStarted" });
  const started = Date.now();
  const newRel = "agent-example.ts";
  const content = Array.from({ length: 30 }, (_, i) => `export const example${i + 1} = ${i + 1};`).join("\n") + "\n";
  const tasks = [
    { rel: newRel, name: "Write", input: { file_path: `${root}/${newRel}`, content }, text: content, stream: "content" },
    {
      rel: "src/auth/session.ts",
      name: "Edit",
      input: {
        file_path: `${root}/src/auth/session.ts`,
        old_string: "  return session;",
        new_string:
          "  // Keep the restored session available to the current workspace.\n  // A future refresh can renew its token before it expires.\n  return session;",
      },
      text: "",
      stream: "new_string",
    },
    { rel: "src/auth/session.ts", name: "Bash", input: { command: "bun run format" }, text: "", stream: "" },
  ];
  for (const [index, task] of tasks.entries()) {
    if (stopped()) return;
    const id = `live-${started}-${index}`,
      { rel, name } = task;
    const input = task.input as Record<string, unknown>;
    if (task.stream) {
      const value = input[task.stream] as string;
      for (let at = 0; at <= value.length; at += 25) {
        if (stopped()) return;
        send({ type: "toolDraft", id, name, input: { ...input, [task.stream]: value.slice(0, at) } });
        await pause(40);
      }
      send({ type: "toolDraft", id, name, input });
      await pause(40);
    }
    send({ type: "toolCall", id, name, input });
    await pause(100);
    if (stopped()) return;
    const old = files.get(rel);
    const text =
      name === "Write"
        ? task.text
        : name === "Edit"
          ? old!.text.replace(input.old_string as string, input.new_string as string)
          : old!.text + "\n// Formatted by Bash without draft events.\n";
    files.set(rel, { text, dir: false, binary: false, mtime: tick() });
    await emit("code-fs", { root, paths: [rel], kind: old ? "modify" : "create" });
    await pause(100);
    send({ type: "toolResult", id, output: "Updated file", isError: false });
    await pause(1700);
  }
  send({ type: "message", text: "Updated session handling, the app entry point, and the development notes." });
  send({ type: "turnCompleted", durationMs: Date.now() - started, costUsd: null, isError: false, error: null });
}
function glob(patterns: string, rel: string) {
  return patterns
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .some((pattern) => {
      const source = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "\u0000")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, ".")
        .replace(/\u0000/g, ".*");
      return (
        new RegExp(`^${source}$`).test(rel) || (!pattern.includes("/") && new RegExp(`^${source}$`).test(rel.split("/").pop()!))
      );
    });
}
export async function mockCodeCommand(cmd: string, args: unknown): Promise<unknown> {
  const a = (args ?? {}) as {
    root: string;
    cwd: string;
    rev: string;
    rel: string;
    from: string;
    to: string;
    dir: boolean;
    text: string;
    expectedMtime: number | null;
    query: string;
    options: SearchOptions;
    generation: number;
    id: string;
    data: string;
  };
  if (cmd === "pty_open") {
    const id = `mock-pty-${++terminal}`;
    shells.set(id, { root: a.cwd, line: "" });
    setTimeout(() => {
      if (shells.has(id)) void emit("pty-data", { id, data: `PS ${a.cwd.replace(/\//g, "\\")}> ` });
    }, 20);
    return id;
  }
  if (cmd === "pty_write") {
    const shell = shells.get(a.id);
    if (!shell) return null;
    let output = "";
    for (const char of a.data) {
      if (char === "\r" || char === "\n") {
        const command = shell.line.trim();
        shell.line = "";
        output += "\r\n";
        if (command.toLowerCase() === "exit") {
          if (output) await emit("pty-data", { id: a.id, data: output });
          shells.delete(a.id);
          await emit("pty-exit", { id: a.id, code: 0 });
          return null;
        }
        if (/^echo(?: |$)/i.test(command)) output += command.slice(5) + "\r\n";
        else if (/^(ls|dir)$/i.test(command))
          output += [...tree(shell.root).keys()].filter((p) => !p.includes("/")).join("  ") + "\r\n";
        else if (/^pwd$/i.test(command)) output += shell.root.replace(/\//g, "\\") + "\r\n";
        else if (command) output += `(mock shell) ${command}\r\n`;
        output += `PS ${shell.root.replace(/\//g, "\\")}> `;
      } else if (char === "\x7f" || char === "\b") {
        if (shell.line) {
          shell.line = Array.from(shell.line).slice(0, -1).join("");
          output += "\b \b";
        }
      } else if (char === "\x03") {
        shell.line = "";
        output += `^C\r\nPS ${shell.root.replace(/\//g, "\\")}> `;
      } else if (char >= " ") {
        shell.line += char;
        output += char;
      }
    }
    if (output) await emit("pty-data", { id: a.id, data: output });
    return null;
  }
  if (cmd === "pty_close") {
    shells.delete(a.id);
    return null;
  }
  if (cmd === "pty_resize" || cmd === "code_watch" || cmd === "code_unwatch") return null;
  const files = tree(a.root),
    rel = safe(a.rel ?? "");
  const file = () => {
    const f = files.get(rel);
    if (!f || f.dir) throw new Error(`File not found: ${rel}`);
    return f;
  };
  const parentExists = (p: string) => {
    const parent = p.split("/").slice(0, -1).join("/");
    if (parent && !files.get(parent)?.dir) throw new Error(`Folder not found: ${parent}`);
  };
  switch (cmd) {
    case "code_list_dir": {
      if (rel && !files.get(rel)?.dir) throw new Error(`Folder not found: ${rel}`);
      const prefix = rel ? `${rel}/` : "";
      return [...files]
        .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
        .map(
          ([p, f]): DirEntry => ({ rel: p, name: p.slice(prefix.length), dir: f.dir, ignored: ignored(p), size: f.text.length }),
        )
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    }
    case "code_read_file": {
      const f = file(),
        size = new TextEncoder().encode(f.text).length,
        tooLarge = size > 5 * 1024 * 1024;
      return { text: f.binary || tooLarge ? null : f.text, mtime: f.mtime, size, binary: f.binary, tooLarge };
    }
    case "code_write_file": {
      const f = file();
      if (a.expectedMtime != null && a.expectedMtime !== f.mtime) throw `conflict: ${rel} changed on disk`;
      f.text = a.text;
      f.mtime = tick();
      fs(a.root, [rel], "modify");
      return f.mtime;
    }
    case "code_create": {
      if (!rel || files.has(rel)) throw new Error("Entry already exists");
      parentExists(rel);
      files.set(rel, { text: "", dir: a.dir, binary: false, mtime: tick() });
      fs(a.root, [rel], "create");
      return null;
    }
    case "code_rename": {
      const from = safe(a.from),
        to = safe(a.to);
      if (!from || !to || !files.has(from) || files.has(to) || beneath(to, from)) throw new Error("Invalid rename destination");
      parentExists(to);
      for (const [p, f] of [...files])
        if (beneath(p, from)) {
          files.delete(p);
          files.set(to + p.slice(from.length), f);
        }
      fs(a.root, [from, to], "rename");
      return null;
    }
    case "code_delete": {
      if (!rel || !files.has(rel)) throw new Error("Entry not found");
      for (const p of files.keys()) if (beneath(p, rel)) files.delete(p);
      fs(a.root, [rel], "remove");
      return null;
    }
    case "code_list_files":
      return [...files]
        .filter(([p, f]) => !f.dir && !ignored(p))
        .map(([p]) => p)
        .sort();
    case "code_file_at": {
      const text = revisions.get(a.root)?.get(rel) ?? null;
      return text === null ? null : a.rev === "base" && rel === "README.md" ? text.replace("12 hours", "6 hours") : text;
    }
    case "code_search": {
      const matches: SearchMatch[] = [],
        o = a.options;
      if (!a.query) return { matches, truncated: false, generation: a.generation };
      let source = o.regex ? a.query : a.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (o.wholeWord) source = `\\b(?:${source})\\b`;
      const regex = new RegExp(source, o.caseSensitive ? "g" : "gi");
      for (const [p, f] of files) {
        if (f.dir || f.binary || ignored(p) || (o.include && !glob(o.include, p)) || (o.exclude && glob(o.exclude, p))) continue;
        for (const [index, line] of f.text.split("\n").entries()) {
          for (const match of line.matchAll(regex)) {
            if (matches.length === 2000) return { matches, truncated: true, generation: a.generation };
            matches.push({
              rel: p,
              line: index + 1,
              start: match.index,
              end: match.index + match[0].length,
              text: line.slice(0, 300),
            });
          }
        }
      }
      return { matches, truncated: false, generation: a.generation };
    }
    default:
      throw new Error(`Unknown Code command: ${cmd}`);
  }
}
