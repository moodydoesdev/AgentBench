import { memo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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

// AskUserQuestion is a picker in the terminal TUI — the transcript only has
// the questions (input) and, once answered, the answers (result). We render a
// real form (radios for single-select, checkboxes for multi-select, plus an
// "Other" free-text field) and answer by driving the picker with keystrokes:
//   single-select  → ↓×index, Enter
//   multi-select   → ↓ to each choice + Space to toggle, then Enter
//   Other          → ↓ to the trailing "Other" row, Enter, type text, Enter
// Questions are answered in order; the picker resets to the top row for each,
// so per-question navigation is relative to row 0. This assumes an untouched
// picker — if you already arrowed around in Term view the cursor has moved,
// so the card says as much.
const DOWN = "\x1b[B";
const ENTER = "\r";
const SPACE = " ";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function QuestionCard({ tool, paneId, canAnswer }) {
  const questions = Array.isArray(tool.input?.questions) ? tool.input.questions : [];
  // one entry per question: { pick: number|null, set: number[], other: string }
  const [state, setState] = useState(() =>
    questions.map(() => ({ pick: null, set: [], other: "" })),
  );
  const [sent, setSent] = useState(false);

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

  // key steps for one question — an array so "Other" can pace its mode switch
  const stepsFor = (q, e) => {
    const L = q.options.length;
    if (e.other.trim()) {
      return [DOWN.repeat(L) + ENTER, e.other.trim() + ENTER];
    }
    if (q.multiSelect) {
      let keys = "";
      let pos = 0;
      for (const t of [...e.set].sort((a, b) => a - b)) {
        keys += DOWN.repeat(t - pos) + SPACE;
        pos = t;
      }
      return [keys + ENTER];
    }
    return [DOWN.repeat(e.pick ?? 0) + ENTER];
  };

  const submit = async () => {
    if (!answerable || !allAnswered) return;
    setSent(true);
    // paced so the TUI consumes each Enter (and any list→text mode switch)
    // before the next burst arrives
    for (let i = 0; i < questions.length; i++) {
      for (const keys of stepsFor(questions[i], at(i))) {
        invoke("write_pane", { id: paneId, data: keys }).catch(() => {});
        await sleep(160);
      }
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
        <div className="chat-question-hint">answer sent…</div>
      ) : answerable ? (
        <div className="chat-question-foot">
          <span className="chat-question-hint">
            assumes the Term picker is untouched
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
