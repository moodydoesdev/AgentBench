// Text-selection commenting: select prose in the plan → floating "Comment"
// bubble → small composer anchored at the selection. Comments collect in the
// ApproveBar (via the feedback context) until sent.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChatCircleText } from "@phosphor-icons/react";
import { useFeedback } from "./feedback";

export default function CommentLayer({ articleRef }) {
  const fb = useFeedback();
  const [menu, setMenu] = useState(null); // {x, y, quote}
  const [compose, setCompose] = useState(null); // {x, y, quote}
  const [text, setText] = useState("");

  useEffect(() => {
    const onMouseUp = (e) => {
      if (e.target.closest?.(".plan-select-menu, .plan-comment-pop")) return;
      // let the browser settle the selection first
      requestAnimationFrame(() => {
        const sel = window.getSelection();
        const article = articleRef.current;
        if (
          !sel ||
          sel.isCollapsed ||
          !article ||
          !article.contains(sel.anchorNode)
        ) {
          setMenu(null);
          return;
        }
        const quote = sel.toString().trim();
        if (!quote) {
          setMenu(null);
          return;
        }
        const r = sel.getRangeAt(0).getBoundingClientRect();
        setMenu({ x: r.left + r.width / 2, y: r.top, quote });
      });
    };
    const onMouseDown = (e) => {
      if (e.target.closest?.(".plan-select-menu, .plan-comment-pop")) return;
      setMenu(null);
      setCompose(null);
    };
    const onScroll = () => setMenu(null); // bubble follows nothing; just hide
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [articleRef]);

  const startCompose = () => {
    setCompose({ ...menu });
    setMenu(null);
    setText("");
  };

  const submit = () => {
    if (!text.trim() || !compose) return;
    fb?.addComment(compose.quote, text.trim());
    setCompose(null);
    setText("");
    window.getSelection()?.removeAllRanges();
  };

  return createPortal(
    <>
      {menu && (
        <button
          type="button"
          className="plan-select-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={startCompose}
        >
          <ChatCircleText size={13} weight="bold" /> Comment
        </button>
      )}
      {compose && (
        <div
          className="plan-comment-pop"
          style={{ left: compose.x, top: compose.y }}
        >
          <div className="plan-comment-pop-quote">
            “{compose.quote.replace(/\s+/g, " ").slice(0, 90)}
            {compose.quote.length > 90 ? "…" : ""}”
          </div>
          <textarea
            autoFocus
            placeholder="Your comment…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
              if (e.key === "Escape") setCompose(null);
            }}
          />
          <div className="plan-comment-pop-row">
            <button
              type="button"
              className="plan-btn"
              onClick={() => setCompose(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="plan-btn primary"
              disabled={!text.trim()}
              onClick={submit}
            >
              Add comment
            </button>
          </div>
        </div>
      )}
    </>,
    document.body,
  );
}
