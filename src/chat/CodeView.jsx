import { memo, useEffect, useMemo, useState } from "react";

// A read-only code viewer for tool cards: syntax-highlighted lines with an
// optional line-number gutter, diff tint and `$` prompt — the look of an
// editor pane, without any of the editing. Highlighting comes from the plan
// renderer's shiki singleton, imported lazily so it stays out of the entry
// chunk; until it loads (or if the language isn't shipped) plain text shows
// in the same layout, so nothing jumps.

const EXT = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  json: "json", jsonc: "json",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", command: "shellscript",
  rs: "rust", css: "css", html: "html", htm: "html", sql: "sql",
  py: "python", md: "markdown", mdx: "markdown", yml: "yaml", yaml: "yaml",
  toml: "toml", c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  go: "go", java: "java", swift: "swift", rb: "ruby", xml: "xml", plist: "xml", svg: "xml",
  ini: "ini", cfg: "ini", conf: "ini", kt: "kotlin", php: "php", lua: "lua",
  diff: "diff", patch: "diff",
};

/** Language for a file path, from its extension; null when we don't know. */
export function langFromPath(path) {
  if (!path) return null;
  const base = String(path).split(/[\\/]/).pop().toLowerCase();
  if (base === "dockerfile") return "shellscript";
  return EXT[/\.([a-z0-9]+)$/.exec(base)?.[1]] ?? null;
}

// Past this, tokenizing costs more than the colour is worth.
const MAX_HIGHLIGHT_CHARS = 150_000;

function useHighlighted(code, lang) {
  const [html, setHtml] = useState(null);
  useEffect(() => {
    setHtml(null);
    if (!lang || code.length > MAX_HIGHLIGHT_CHARS) return;
    let live = true;
    import("../plan/lib/shiki")
      .then((m) => m.highlightLines(code, lang))
      .then((h) => live && h && setHtml(h))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [code, lang]);
  return html;
}

/**
 * code:   the text
 * lang:   shiki language (see langFromPath), or null for plain
 * start:  first line number — shows a gutter when set
 * sign:   "+" / "-" — diff tint and marker on every line
 * prompt: show a `$ ` before the first line (shell commands)
 */
export default memo(function CodeView({ code, lang, start = null, sign = null, prompt = false, maxHeight = 420 }) {
  const lines = useMemo(() => code.replace(/\n$/, "").split("\n"), [code]);
  const html = useHighlighted(code.replace(/\n$/, ""), lang);
  const width = start != null ? String(start + lines.length - 1).length : 0;
  return (
    <div className="codeview" style={{ maxHeight }}>
      <div className="cv-inner">
        {lines.map((text, i) => (
          <div key={i} className={`cv-line${sign ? ` sign${sign === "+" ? "-add" : "-del"}` : ""}`}>
            {start != null && (
              <span className="cv-num" style={{ minWidth: `${width}ch` }}>
                {start + i}
              </span>
            )}
            {sign && <span className="cv-sign">{sign}</span>}
            {prompt && i === 0 && <span className="cv-prompt">$ </span>}
            {html?.[i] != null ? (
              <span className="cv-text" dangerouslySetInnerHTML={{ __html: html[i] }} />
            ) : (
              <span className="cv-text">{text}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
});
