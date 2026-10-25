import { memo, useMemo, useState, useEffect, useRef } from "react";
import { useTransport } from "../lib/TransportContext";
import {
  ArrowCounterClockwise,
  ArrowsClockwise,
  Check,
  CheckCircle,
  Circle,
  CircleHalf,
  FileText,
  Globe,
  ListChecks,
  MagnifyingGlass,
  PaperPlaneRight,
  PencilSimple,
  PlusCircle,
  Robot,
  Terminal,
  Trash,
  UserCircle,
  Wrench,
} from "@phosphor-icons/react";
import { toolSummary, toolDiff, TASK_TOOLS, taskSummary, parseTaskList } from "./records";
import { Lightbox, saveBlob } from "./ImagePreview";
import CodeView, { langFromPath } from "./CodeView";
import { ansiLines } from "../lib/ansi";

import { questionAnswerSteps, sendQuestionAnswer } from "../lib/questionAnswer";

const RESULT_CLAMP = 4000;
// Bash output: the tail shows by default, "show all" caps here.
const OUT_TAIL = 30;
const OUT_MAX = 2000;

// Only the desktop app has a dock to open output in; the phone doesn't.
const HAS_DOCK = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Ask the app to show command output in a dock tab — following a live
 *  background-task file (path) or as a fixed transcript (text). */
export function openOutputTab(detail) {
  window.dispatchEvent(new CustomEvent("agentbench:open-output", { detail }));
}

