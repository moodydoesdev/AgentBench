import { memo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowsClockwise,
  FileText,
  Globe,
  ListChecks,
  MagnifyingGlass,
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
// the questions (input) and, once answered, the answers (result). Render a
// real question card, and for a single single-select question, answer it
// from chat by driving the picker: N×↓ then Enter. (The picker starts on
// option 1; if the user already arrowed around in Term view, the indices
// are off — the card notes that clicking assumes an untouched picker.)
function QuestionCard({ tool, paneId, canAnswer }) {
  const [picked, setPicked] = useState(null);
  const questions = Array.isArray(tool.input?.questions) ? tool.input.questions : [];
  const clickable =
    canAnswer &&
    !tool.done &&
    picked == null &&
    questions.length === 1 &&
    !questions[0]?.multiSelect &&
    Array.isArray(questions[0]?.options);

  const answer = (j) => {
    setPicked(j);
    const keys = "\x1b[B".repeat(j) + "\r";
    invoke("write_pane", { id: paneId, data: keys }).catch(() => {});
  };

  return (
    <div className="chat-question">
      {questions.map((q, i) => (
        <div key={i} className="chat-question-block">
          <div className="chat-question-title">{q.question}</div>
          {Array.isArray(q.options) &&
            q.options.map((o, j) =>
              clickable ? (
                <button
                  key={j}
                  className="chat-question-opt clickable"
                  onClick={() => answer(j)}
                >
                  <span className="chat-question-opt-label">{o.label}</span>
                  {o.description && (
                    <span className="chat-question-opt-desc">{o.description}</span>
                  )}
                </button>
              ) : (
                <div
                  key={j}
                  className={`chat-question-opt${picked === j ? " picked" : ""}`}
                >
                  <span className="chat-question-opt-label">{o.label}</span>
                  {o.description && (
                    <span className="chat-question-opt-desc">{o.description}</span>
                  )}
                </div>
              ),
            )}
        </div>
      ))}
      {tool.done ? (
        <div className="chat-question-answer">{tool.result}</div>
      ) : picked != null ? (
        <div className="chat-question-hint">answer sent…</div>
      ) : clickable ? (
        <div className="chat-question-hint">
          click an option to answer (assumes the Term picker is untouched)
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
