import { memo, useState, useEffect, useRef } from "react";
import { useTransport } from "../lib/TransportContext";
import {
  ArrowsClockwise,
  Check,
  FileText,
  Globe,
  ListChecks,
  MagnifyingGlass,
  PaperPlaneRight,
  PencilSimple,
  Robot,
  Terminal,
  Wrench,
} from "@phosphor-icons/react";
import { toolSummary, toolDiff } from "./records";

import { questionAnswerSteps, sendQuestionAnswer } from "../lib/questionAnswer";

const RESULT_CLAMP = 4000;

const TOOL_ICONS = {
  Bash: Terminal,
  Read: FileText,
  Edit: PencilSimple,
  Write: PencilSimple,
  NotebookEdit: PencilSimple,
  Grep: MagnifyingGlass,
  Glob: MagnifyingGlass,
  WebFetch: Globe,
  WebSearch: Globe,
  Task: Robot,
  Agent: Robot,
  TodoWrite: ListChecks,
};

// Answers drive an untouched Claude terminal picker; completion comes from the transcript.
function QuestionCard({ tool, paneId, canAnswer }) {
  const { invoke } = useTransport();
  const questions = Array.isArray(tool.input?.questions) ? tool.input.questions : [];
  // one entry per question: { pick: number|null, set: number[], other: string }
  const [state, setState] = useState(() =>
    questions.map(() => ({ pick: null, set: [], other: "" })),
  );
  const [sent, setSent] = useState(false);
  const [sendError, setSendError] = useState(null);
  const sendingRef = useRef(false);
  useEffect(() => {
    if (!sent || tool.done) return;
    const timer = setTimeout(() => {
      setSendError((previous) => previous || "Claude has not confirmed this answer. Open Term view to check the picker before sending again.");
    }, 15000);
    return () => clearTimeout(timer);
  }, [sent, tool.done]);

  const answerable =
    canAnswer &&
    !tool.done &&
    !sent &&
    questions.length > 0 &&
    questions.every((q) => Array.isArray(q.options));

  // choosing a listed option clears any "Other" text (they're exclusive)
  const chooseSingle = (i, j) =>
    setState((s) => s.map((e, k) => (k === i ? { ...e, pick: j, other: "" } : e)));
  const toggleMulti = (i, j) =>
    setState((s) =>
      s.map((e, k) => {
        if (k !== i) return e;
        const has = e.set.includes(j);
        return {
          ...e,
          set: has ? e.set.filter((x) => x !== j) : [...e.set, j],
          other: has ? e.other : "",
        };
      }),
    );
  const setOther = (i, text) =>
    setState((s) =>
      s.map((e, k) => (k === i ? { ...e, other: text, pick: null, set: [] } : e)),
    );

  const EMPTY = { pick: null, set: [], other: "" };
  const at = (i) => state[i] ?? EMPTY; // survive a late-arriving questions array
  const isAnswered = (q, e) =>
    e.other.trim() !== "" || (q.multiSelect ? e.set.length > 0 : e.pick != null);
  const allAnswered = questions.every((q, i) => isAnswered(q, at(i)));

  const submit = async () => {
    if (!answerable || !allAnswered || sendingRef.current) return;
    if (paneId == null) {
      setSendError("No terminal attached to this card — answer in Term view");
      return;
    }
    sendingRef.current = true;
    setSent(true);
    setSendError(null);
    try {
      await sendQuestionAnswer(invoke, paneId, questionAnswerSteps(questions, questions.map((_, i) => at(i))));
    } catch (err) {
      // Some keys may have arrived. Replaying from row zero could pick a
      // different answer, so keep the form locked and offer terminal recovery.
      setSendError(`Answer submission failed: ${String(err)}. Open Term view to check the picker.`);
    } finally {
      sendingRef.current = false;
    }
  };

  return (
    <div className="chat-question">
      {questions.map((q, i) => {
        const e = at(i);
        const multi = !!q.multiSelect;
        return (
          <div key={i} className="chat-question-block">
            <div className="chat-question-title">
              {q.question}
              {multi && <span className="chat-question-badge">select all</span>}
            </div>
            {Array.isArray(q.options) &&
              q.options.map((o, j) => {
                const on = multi ? e.set.includes(j) : e.pick === j;
                return (
                  <button
                    key={j}
                    className={`chat-question-opt choice${on ? " on" : ""}${answerable ? " clickable" : ""}`}
                    disabled={!answerable}
                    onClick={() => (multi ? toggleMulti(i, j) : chooseSingle(i, j))}
                  >
                    <span
                      className={`chat-question-mark ${multi ? "box" : "radio"}${on ? " on" : ""}`}
                    >
                      {on && <Check size={10} weight="bold" />}
                    </span>
                    <span className="chat-question-opt-label">{o.label}</span>
                    {o.description && (
                      <span className="chat-question-opt-desc">{o.description}</span>
                    )}
                  </button>
                );
              })}
            <input
              className="chat-question-other"
              placeholder="Other… (type a custom answer)"
              value={e.other}
              disabled={!answerable}
              onChange={(ev) => setOther(i, ev.target.value)}
              onKeyDown={(ev) => ev.stopPropagation()}
            />
          </div>
        );
      })}

      {tool.done ? (
        <div className="chat-question-answer">{tool.result}</div>
      ) : sent ? (
        <div className="chat-question-hint" role={sendError ? "alert" : "status"}>{sendError || "Waiting for Claude to confirm your answer…"}</div>
      ) : answerable ? (
        <div className="chat-question-foot">
          <span className="chat-question-hint">
            {sendError
              ? `send failed: ${sendError}`
              : "assumes the Term picker is untouched"}
          </span>
          <button
            className="chat-question-submit"
            disabled={!allAnswered}
            onClick={submit}
          >
            <PaperPlaneRight size={12} weight="fill" />
            Send answer{questions.length > 1 ? "s" : ""}
          </button>
        </div>
      ) : (
        <div className="chat-question-hint">
          waiting for your answer — switch to Term view to pick
        </div>
      )}
    </div>
  );
}