// Long commands are often redirected into a log — `… > /tmp/x.log 2>&1`, or
// `| tee x.log` — which leaves the card with nothing but "exit 0". The target
// of the last stdout redirect to an absolute path, if there is one, so the
// card can follow the file instead.
const REDIRECT =
  /(?:^|[\s;&|(])(?:1?>>?|&>>?)\s*(?:"(\/[^"]+)"|'(\/[^']+)'|(\/[^\s;&|<>"'()]+))|\|\s*tee\s+(?:-a\s+)?(?:"(\/[^"]+)"|'(\/[^']+)'|(\/[^\s;&|<>"'()]+))/g;

export function logTarget(command) {
  let found = null;
  for (const m of (command ?? "").matchAll(REDIRECT)) {
    const p = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6];
    if (p && !p.startsWith("/dev/")) found = p;
  }
  return found;
}

const LOG_POLL_MS = 1500;
const LOG_KEEP = 400_000; // chars held per card; the file keeps the rest
const LOG_LINES = 300;

/** Follow a command's log file: polled while the command runs (so the row can
 *  preview it collapsed) and read once more when it finishes or is opened. */
function useLogTail(path, live, open) {
  const { invoke } = useTransport();
  const [text, setText] = useState("");
  const [error, setError] = useState(null);
  const offset = useRef(0);
  const held = useRef("");
  useEffect(() => {
    if (!path || !(live || open)) return;
    let dead = false;
    let timer;
    const poll = async () => {
      try {
        const r = await invoke("tail_output", { path, offset: offset.current });
        if (dead) return;
        if (r.restarted) held.current = "";
        if (r.data) {
          held.current = (held.current + r.data).slice(-LOG_KEEP);
          setText(held.current);
        }
        offset.current = r.offset;
        setError(null);
      } catch (e) {
        if (!dead) setError(String(e?.message || e));
      }
      if (!dead && live) timer = setTimeout(poll, LOG_POLL_MS);
    };
    poll();
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, [path, live, open, invoke]);
  return { text, error };
}

// Bash, readably: the command as shell text rather than escaped JSON, and
// its output with colours, tail first.
function BashBody({ tool, paneId, logPath, log }) {
  const [all, setAll] = useState(false);
  const command = tool.input?.command ?? "";
  const title = tool.input?.description || command.split("\n")[0];
  // Claude Code's background calls answer with where the live output goes.
  const livePath = /Output is being written to: (\S+\.output)/.exec(tool.result ?? "")?.[1];
  const lines = useMemo(() => {
    const out = livePath ? "" : (tool.result ?? "").replace(/\s+$/, "");
    return out ? ansiLines(out) : [];
  }, [tool.result, livePath]);
  const shown = all ? lines.slice(-OUT_MAX) : lines.slice(-OUT_TAIL);
  return (
    <>
      <CodeView code={command} lang="shellscript" prompt maxHeight={360} />
      {shown.length > 0 && (
        <div className={`chat-tool-out${tool.isError ? " error" : ""}`}>
          {lines.length > shown.length && (
            <button className="chat-tool-more" onClick={() => setAll(true)}>
              Show {lines.length > OUT_MAX ? `last ${OUT_MAX} of ` : "all "}
              {lines.length} lines
            </button>
          )}
          <pre className="chat-tool-pre">
            {shown.map((segs, i) => (
              <div key={i}>
                {segs.length === 0
                  ? "\u200b"
                  : segs.map((seg, j) =>
                      seg.style ? (
                        <span key={j} style={seg.style}>
                          {seg.text}
                        </span>
                      ) : (
                        seg.text
                      ),
                    )}
              </div>
            ))}
          </pre>
        </div>
      )}
      {logPath && <LogBlock path={logPath} log={log} live={!tool.done} />}
      {HAS_DOCK && (livePath || lines.length > 0) && (
        <div className="chat-tool-actions">
          {livePath ? (
            <button onClick={() => openOutputTab({ paneId, path: livePath, title })}>
              <Terminal size={11} /> Follow output
            </button>
          ) : (
            <button onClick={() => openOutputTab({ paneId, text: tool.result, title })}>
              <Terminal size={11} /> Open in terminal
            </button>
          )}
        </div>
      )}
    </>
  );
}

// One dim line under a running command's row: the newest thing it logged.
function LogPeek({ text }) {
  const last = useMemo(() => {
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      // strip colour codes, and the \r-rewritten progress-bar tail
      const t = lines[i].replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\r").pop().trim();
      if (t) return t;
    }
    return "";
  }, [text]);
  if (!last) return null;
  return <div className="chat-tool-peek">{last}</div>;
}

// The log a command was redirected into, tail first, with its colours.
function LogBlock({ path, log, live }) {
  const lines = useMemo(() => {
    const all = log.text ? ansiLines(log.text.replace(/\s+$/, "")) : [];
    return all.slice(-LOG_LINES);
  }, [log.text]);
  const boxRef = useRef(null);
  // keep the newest line in view while it's still being written
  useEffect(() => {
    const el = boxRef.current;
    if (el && live) el.scrollTop = el.scrollHeight;
  }, [lines, live]);
  const name = path.split("/").pop();
  return (
    <div className="chat-tool-out chat-tool-log">
      <div className="chat-tool-loghead" title={path}>
        {live && <ArrowsClockwise size={10} className="chat-tool-spin" />}
        <span>{name}</span>
        {live && <span className="chat-tool-livetag">live</span>}
      </div>
      {log.error && lines.length === 0 ? (
        <div className="chat-tool-logerr">Can't read this log — {log.error}</div>
      ) : (
        <div className="chat-tool-logbox" ref={boxRef}>
          <pre className="chat-tool-pre">
            {lines.length === 0 && <span className="chat-tool-logwait">{live ? "waiting for output…" : "(empty)"}</span>}
            {lines.map((segs, i) => (
              <div key={i}>
                {segs.length === 0
                  ? "\u200b"
                  : segs.map((seg, j) =>
                      seg.style ? (
                        <span key={j} style={seg.style}>
                          {seg.text}
                        </span>
                      ) : (
                        seg.text
                      ),
                    )}
              </div>
            ))}
          </pre>
        </div>
      )}
    </div>
  );
}

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

// Shared task list tools: one readable line — what happened to which task,
// by subject — instead of a raw `{ taskId, status }` blob. Only a new task's
// description and a task-list check have anything worth expanding.
const TASK_ICONS = {
  new: PlusCircle,
  completed: CheckCircle,
  in_progress: CircleHalf,
  pending: ArrowCounterClockwise,
  deleted: Trash,
  update: UserCircle,
  read: ListChecks,
};
const TASK_MARKS = { completed: CheckCircle, in_progress: CircleHalf, pending: Circle };

function TaskRow({ tool }) {
  const [open, setOpen] = useState(false);
  const { label, detail, tone, owner } = taskSummary(tool);
  const tasks = tool.name === "TaskList" ? parseTaskList(tool.result) : [];
  const description = tool.name === "TaskCreate" ? tool.input?.description?.trim() : "";
  const expandable = tool.isError || tasks.length > 0 || !!description;
  const Icon = TASK_ICONS[tone] ?? ListChecks;
  return (
    <div className={`chat-tool chat-task task-${tone}${tool.isError ? " error" : ""}`}>
      <button
        className="chat-tool-row"
        onClick={() => expandable && setOpen((o) => !o)}
        style={expandable ? undefined : { cursor: "default" }}
      >
        <span className="chat-tool-icon">
          {!tool.done ? <ArrowsClockwise size={12} className="chat-tool-spin" /> : <Icon size={13} weight="bold" />}
        </span>
        <span className="chat-tool-label">{label}</span>
        {detail && <span className="chat-task-detail">{detail}</span>}
        {owner && <span className="chat-task-owner">{owner}</span>}
        {tool.isError && <span className="chat-tool-err">failed</span>}
      </button>
      {open && (
        <div className="chat-tool-body">
          {description && <div className="chat-task-desc">{description}</div>}
          {tasks.length > 0 && (
            <ul className="chat-task-list">
              {tasks.map((t) => {
                const Mark = TASK_MARKS[t.status] ?? Circle;
                return (
                  <li key={t.id} className={`task-${t.status}`}>
                    <Mark size={12} weight="bold" />
                    <span className="chat-task-id">#{t.id}</span>
                    <span className="chat-task-subject">{t.subject}</span>
                    {t.owner && <span className="chat-task-owner">{t.owner}</span>}
                  </li>
                );
              })}
            </ul>
          )}
          {tool.isError && <pre className="chat-tool-pre chat-tool-result error">{tool.result}</pre>}
        </div>
      )}
    </div>
  );
}

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
                    {/* label over description: side by side, a long label
                        starved the description into a one-word-wide column */}
                    <span className="chat-question-opt-text">
                      <span className="chat-question-opt-label">{o.label}</span>
                      {o.description && (
                        <span className="chat-question-opt-desc">{o.description}</span>
                      )}
                    </span>
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

/** Pictures a tool returned (Read on an image file, a screenshot…), shown
 *  under its row — tap one for the zoomable viewer. */
function ToolImages({ images, title }) {
  const [open, setOpen] = useState(null); // index being viewed
  const name = (title || "image").split(/[\\/]/).pop();
  return (
    <div className="chat-tool-images">
      {images.map((src, i) => (
        <button
          key={i}
          type="button"
          className="chat-tool-image"
          onClick={() => setOpen(i)}
          aria-label={`Expand ${name}`}
        >
          <img src={src} alt={name} loading="lazy" draggable={false} />
        </button>
      ))}
      {open != null && (
        <Lightbox
          src={images[open]}
          name={name}
          onSave={() =>
            fetch(images[open])
              .then((r) => r.blob())
              .then((b) => saveBlob(b, /\.\w+$/.test(name) ? name : `${name}.png`))
              .catch(() => {})
          }
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

// Edit/Write as editor-style diff: runs of removed / added lines, each
// highlighted in the file's own language.
function DiffView({ diff, lang }) {
  const runs = [];
  for (const l of diff) {
    const last = runs[runs.length - 1];
    if (last && last.sign === l.sign) last.lines.push(l.text);
    else runs.push({ sign: l.sign, lines: [l.text] });
  }
  return (
    <div className="chat-diff-view">
      {runs.map((r, i) => (
        <CodeView key={i} code={r.lines.join("\n")} lang={lang} sign={r.sign} maxHeight={320} />
      ))}
    </div>
  );
}

// Read results come back as numbered lines — "12\ttext" (or the older
// "   12→text"). Peel the numbers into a gutter so what's left is the file.
function parseNumbered(text) {
  const body = text.replace(/\n*<system-reminder>[\s\S]*$/, "").replace(/\s+$/, "");
  const lines = body.split("\n");
  const rows = lines.map((l) => /^\s*(\d+)[\t→](.*)$/.exec(l));
  if (lines.length === 0 || rows.some((m) => !m)) return { code: body, start: null };
  return { code: rows.map((m) => m[2]).join("\n"), start: Number(rows[0][1]) };
}

function ReadResult({ result, lang }) {
  const { code, start } = useMemo(() => parseNumbered(result), [result]);
  return <CodeView code={code} lang={lang} start={start} maxHeight={460} />;
}

// Slim activity row, t3code-style: icon + summary + mono detail on one 12px
// line; click expands input/diff/result. Rows stack inside .chat-tools.
export default memo(
  function ToolCard({ tool, paneId, canAnswer }) {
    const [open, setOpen] = useState(false);
    const logPath = useMemo(
      () => (tool.name === "Bash" ? logTarget(tool.input?.command) : null),
      [tool.name, tool.input?.command],
    );
    const log = useLogTail(logPath, !tool.done, open);
    if (tool.name === "AskUserQuestion")
      return <QuestionCard tool={tool} paneId={paneId} canAnswer={canAnswer} />;
    if (TASK_TOOLS.has(tool.name)) return <TaskRow tool={tool} />;
    const { label, detail } = toolSummary(tool);
    const diff = open ? toolDiff(tool) : null;
    const status = !tool.done ? "running" : tool.isError ? "error" : "ok";
    const Icon = TOOL_ICONS[tool.name] ?? Wrench;

    // the picture is shown under the row; its "[image]" placeholder is noise
    const text = tool.images?.length
      ? (tool.result ?? "").replace(/^\[image\]$/gm, "").trim()
      : tool.result;
    const result =
      text && text.length > RESULT_CLAMP ? text.slice(0, RESULT_CLAMP) + "\n… (truncated)" : text;
    const isRead = tool.name === "Read";
    const fileLang = langFromPath(tool.input?.file_path ?? tool.input?.notebook_path);

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
        {tool.images?.length > 0 && <ToolImages images={tool.images} title={detail || label} />}
        {logPath && !open && !tool.done && <LogPeek text={log.text} />}
        {open && tool.name === "Bash" && (
          <div className="chat-tool-body bash">
            <BashBody tool={tool} paneId={paneId} logPath={logPath} log={log} />
          </div>
        )}
        {open && tool.name !== "Bash" && (
          <div className="chat-tool-body">
            {diff ? (
              <DiffView diff={diff} lang={fileLang} />
            ) : (
              // a Read's input is just the path already in the header
              tool.input != null &&
              !isRead && (
                <CodeView
                  code={typeof tool.input === "string" ? tool.input : JSON.stringify(tool.input, null, 2)}
                  lang={typeof tool.input === "string" ? null : "json"}
                  maxHeight={320}
                />
              )
            )}
            {isRead && text && !tool.isError ? (
              <ReadResult result={text} lang={fileLang} />
            ) : (
              result != null &&
              result !== "" && (
                <pre
                  className={`chat-tool-pre chat-tool-result${tool.isError ? " error" : ""}`}
                >
                  {result}
                </pre>
              )
            )}
          </div>
        )}
      </div>
    );
  },
  // tools mutate in place; the owning message's rev is the change signal
  (prev, next) => prev.tool === next.tool && prev.rev === next.rev,
);

// A dialog Claude drew straight into the terminal — the folder-trust check,
// a computer-use access request, any other selection menu that never reaches
// a hook. The broker reads it off the pane's screen; picking an option here
// has the broker drive the keys from wherever the pointer currently sits.
export function TtyPromptCard({ prompt, paneId }) {
  const { invoke } = useTransport();
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  // a new dialog (or the same one redrawn after a failed send) starts fresh
  useEffect(() => {
    setBusy(null);
    setError(null);
  }, [prompt.sig]);

  const pick = async (index) => {
    setBusy(index);
    setError(null);
    try {
      await invoke("answer_tty_prompt", { id: paneId, sig: prompt.sig, index });
    } catch (e) {
      setBusy(null);
      setError(String(e?.message ?? e));
    }
  };

  return (
    <div className="chat-question chat-tty-prompt" role="group" aria-label={prompt.title}>
      <div className="chat-question-title">
        {prompt.title}
        <span className="chat-question-badge">terminal</span>
      </div>
      {prompt.body && <div className="chat-tty-body">{prompt.body}</div>}
      {prompt.options.map((o, i) => (
        <button
          key={i}
          className={`chat-question-opt choice clickable${busy === i ? " on" : ""}`}
          disabled={busy != null}
          onClick={() => pick(i)}
        >
          <span className="chat-question-opt-text">
            <span className="chat-question-opt-label">
              {o.label}
              {i === prompt.selected && <span className="chat-question-badge">default</span>}
            </span>
            {o.description && <span className="chat-question-opt-desc">{o.description}</span>}
          </span>
        </button>
      ))}
      {(error || busy != null) && (
        <div className="chat-question-hint" role={error ? "alert" : "status"}>
          {error || "Sent — waiting for the terminal…"}
        </div>
      )}
    </div>
  );
}
