// Normalizes both chat sources into one message model:
//  - transcript JSONL records (~/.claude/projects/<slug>/<sid>.jsonl) for
//    read-along panes — written per message, so no partials
//  - `claude -p --output-format stream-json` lines for headless panes,
//    including stream_event deltas for token-by-token text
// Tool-summary shape (summary + detail per tool) adapted from t3code's
// toolActivity.ts (github.com/pingdotgg/t3code, MIT).

// message: { key, role: "user"|"assistant", kind: "text"|"thinking"|"tool"|
//            "error"|"draft", text?, tool?, sidechain?: bool }
// tool:    { id, name, input, result?, isError?, done }

export function createChatStore() {
  return {
    messages: [],
    seen: new Set(), // transcript uuids + synthetic keys, for backfill overlap
    tools: new Map(), // tool_use_id -> tool object (shared with its message)
    toolMsg: new Map(), // tool_use_id -> owning message (rev bump on result)
    draft: null, // streaming assistant text (stream mode only)
    pending: [], // optimistic local user echoes awaiting their real record
    nextKey: 0,
    rev: 0, // bumped on every visible change — cheap render/scroll guard
  };
}

/** Optimistic echo: show the user's message the instant they hit send —
 *  the real transcript record arrives a poll later and is deduped. */
export function addLocalUser(store, text) {
  const msg = push(store, { role: "user", kind: "text", text, local: true });
  store.pending.push(msg);
  return msg;
}

// The real record for a local echo confirms it instead of duplicating it.
function confirmLocalUser(store, text) {
  const i = store.pending.findIndex((p) => p.text.trim() === text.trim());
  if (i === -1) return false;
  const [msg] = store.pending.splice(i, 1);
  msg.local = false;
  msg.rev = ++store.rev;
  return true;
}

function push(store, msg) {
  msg.key = `m${store.nextKey++}`;
  msg.rev = ++store.rev;
  store.messages.push(msg);
  return msg;
}

function textOf(content) {
  // tool_result / user content: string, or array of {type:"text"|"image",...}
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b.type === "text" ? b.text : b.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

// A transcript user record whose text is pure harness plumbing, not the user.
function isNoiseUserText(text) {
  const t = text.trimStart();
  return (
    t.startsWith("<local-command-caveat>") ||
    t.startsWith("<command-name>") ||
    t.startsWith("<command-message>") ||
    t.startsWith("<local-command-stdout>") ||
    t.startsWith("<system-reminder>") ||
    t.startsWith("Caveat:")
  );
}

// Slash-command records carry <command-name>/<command-args> tags plus the
// command's whole expanded body — render just "/name args" as a chip.
function commandChip(text) {
  const name = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(text)?.[1];
  if (!name) return null;
  const args = /<command-args>\s*([^<]*?)\s*<\/command-args>/.exec(text)?.[1];
  return args ? `${name} ${args}` : name;
}

// A command typed in the composer left a pending echo; its transcript record
// comes back as a chip, so confirm-and-morph the echo instead of stacking a
// second, forever-spinning copy.
function pushCommandChip(store, chip, sidechain) {
  const first = chip.trim().split(/\s+/)[0];
  const i = store.pending.findIndex(
    (p) => p.text.trim() === chip.trim() || p.text.trim().split(/\s+/)[0] === first,
  );
  if (i !== -1) {
    const [msg] = store.pending.splice(i, 1);
    msg.kind = "command";
    msg.text = chip;
    msg.local = false;
    msg.rev = ++store.rev;
    return;
  }
  push(store, { role: "user", kind: "command", text: chip, sidechain });
}

/** Apply one parsed record. Returns true when the visible list changed. */
export function applyRecord(store, rec) {
  if (!rec || typeof rec !== "object") return false;

  // transcript backfill overlaps the live tail; uuids dedupe the seam
  if (rec.uuid) {
    if (store.seen.has(rec.uuid)) return false;
    store.seen.add(rec.uuid);
  }

  switch (rec.type) {
    case "assistant":
      return applyAssistant(store, rec);
    case "user":
      return applyUser(store, rec);
    case "stream_event":
      return applyStreamEvent(store, rec);
    case "x-stderr":
      push(store, { role: "assistant", kind: "error", text: rec.text ?? "" });
      return true;
    case "result":
      // turn finished — drop any leftover draft (final assistant already landed)
      if (store.draft) {
        store.draft = null;
        return true;
      }
      return false;
    default:
      // mode, file-history-snapshot, attachment, progress, summary, system…
      return false;
  }
}

function applyAssistant(store, rec) {
  const blocks = rec.message?.content;
  if (!Array.isArray(blocks)) return false;
  const sidechain = !!rec.isSidechain;
  let changed = false;
  // a complete assistant message supersedes the streaming draft
  if (store.draft) {
    store.messages = store.messages.filter((m) => m !== store.draft);
    store.draft = null;
    changed = true;
  }
  for (const b of blocks) {
    if (b.type === "text") {
      if (b.text?.trim()) {
        push(store, { role: "assistant", kind: "text", text: b.text, sidechain });
        changed = true;
      }
    } else if (b.type === "thinking" || b.type === "redacted_thinking") {
      push(store, {
        role: "assistant",
        kind: "thinking",
        text: b.thinking ?? "",
        sidechain,
      });
      changed = true;
    } else if (b.type === "tool_use") {
      const tool = { id: b.id, name: b.name, input: b.input, done: false };
      store.tools.set(b.id, tool);
      const msg = push(store, { role: "assistant", kind: "tool", tool, sidechain });
      store.toolMsg.set(b.id, msg);
      changed = true;
    }
  }
  return changed;
}

function applyUser(store, rec) {
  if (rec.isMeta) return false;
  const content = rec.message?.content;
  const sidechain = !!rec.isSidechain;
  let changed = false;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b.type === "tool_result") {
        const tool = store.tools.get(b.tool_use_id);
        if (tool) {
          tool.result = textOf(b.content);
          tool.isError = !!b.is_error;
          tool.done = true;
          const msg = store.toolMsg.get(b.tool_use_id);
          if (msg) msg.rev = ++store.rev;
          changed = true;
        }
      } else if (b.type === "text" && b.text?.trim()) {
        const chip = commandChip(b.text);
        if (chip) {
          pushCommandChip(store, chip, sidechain);
          changed = true;
        } else if (!isNoiseUserText(b.text)) {
          if (!confirmLocalUser(store, b.text)) {
            push(store, { role: "user", kind: "text", text: b.text, sidechain });
          }
          changed = true;
        }
      } else if (b.type === "image") {
        push(store, { role: "user", kind: "text", text: "[image]", sidechain });
        changed = true;
      }
    }
  } else if (typeof content === "string" && content.trim()) {
    const chip = commandChip(content);
    if (chip) {
      pushCommandChip(store, chip, sidechain);
      changed = true;
    } else if (!isNoiseUserText(content)) {
      if (!confirmLocalUser(store, content)) {
        push(store, { role: "user", kind: "text", text: content, sidechain });
      }
      changed = true;
    }
  }
  return changed;
}

