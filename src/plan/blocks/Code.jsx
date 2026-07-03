// Code, AnnotatedCode and Diff share the shiki singleton. Fenced markdown
// code blocks are routed here via the registry's `pre` override. Long blocks
// collapse with a "show more" expander so plans stay scannable.
import { useEffect, useMemo, useState } from "react";
import { CaretDown } from "@phosphor-icons/react";
import { highlight } from "../lib/shiki";
import { useThemeVersion } from "../lib/theme";

const COLLAPSED_LINES = 24;

function useCollapse(code) {
  const [open, setOpen] = useState(false);
  const lines = code.split("\n");
  const collapsible = lines.length > COLLAPSED_LINES + 4;
  const visible =
    collapsible && !open ? lines.slice(0, COLLAPSED_LINES).join("\n") : code;
  const hidden = lines.length - COLLAPSED_LINES;
  const expander =
    collapsible && !open ? (
      <button type="button" className="plan-expand" onClick={() => setOpen(true)}>
        <CaretDown size={11} weight="bold" /> Show {hidden} more line
        {hidden === 1 ? "" : "s"}
      </button>
    ) : null;
  return { visible, expander };
}

function Highlighted({ code, lang, notedLines }) {
  const themeV = useThemeVersion();
  const [html, setHtml] = useState(null);
  // Stable markup object — see Diagram.jsx: fresh `{ __html }` objects make
  // React 19 rewrite innerHTML per render, which yanks scroll in WebKit.
  const markup = useMemo(() => ({ __html: html }), [html]);

  useEffect(() => {
    let alive = true;
    highlight(code, lang, { notedLines }).then((h) => {
      if (alive) setHtml(h);
    });
    return () => {
      alive = false;
    };
  }, [code, lang, themeV, notedLines?.join()]);

  if (html == null) {
    return (
      <pre className="plan-code-plain">
        <code>{code}</code>
      </pre>
    );
  }
  return <div className="plan-code-html" dangerouslySetInnerHTML={markup} />;
}

export function Code({ code = "", lang = "text", file }) {
  const clean = String(code).replace(/^\n/, "").replace(/\n$/, "");
  const { visible, expander } = useCollapse(clean);
  return (
    <figure className="plan-code">
      {file && <figcaption className="plan-code-file">{file}</figcaption>}
      <Highlighted code={visible} lang={lang} />
      {expander}
    </figure>
  );
}

export function AnnotatedCode({ code = "", lang = "text", file, notes = [] }) {
  const clean = String(code).replace(/^\n/, "").replace(/\n$/, "");
  const notedLines = notes.map((n) => n.line);
  return (
    <figure className="plan-code">
      {file && <figcaption className="plan-code-file">{file}</figcaption>}
      <Highlighted code={clean} lang={lang} notedLines={notedLines} />
      {notes.length > 0 && (
        <ol className="plan-code-notes">
          {notes.map((n, i) => (
            <li key={i}>
              <span className="plan-code-noteline">L{n.line}</span> {n.text}
            </li>
          ))}
        </ol>
      )}
    </figure>
  );
}

export function Diff({ code = "", file }) {
  const lines = String(code).replace(/^\n/, "").replace(/\n$/, "").split("\n");
  return (
    <figure className="plan-code plan-diff">
      {file && <figcaption className="plan-code-file">{file}</figcaption>}
      <pre className="plan-code-plain">
        {lines.map((l, i) => (
          <div
            key={i}
            className={
              l.startsWith("+")
                ? "plan-diff-add"
                : l.startsWith("-")
                  ? "plan-diff-del"
                  : "plan-diff-ctx"
            }
          >
            {l || " "}
          </div>
        ))}
      </pre>
    </figure>
  );
}
