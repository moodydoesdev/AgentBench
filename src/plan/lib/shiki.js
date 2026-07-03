// Shiki singleton: fine-grained core + JS regex engine (no oniguruma wasm),
// hand-picked languages, one dark + one light theme picked by app theme.
import { isLightTheme } from "./theme";

let highlighterPromise = null;

function loadHighlighter() {
  highlighterPromise ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] =
      await Promise.all([
        import("shiki/core"),
        import("@shikijs/engine-javascript"),
      ]);
    return createHighlighterCore({
      themes: [
        import("@shikijs/themes/vitesse-dark"),
        import("@shikijs/themes/vitesse-light"),
      ],
      langs: [
        import("@shikijs/langs/javascript"),
        import("@shikijs/langs/jsx"),
        import("@shikijs/langs/typescript"),
        import("@shikijs/langs/tsx"),
        import("@shikijs/langs/json"),
        import("@shikijs/langs/shellscript"),
        import("@shikijs/langs/rust"),
        import("@shikijs/langs/css"),
        import("@shikijs/langs/html"),
        import("@shikijs/langs/sql"),
        import("@shikijs/langs/python"),
        import("@shikijs/langs/diff"),
        import("@shikijs/langs/markdown"),
      ],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  })();
  return highlighterPromise;
}

const ALIASES = {
  js: "javascript",
  ts: "typescript",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  shell: "shellscript",
  py: "python",
  md: "markdown",
  mdx: "markdown",
};

/** Highlight to HTML; falls back to escaped plain text for unknown langs. */
export async function highlight(code, lang, { notedLines } = {}) {
  const hl = await loadHighlighter();
  const resolved = ALIASES[lang] ?? lang;
  const theme = isLightTheme() ? "vitesse-light" : "vitesse-dark";
  const noted = new Set(notedLines ?? []);
  try {
    return hl.codeToHtml(code, {
      lang: hl.getLoadedLanguages().includes(resolved) ? resolved : "text",
      theme,
      transformers: [
        {
          line(node, line) {
            if (noted.has(line)) this.addClassToHast(node, "plan-line-noted");
          },
        },
      ],
    });
  } catch {
    const esc = code
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return `<pre class="shiki"><code>${esc}</code></pre>`;
  }
}
