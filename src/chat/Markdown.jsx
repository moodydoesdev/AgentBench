import { memo, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";

// Fenced blocks highlight through the plan renderer's shiki singleton —
// imported dynamically so shiki stays out of the entry chunk (same reason
// PlanOverlay is lazy). Until (or unless) it loads, plain mono renders.
function CodeBlock({ lang, code }) {
  const [html, setHtml] = useState(null);
  const markup = useMemo(() => ({ __html: html }), [html]);
  useEffect(() => {
    let live = true;
    import("../plan/lib/shiki")
      .then((m) => m.highlight(code, lang))
      .then((h) => live && setHtml(h))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [code, lang]);
  if (html == null) {
    return (
      <pre className="chat-code-plain">
        <code>{code}</code>
      </pre>
    );
  }
  return <div className="chat-code" dangerouslySetInnerHTML={markup} />;
}

const components = {
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(ev) => {
        ev.preventDefault();
        if (href) openUrl(href).catch(() => {});
      }}
    >
      {children}
    </a>
  ),
  // fenced blocks render via CodeBlock; unwrap the default <pre> so shiki's
  // own <pre> isn't nested inside another one
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children, ...props }) => {
    const m = /language-([\w-]+)/.exec(className || "");
    const text = String(children).replace(/\n$/, "");
    if (m || text.includes("\n")) {
      return <CodeBlock lang={m?.[1] ?? "text"} code={text} />;
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
};

// Assistant text renderer. Raw HTML stays disabled (react-markdown default) —
// agent output is untrusted. Links open in the OS browser, never the webview.
export default memo(function Markdown({ text }) {
  return (
    <div className="chat-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
