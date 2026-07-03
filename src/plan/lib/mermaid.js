// Mermaid singleton, lazily imported so its chunk only loads when a plan
// actually contains a <Diagram/>. Mermaid can't resolve CSS var() — read the
// concrete values and re-initialize per render (cheap; render reads config).
import { themeVar, isLightTheme } from "./theme";

let mermaidPromise = null;
let renderSeq = 0;

export async function renderMermaid(code) {
  mermaidPromise ??= import("mermaid").then((m) => m.default);
  const mermaid = await mermaidPromise;
  const text = themeVar("--text");
  const dim = themeVar("--text-dim");
  const border = themeVar("--border");
  const panelHead = themeVar("--panel-head");
  mermaid.initialize({
    startOnLoad: false,
    theme: "base",
    darkMode: !isLightTheme(),
    fontFamily: themeVar("--font-ui") || "sans-serif",
    themeVariables: {
      background: themeVar("--panel"),
      primaryColor: panelHead,
      primaryTextColor: text,
      primaryBorderColor: border,
      secondaryColor: panelHead,
      tertiaryColor: panelHead,
      lineColor: dim,
      textColor: text,
      fontSize: "13px",
      clusterBkg: panelHead,
      clusterBorder: border,
      edgeLabelBackground: panelHead,
      actorBorder: border,
      actorBkg: panelHead,
      actorTextColor: text,
      noteBkgColor: panelHead,
      noteTextColor: text,
      noteBorderColor: border,
    },
  });
  // mermaid renders into an off-screen element it manages itself — safe even
  // when our container is scaled or hidden. Ids must be unique + CSS-safe.
  const { svg } = await mermaid.render(`plan-mmd-${++renderSeq}`, code.trim());
  return svg;
}
