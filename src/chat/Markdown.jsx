import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy } from "@phosphor-icons/react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@/lib/ipc";
import FileLink, { localPath } from "./FileLink";

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
  return (
    <div className="chat-code-wrap">
      {html == null ? (
        <pre className="chat-code-plain">
          <code>{code}</code>
        </pre>
      ) : (
        <div className="chat-code" dangerouslySetInnerHTML={markup} />
      )}
      <CopyButton text={code} />
    </div>
  );
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className={`chat-code-copy${copied ? " copied" : ""}`}
      title={copied ? "Copied" : "Copy"}
      aria-label="Copy code"
      onClick={() =>
        navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {})
      }
    >
      {copied ? <Check size={13} weight="bold" /> : <Copy size={13} />}
    </button>
  );
}

const components = {
  a: ({ href, children }) => {
    const path = localPath(href);
    if (path) return <FileLink path={path}>{children}</FileLink>;
    return (
    <a
      href={href}
      onClick={(ev) => {
        ev.preventDefault();
        if (href) openUrl(href).catch(() => {});
      }}
    >
      {children}
    </a>
    );
  },
  // `![alt](/abs/path.png)` — same handling as a link to a local file, which
  // shows pictures inline on web/phone and a file card elsewhere
  img: ({ src, alt }) => {
    const path = localPath(src);
    return path ? <FileLink path={path}>{alt || undefined}</FileLink> : <span>{alt}</span>;
  },
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

const urlTransform = (url) => (/^file:\/\//i.test(url) ? url : defaultUrlTransform(url));

// Assistant text renderer. Raw HTML stays disabled (react-markdown default) —
// agent output is untrusted. Links open in the OS browser, never the webview.
export default memo(function Markdown({ text }) {
  return (
    <div className="chat-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={urlTransform}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
