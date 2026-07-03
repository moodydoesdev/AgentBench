// Collects answers from interactive blocks (QuestionForm/Checklist/Options)
// plus text-selection comments, and serializes them into the [plan-feedback]
// message typed into the owning agent's terminal.
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { PaperPlaneRight, Check, X } from "@phosphor-icons/react";

const FeedbackCtx = createContext(null);

let commentSeq = 0;

export function PlanFeedbackProvider({ children }) {
  const [entries, setEntries] = useState({}); // id -> {label, value, answered}
  const [comments, setComments] = useState([]); // {id, quote, text}

  const report = useCallback((id, entry) => {
    setEntries((e) => ({ ...e, [id]: entry }));
  }, []);

  const addComment = useCallback((quote, text) => {
    setComments((c) => [...c, { id: ++commentSeq, quote, text }]);
  }, []);

  const removeComment = useCallback((id) => {
    setComments((c) => c.filter((x) => x.id !== id));
  }, []);

  const value = useMemo(
    () => ({ entries, report, comments, addComment, removeComment }),
    [entries, report, comments, addComment, removeComment],
  );
  return <FeedbackCtx.Provider value={value}>{children}</FeedbackCtx.Provider>;
}

// null outside a provider so blocks also render in isolation
export function useFeedback() {
  return useContext(FeedbackCtx);
}

const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

function serialize(title, verdict, entries, note, instruction, comments) {
  const lines = [`[plan-feedback] ${verdict} — "${title}"`];
  for (const { label, value, answered } of Object.values(entries)) {
    if (value != null && value !== "") {
      lines.push(`- ${label}: ${value}`);
    } else if (answered === false) {
      lines.push(`- ${label}: (unanswered)`);
    }
  }
  if (comments?.length) {
    lines.push("Comments on the plan text:");
    for (const c of comments) {
      lines.push(`- On "${trunc(c.quote.replace(/\s+/g, " "), 120)}": ${c.text}`);
    }
  }
  if (note?.trim()) lines.push(`Note: ${note.trim()}`);
  if (instruction) lines.push(instruction);
  return lines.join("\n");
}

export function ApproveBar({ title, onSend }) {
  const { entries, comments, removeComment } = useFeedback();
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [sent, setSent] = useState(null); // "approved" | "changes" | "answers" | "comments"

  const all = Object.values(entries);
  const answered = all.filter((e) => e.answered).length;

  const send = (verdict, label, instruction) => {
    onSend(serialize(title, verdict, entries, note, instruction, comments));
    setSent(label);
    setNoteOpen(false);
  };

  return (
    <div className="plan-approve">
      {comments.length > 0 && (
        <div className="plan-comments">
          {comments.map((c) => (
            <div key={c.id} className="plan-comment">
              <span className="plan-comment-quote">
                “{trunc(c.quote.replace(/\s+/g, " "), 48)}”
              </span>
              <span className="plan-comment-text">{c.text}</span>
              <button
                className="plan-comment-x"
                title="Remove comment"
                onClick={() => removeComment(c.id)}
              >
                <X size={11} weight="bold" />
              </button>
            </div>
          ))}
        </div>
      )}
      {noteOpen && (
        <textarea
          className="plan-note"
          placeholder="What should change?"
          value={note}
          autoFocus
          onChange={(e) => setNote(e.target.value)}
        />
      )}
      <div className="plan-approve-row">
        <span className="plan-approve-count">
          {all.length > 0 && `${answered}/${all.length} answered`}
          {sent === "approved" && " · approved ✓"}
          {sent === "changes" && " · feedback sent"}
          {sent === "answers" && " · sent — agent is revising"}
        </span>
        {noteOpen ? (
          <>
            <button className="plan-btn" onClick={() => setNoteOpen(false)}>
              Cancel
            </button>
            <button
              className="plan-btn primary"
              disabled={!note.trim()}
              onClick={() =>
                send(
                  "CHANGES REQUESTED",
                  "changes",
                  "Revise the plan per this feedback and re-publish it. Do not start implementing.",
                )
              }
            >
              <PaperPlaneRight size={12} weight="bold" /> Send
            </button>
          </>
        ) : (
          <>
            {comments.length > 0 && (
              <button
                className="plan-btn primary"
                title="Send your comments — the agent addresses them and re-publishes"
                onClick={() =>
                  send(
                    "COMMENTS",
                    "comments",
                    "Address these comments: update the plan and re-publish it. Do not start implementing — wait for approval.",
                  )
                }
              >
                <PaperPlaneRight size={12} weight="bold" /> Send{" "}
                {comments.length} comment{comments.length === 1 ? "" : "s"}
              </button>
            )}
            <button
              className="plan-btn"
              disabled={answered === 0}
              title={
                answered === 0
                  ? "Answer a question first"
                  : "Send your answers — the agent updates the plan, no approval yet"
              }
              onClick={() =>
                send(
                  "ANSWERS",
                  "answers",
                  "Update the plan to reflect these answers and re-publish it. Do not start implementing — wait for approval.",
                )
              }
            >
              <PaperPlaneRight size={12} weight="bold" /> Send answers
            </button>
            <button className="plan-btn" onClick={() => setNoteOpen(true)}>
              Request changes…
            </button>
            <button
              className="plan-btn approve"
              onClick={() =>
                send(
                  "APPROVED",
                  "approved",
                  "Proceed with the implementation as planned.",
                )
              }
            >
              <Check size={12} weight="bold" /> Approve
            </button>
          </>
        )}
      </div>
    </div>
  );
}