function applyStreamEvent(store, rec) {
  const ev = rec.event;
  if (!ev) return false;
  if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
    if (!store.draft) {
      store.draft = push(store, { role: "assistant", kind: "draft", text: "" });
    }
    store.draft.text += ev.delta.text;
    store.draft.rev = ++store.rev;
    return true;
  }
  if (ev.type === "message_stop" && store.draft) {
    // keep the text visible; the full assistant record will replace it
    return false;
  }
  return false;
}

/** Parse a raw JSONL line and apply it. */
export function applyLine(store, line) {
  if (!line?.trim()) return false;
  try {
    return applyRecord(store, JSON.parse(line));
  } catch {
    return false;
  }
}

export function applyLines(store, lines) {
  let changed = false;
  for (const l of lines) changed = applyLine(store, l) || changed;
  return changed;
}

// ---- tool presentation -----------------------------------------------------

function basename(p) {
  return typeof p === "string" ? p.split(/[\\/]/).filter(Boolean).pop() : undefined;
}

/** One-line summary for a collapsed tool card. */
export function toolSummary(tool) {
  const { name, input = {} } = tool;
  switch (name) {
    case "Bash":
      return { label: "Ran command", detail: input.command ?? input.description };
    case "Read":
      return { label: "Read file", detail: input.file_path };
    case "Edit":
      return { label: "Edited file", detail: input.file_path };
    case "Write":
      return { label: "Wrote file", detail: input.file_path };
    case "NotebookEdit":
      return { label: "Edited notebook", detail: input.notebook_path };
    case "Grep":
      return { label: "Searched files", detail: input.pattern };
    case "Glob":
      return { label: "Listed files", detail: input.pattern };
    case "WebFetch":
      return { label: "Fetched", detail: input.url };
    case "WebSearch":
      return { label: "Searched web", detail: input.query };
    case "Task":
      return { label: "Ran agent", detail: input.description };
    case "TodoWrite":
      return { label: "Updated todos" };
    default:
      return {
        label: name,
        detail: input.file_path ?? input.path ?? input.command ?? input.query,
      };
  }
}

/** Edit/Write inputs as unified-diff-ish lines for the expanded card. */
export function toolDiff(tool) {
  const { name, input = {} } = tool;
  if (name === "Edit" && (input.old_string || input.new_string)) {
    return [
      ...(input.old_string ?? "").split("\n").map((l) => ({ sign: "-", text: l })),
      ...(input.new_string ?? "").split("\n").map((l) => ({ sign: "+", text: l })),
    ];
  }
  if (name === "Write" && typeof input.content === "string") {
    return input.content
      .split("\n")
      .slice(0, 200)
      .map((l) => ({ sign: "+", text: l }));
  }
  return null;
}
