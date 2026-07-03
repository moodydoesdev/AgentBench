import { Component, useEffect, useMemo, useRef, useState } from "react";
import { useMdx } from "./lib/useMdx";
import { HeroSlotCtx } from "./lib/heroSlot";
import { registry } from "./registry";
import { PlanFeedbackProvider, ApproveBar } from "./feedback";
import CommentLayer from "./CommentLayer";

function PlanError({ error, source }) {
  const place = error?.line ? ` (line ${error.line}:${error.column ?? 0})` : "";
  return (
    <div className="plan-error">
      <div className="plan-error-head">Plan failed to render{place}</div>
      <pre className="plan-error-msg">{String(error?.message ?? error)}</pre>
      {source && (
        <details>
          <summary>Plan source</summary>
          <pre className="plan-code-plain">{source}</pre>
        </details>
      )}
    </div>
  );
}

class ErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return <PlanError error={this.state.error} source={this.props.source} />;
    }
    return this.props.children;
  }
}

// djb2 — cheap content hash to key the boundary so recompiles reset it
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h;
}

// "On this plan" — sticky heading index, shown only when the pane is wide.
function Toc({ articleRef, contentKey }) {
  const [items, setItems] = useState([]);

  useEffect(() => {
    const el = articleRef.current;
    if (!el) return;
    setItems(
      [...el.querySelectorAll("h2, h3")].map((h) => ({
        level: h.tagName === "H2" ? 2 : 3,
        text: h.textContent,
        node: h,
      })),
    );
  }, [contentKey]);

  if (items.length < 2) return null;
  return (
    <nav className="plan-toc">
      <div className="plan-toc-inner">
        <div className="plan-toc-head">On this plan</div>
        {items.map((it, i) => (
          <button
            key={i}
            type="button"
            className={`plan-toc-item lvl-${it.level}`}
            onClick={() =>
              it.node.scrollIntoView({ behavior: "smooth", block: "start" })
            }
          >
            {it.text}
          </button>
        ))}
      </div>
    </nav>
  );
}

export default function PlanRenderer({ source, title, onSend }) {
  const mdx = useMdx(source);
  const articleRef = useRef(null);
  const [heroEl, setHeroEl] = useState(null);
  const key = source == null ? 0 : hash(source);
  // one hero claim per compiled document
  const heroSlot = useMemo(() => {
    const state = { claimed: false };
    return {
      el: null,
      claim: () => {
        if (state.claimed) return false;
        state.claimed = true;
        return true;
      },
    };
  }, [key]);
  heroSlot.el = heroEl;

  if (mdx.status === "loading") {
    return <div className="plan-loading">loading plan…</div>;
  }
  if (mdx.status === "error") {
    return <PlanError error={mdx.error} source={source} />;
  }
  const { Content } = mdx;
  return (
    <PlanFeedbackProvider>
      <ErrorBoundary key={key} source={source}>
        <HeroSlotCtx.Provider value={heroSlot}>
          <div className="plan-hero" ref={setHeroEl} />
          <div className="plan-doc-wrap">
            <article ref={articleRef} className="plan-doc">
              <Content components={registry} />
            </article>
            <Toc articleRef={articleRef} contentKey={key} />
            <CommentLayer articleRef={articleRef} />
          </div>
        </HeroSlotCtx.Provider>
      </ErrorBoundary>
      <ApproveBar title={title} onSend={onSend} />
    </PlanFeedbackProvider>
  );
}