// Slim activity row, t3code-style: icon + summary + mono detail on one 12px
// line; click expands input/diff/result. Rows stack inside .chat-tools.
export default memo(
  function ToolCard({ tool, paneId, canAnswer }) {
    const [open, setOpen] = useState(false);
    if (tool.name === "AskUserQuestion")
      return <QuestionCard tool={tool} paneId={paneId} canAnswer={canAnswer} />;
    const { label, detail } = toolSummary(tool);
    const diff = open ? toolDiff(tool) : null;
    const status = !tool.done ? "running" : tool.isError ? "error" : "ok";
    const Icon = TOOL_ICONS[tool.name] ?? Wrench;

    const result =
      tool.result && tool.result.length > RESULT_CLAMP
        ? tool.result.slice(0, RESULT_CLAMP) + "\n… (truncated)"
        : tool.result;

    return (
      <div className={`chat-tool ${status}`}>
        <button className="chat-tool-row" onClick={() => setOpen((o) => !o)}>
          <span className="chat-tool-icon">
            {status === "running" ? (
              <ArrowsClockwise size={12} className="chat-tool-spin" />
            ) : (
              <Icon size={12} />
            )}
          </span>
          <span className="chat-tool-label">{label}</span>
          {detail && <span className="chat-tool-detail">{detail}</span>}
          {status === "error" && <span className="chat-tool-err">failed</span>}
        </button>
        {open && (
          <div className="chat-tool-body">
            {diff ? (
              <pre className="chat-tool-pre chat-diff">
                {diff.map((l, i) => (
                  <div key={i} className={l.sign === "+" ? "add" : "del"}>
                    <span className="sign">{l.sign}</span>
                    {l.text}
                  </div>
                ))}
              </pre>
            ) : (
              tool.input != null && (
                <pre className="chat-tool-pre">
                  {typeof tool.input === "string"
                    ? tool.input
                    : JSON.stringify(tool.input, null, 2)}
                </pre>
              )
            )}
            {result != null && result !== "" && (
              <pre
                className={`chat-tool-pre chat-tool-result${tool.isError ? " error" : ""}`}
              >
                {result}
              </pre>
            )}
          </div>
        )}
      </div>
    );
  },
  // tools mutate in place; the owning message's rev is the change signal
  (prev, next) => prev.tool === next.tool && prev.rev === next.rev,
);
