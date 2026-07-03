import { useEffect, useMemo, useState } from "react";
import { renderMermaid } from "../lib/mermaid";
import { useThemeVersion } from "../lib/theme";

export function Diagram({ code = "", title }) {
  const themeV = useThemeVersion();
  const [state, setState] = useState({ svg: null, error: null });
  // Stable markup object: a fresh `{ __html }` every render makes React 19
  // rewrite innerHTML even when the string is identical — WebKit then
  // relayouts and clamps the reader's scroll (no scroll anchoring there).
  const markup = useMemo(() => ({ __html: state.svg }), [state.svg]);

  useEffect(() => {
    let alive = true;
    renderMermaid(code)
      .then((svg) => alive && setState({ svg, error: null }))
      .catch((e) => alive && setState({ svg: null, error: e }));
    return () => {
      alive = false;
    };
  }, [code, themeV]);

  return (
    <figure className="plan-diagram">
      {title && <figcaption className="plan-block-title">{title}</figcaption>}
      {state.error ? (
        <pre className="plan-code-plain plan-diagram-error">
          diagram error: {String(state.error.message || state.error)}
          {"\n\n"}
          {code.trim()}
        </pre>
      ) : state.svg ? (
        <div className="plan-diagram-svg" dangerouslySetInnerHTML={markup} />
      ) : (
        <div className="plan-diagram-loading">rendering…</div>
      )}
    </figure>
  );
}
