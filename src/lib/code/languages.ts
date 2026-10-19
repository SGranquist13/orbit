import type { Extension } from "@codemirror/state";

const languages: Record<string, string> = {
  rs: "rust",
  py: "python",
  json: "json",
  md: "markdown",
  css: "css",
  html: "html",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
};
export function languageForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) return "javascript";
  return languages[ext] ?? "plain";
}

export async function loadLanguage(path: string): Promise<Extension> {
  switch (languageForPath(path)) {
    case "javascript":
      return (await import("@codemirror/lang-javascript")).javascript({
        typescript: /\.[cm]?tsx?$/i.test(path),
        jsx: /\.[jt]sx$/i.test(path),
      });
    case "rust":
      return (await import("@codemirror/lang-rust")).rust();
    case "python":
      return (await import("@codemirror/lang-python")).python();
    case "json":
      return (await import("@codemirror/lang-json")).json();
    case "markdown":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "css":
      return (await import("@codemirror/lang-css")).css();
    case "html":
      return (await import("@codemirror/lang-html")).html();
    case "yaml":
      return (await import("@codemirror/lang-yaml")).yaml();
    case "toml": {
      const [{ StreamLanguage }, { toml }] = await Promise.all([
        import("@codemirror/language"),
        import("@codemirror/legacy-modes/mode/toml"),
      ]);
      return StreamLanguage.define(toml);
    }
    default:
      return [];
  }
}
