// Normalizes both chat sources into one message model:
//  - transcript JSONL records (~/.claude/projects/<slug>/<sid>.jsonl) for
//    read-along panes — written per message, so no partials
//  - `claude -p --output-format stream-json` lines for headless panes,
//    including stream_event deltas for token-by-token text
import { promptKey, tokenNumbers, PASTED_TAG_RE } from "../lib/imageTokens.js";

// Tool-summary shape (summary + detail per tool) adapted from t3code's
// toolActivity.ts (github.com/pingdotgg/t3code, MIT).

// message: { key, role: "user"|"assistant", kind: "text"|"thinking"|"tool"|
//            "error"|"draft", text?, tool?, sidechain?: bool,
//            agentId?, agent?,       // sidechain only: owning Task id + label
//            local?: bool,           // optimistic echo, unconfirmed ("sending")
//            failed?: bool, wire?,   // send rejected; wire = text to resend
//            queued?: bool }         // sitting in the harness's input queue
// tool:    { id, name, input, result?, isError?, done }

export function createChatStore() {
  return {
    messages: [],
    seen: new Set(), // transcript uuids + synthetic keys, for backfill overlap
    tools: new Map(), // tool_use_id -> tool object (shared with its message)
    toolMsg: new Map(), // tool_use_id -> owning message (rev bump on result)
    draft: null, // streaming assistant text (stream mode only)
    pending: [], // optimistic local user echoes awaiting their real record
    // Long-running work worth a status strip: sub-agents (Task) and
    // background shells (Bash run_in_background). tool_use_id ->
    // { kind: "agent"|"shell", label, detail, msgKey, bg, bgId?, done }
    activity: new Map(),
    model: null, // full model id the session is actually on, once observed
    nextKey: 0,
    rev: 0, // bumped on every visible change — cheap render/scroll guard
  };
}

/** Optimistic echo: show the user's message the instant they hit send —
 *  the real transcript record arrives a poll later and is deduped. `images`
 *  is an optional array of { url } shown inline in the bubble. */
export function addLocalUser(store, text, images) {
  const msg = push(store, {
    role: "user",
    kind: "text",
    text,
    images: images?.length ? images : undefined,
    local: true,
  });
  store.pending.push(msg);
  // echoes whose record never matched accumulate; keep the tail bounded
  if (store.pending.length > 20) store.pending.shift();
  return msg;
}

// Index of the pending echo a record's prompt text belongs to. Compared by
// promptKey: the record may carry the temp paths (plain-text delivery) or
// Claude's renumbered [Image #N] markers where the echo has the composer's.
function findPending(store, text) {
  const key = promptKey(text);
  if (!key) return -1;
  return store.pending.findIndex((p) => promptKey(p.wire ?? p.text) === key);
}

// The real record for a local echo confirms it instead of duplicating it.
function confirmLocalUser(store, text) {
  const i = findPending(store, text);
  if (i === -1) return false;
  const [msg] = store.pending.splice(i, 1);
  msg.local = false;
  msg.failed = false; // a marked-failed send that landed after all
  msg.queued = false;
  msg.rev = ++store.rev;
  return true;
}

// Claude logs a prompt typed mid-turn as a queue-operation, not a user
// record: "enqueue" when it's parked, "remove" (absorbed_mid_turn) when it's
// folded into the running turn — which never yields a user record at all.
// Either proves delivery; without this the 10s no-confirmation timer flagged
// every queued message "may not have sent" while it sat in the queue.
function applyQueueOp(store, rec) {
  if (rec.operation !== "enqueue" && rec.operation !== "remove") return false;
  const i = findPending(store, rec.content);
  if (i === -1) return false;
  const msg = store.pending[i];
  if (rec.operation === "remove") store.pending.splice(i, 1);
  // enqueue keeps it pending: the dequeued user record still has to match it
  msg.queued = rec.operation === "enqueue";
  msg.local = false;
  msg.failed = false;
  msg.rev = ++store.rev;
  return true;
}

/** The send path reported this echo definitely did not arrive. It stays in
 *  the thread (and in `pending`, so a late/retried record still confirms it)
 *  but stops spinning and grows a retry affordance. */
export function markSendFailed(store, msg) {
  if (!msg) return;
  msg.local = false;
  msg.failed = true;
  msg.rev = ++store.rev;
}

/** User tapped retry on a failed echo: back to "sending". */
export function retrySend(store, msg) {
  msg.failed = false;
  msg.local = true;
  if (!store.pending.includes(msg)) store.pending.push(msg);
  msg.rev = ++store.rev;
}

/** Session adoption resets the store; the optimistic echoes must survive it —
 *  the very first message a user sends is what creates the session whose
 *  adoption fires the reset, and it used to take the echo down with it.
 *
 *  The SAME objects move across (re-keyed into the new store's sequence, so
 *  keys stay unique): an in-flight send holds a reference to its echo, and a
 *  clone would leave its later failure mark on an orphan while the visible
 *  copy spins forever. */
export function carryPending(from, to) {
  for (const p of from.pending) {
    p.key = `m${to.nextKey++}`;
    p.rev = ++to.rev;
    to.messages.push(p);
    to.pending.push(p);
  }
}

/** Stop showing the "sending" spinner on every pending echo without dropping
 *  it from `pending` (it still dedupes against the eventual record). Called
 *  when something *proves* the prompt was consumed — the UserPromptSubmit
 *  hook, or any assistant output — because the exact-text record can lag or
 *  never match (queued sends, edited resubmits), and a message that visibly
 *  went through in the terminal must not keep spinning in chat. */
export function confirmPending(store) {
  let changed = false;
  for (const p of store.pending) {
    if (p.local) {
      p.local = false;
      p.rev = ++store.rev;
      changed = true;
    }
  }
  return changed;
}

/** A local, never-sent system notice (errors, model switches, hints). */
export function addNotice(store, title, body) {
  push(store, { role: "system", kind: "notice", notice: { title, body: body ?? null } });
}

function push(store, msg) {
  msg.key = `m${store.nextKey++}`;
  msg.rev = ++store.rev;
  store.messages.push(msg);
  return msg;
}

// A message content-block image → a renderable URL. The transcript inlines
// the bytes as base64; the API-shape allows a plain url source too.
function imageUrlFromSource(s) {
  if (!s) return null;
  if (s.type === "base64" && s.data) {
    return `data:${s.media_type || "image/png"};base64,${s.data}`;
  }
  if (s.type === "url" && s.url) return s.url;
  return null;
}

// Strip the delivery machinery (temp image paths) from a pasted-image turn's
// text. Claude's [Image #N] markers stay: they're where the user put each
// image, and the prose may refer to them by number.
function cleanImageText(text) {
  return text
    .replace(/\S*agentbench-images[\\/]paste-\S+/g, "")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

// Claude Code wraps a large paste in <pasted_content id="N"> tags in the
// transcript record. The tags are delivery machinery, not the user's words —
// show only the content between them.
function unwrapPasted(text) {
  return text.replace(PASTED_TAG_RE, "").trim();
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

// The harness injects wrapped machine messages into the user turn — background
// task updates, hook output, etc. They aren't the user talking, so they must
// not render as a right-aligned user bubble (which reads as "someone sent
// this"). Parse the ones worth surfacing into a plain-language system notice;
// return null for anything we'd rather leave to isNoiseUserText to hide.
function harnessNotice(text) {
  const t = text.trimStart();
  if (t.startsWith("<task-notification>")) {
    const status = /<status>\s*([^<]*?)\s*<\/status>/.exec(text)?.[1];
    const summary = /<summary>\s*([\s\S]*?)\s*<\/summary>/.exec(text)?.[1];
    const ids = (text.match(/<task-id>/g) ?? []).length;
    const count = ids === 1 ? "1 background task" : `${ids} background tasks`;
    const head = status ? `${count} · ${status}` : count;
    return {
      title: "Background update",
      head,
      body: summary?.trim() || null,
    };
  }
  return null;
}

// Slash-command records carry <command-name>/<command-args> tags plus the
// command's whole expanded body — render just "/name args" as a chip.
function commandChip(text) {
  const name = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(text)?.[1];
  if (!name) return null;
  const args = /<command-args>\s*([^<]*?)\s*<\/command-args>/.exec(text)?.[1];
  // The tag carries its own leading slash; normalize here so no renderer has
  // to guess. The event row used to re-prepend one and print "//clear".
  const slashed = name.startsWith("/") ? name : `/${name}`;
  return args ? `${slashed} ${args}` : slashed;
}

// A command typed in the composer left a pending echo; its transcript record
// comes back as a chip, so confirm the echo instead of stacking a second,
// forever-spinning copy.
//
// The echo is already a normal user bubble and stays one — it's something you
// typed, so it reads as chat. It used to morph into kind "command", which
// yanked your own message into a centered pill mid-thread and, since the pill
// doesn't wrap, mangled anything long. Only commands with no echo (auto-
// compact and friends, which the harness runs on its own) stay event rows.
function pushCommandChip(store, chip, sidechain) {
  const first = chip.trim().split(/\s+/)[0];
  // sub-agent command records must not confirm the user's pending echo
  const i = sidechain
    ? -1
    : store.pending.findIndex(
        (p) => p.text.trim() === chip.trim() || p.text.trim().split(/\s+/)[0] === first,
      );
  if (i !== -1) {
    const [msg] = store.pending.splice(i, 1);
    msg.text = chip; // canonical "/name args", not the raw keystrokes
    msg.local = false;
    msg.failed = false;
    msg.rev = ++store.rev;
    return;
  }
  push(store, { role: "user", kind: "command", text: chip, sidechain });
}

/** Apply one parsed record. Returns true when the visible list changed. */
export function applyRecord(store, rec) {
  if (!rec || typeof rec !== "object") return false;

  // Claude queues background completion notices outside normal user records.
  // These are lifecycle records, not chat bubbles or successful sends.
  if (rec.type === "queue-operation" && typeof rec.content === "string") {
    const done = completeNotifiedTasks(store, rec.content, rec.timestamp);
    return applyQueueOp(store, rec) || done;
  }
  if (rec.type === "attachment" && rec.attachment?.type === "queued_command"
      && rec.attachment?.commandMode === "task-notification") {
    return completeNotifiedTasks(store, rec.attachment.prompt ?? "", rec.timestamp);
  }

  if (rec.type === "turn_context") return noteModel(store, rec.payload?.model);
  if (rec.type === "event_msg") {
    const type = rec.payload?.type;
    if (["task_started", "task_complete", "task_completed", "turn_aborted"].includes(type)) {
      store.turnActive = type === "task_started";
      store.rev++;
      return true;
    }
    return false; // response_item is canonical; event messages duplicate it
  }
  if (rec.type === "response_item") return applyCodexItem(store, rec);

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
      // a sub-agent finishing must not tear down the main agent's draft
      if (rec.parent_tool_use_id) return false;
      // turn finished — drop any leftover draft (final assistant already landed)
      if (store.draft) {
        store.draft = null;
        return true;
      }
      return false;
    case "system":
      // stream-json's init announces the session's model before any reply —
      // but a sub-agent's init (parent_tool_use_id set) reports the
      // sub-agent's model, and adopting it relabeled the whole pane
      if (rec.subtype === "init" && !rec.parent_tool_use_id) {
        return noteModel(store, rec.model);
      }
      return false;
    default:
      // mode, file-history-snapshot, attachment, progress, summary…
      return false;
  }
}

function applyCodexItem(store, rec) {
  const item = rec.payload ?? {};
  const uuid = item.id ? `codex:${item.id}` : undefined;
  const wrap = (type, content) => applyRecord(store, {
    type, uuid, timestamp: rec.timestamp, message: { content },
  });
  if (item.type === "message" && ["user", "assistant"].includes(item.role)) {
    const text = (item.content ?? []).filter((b) => ["input_text", "output_text", "text"].includes(b.type))
      .map((b) => b.text ?? "").join("\n");
    // Rollouts contain injected context as user messages before the prompt.
    if (item.role === "user" && /^(?:# AGENTS\.md instructions|<environment_context>|<permissions instructions>)/.test(text)) return false;
    return wrap(item.role, [{ type: "text", text }]);
  }
  if (item.type === "reasoning") {
    return wrap("assistant", (item.summary ?? []).map((b) => ({ type: "thinking", thinking: b.text ?? "" })));
  }
  if (["function_call", "custom_tool_call"].includes(item.type)) {
    let input = item.arguments ?? item.input ?? "";
    try { input = JSON.parse(input); } catch { input = { input }; }
    return wrap("assistant", [{ type: "tool_use", id: item.call_id, name: item.name, input }]);
  }
  if (["function_call_output", "custom_tool_call_output"].includes(item.type)) {
    return wrap("user", [{ type: "tool_result", tool_use_id: item.call_id,
      content: typeof item.output === "string" ? item.output : JSON.stringify(item.output) }]);
  }
  return false;
}

/** Remember the model the session is actually on, as reported by the stream
 *  init message or an assistant reply — so the picker can show it even when
 *  the user never chose one here. Sidechain replies are subagents (often a
 *  different model) and error records carry the placeholder "<synthetic>";
 *  both are ignored. */
function noteModel(store, model) {
  if (!model || model === "<synthetic>" || model === store.model) return false;
  store.model = model;
  store.rev++;
  return true;
}

// Sub-agent identity of a record. Transcript JSONL marks sidechains with
// isSidechain; `claude -p` stream-json instead stamps every sub-agent message
// with parent_tool_use_id (the spawning Task call). Ignoring the latter made
// stream panes render sub-agent turns as the main agent — indistinguishable
// bubbles, and the composer's model chip relabeled itself with the
// sub-agent's model — which is how "I'm suddenly talking to a sub-agent"
// happened on the phone (headless panes are its default).
function sidechainOf(store, rec) {
  const agentId = rec.parent_tool_use_id ?? null;
  if (!agentId && !rec.isSidechain) return { sidechain: false };
  return {
    sidechain: true,
    agentId: agentId ?? undefined,
    // the Task activity entry already carries a human label ("Explore …")
    agent: agentId ? store.activity.get(agentId)?.label : undefined,
  };
}

function applyAssistant(store, rec) {
  const blocks = rec.message?.content;
  if (!Array.isArray(blocks)) return false;
  const { sidechain, agentId, agent } = sidechainOf(store, rec);
  if (sidechain && agentId) {
    const act = store.activity.get(agentId)
      ?? [...store.activity.values()].find((item) => item.bgId === agentId);
    if (act && !act.done) {
      act.updatedAt = Date.parse(rec.timestamp) || Date.now();
      const output = blocks.map((block) => block.type === "text" ? block.text
        : block.type === "tool_use" ? `${block.name}: ${JSON.stringify(block.input ?? {})}` : "")
        .filter(Boolean).join("\n");
      if (output) act.output = output.slice(-12000);
    }
  }
  // assistant output proves the prompt was consumed — stop any send spinner
  let changed = confirmPending(store);
  if (!sidechain) changed = noteModel(store, rec.message?.model) || changed;
  // a complete assistant message supersedes the streaming draft
  if (!sidechain && store.draft) {
    store.messages = store.messages.filter((m) => m !== store.draft);
    store.draft = null;
    changed = true;
  }
  for (const b of blocks) {
    if (b.type === "text") {
      if (b.text?.trim()) {
        push(store, {
          role: "assistant",
          kind: "text",
          text: b.text,
          sidechain,
          agentId,
          agent,
        });
        changed = true;
      }
    } else if (b.type === "thinking" || b.type === "redacted_thinking") {
      push(store, {
        role: "assistant",
        kind: "thinking",
        text: b.thinking ?? "",
        sidechain,
        agentId,
        agent,
      });
      changed = true;
    } else if (b.type === "tool_use") {
      // A PreToolUse-hook question card may already be on screen (inserted by
      // applyAsk before the transcript caught up) — adopt it in place instead
      // of stacking a duplicate, rebinding to the real tool_use id so its
      // tool_result lands on the same card.
      if (!(b.name === "AskUserQuestion" && adoptSyntheticAsk(store, b))) {
        const tool = { id: b.id, name: b.name, input: b.input, done: false };
        store.tools.set(b.id, tool);
        const msg = push(store, {
          role: "assistant",
          kind: "tool",
          tool,
          sidechain,
          agentId,
          agent,
        });
        store.toolMsg.set(b.id, msg);
        if (!sidechain) trackToolStart(store, tool, msg, rec);
      }
      changed = true;
    }
  }
  return changed;
}

// ---- background-work tracking ---------------------------------------------

// Tools that spawn work outliving their own tool_result: sub-agents (Task)
// and background shells. Everything else finishes when its result lands.
function trackToolStart(store, tool, msg, rec) {
  const input = tool.input ?? {};
  const bg = input.run_in_background === true;
  if (tool.name === "Task" || tool.name === "Agent") {
    store.activity.set(tool.id, {
      kind: "agent",
      label: input.description || input.subagent_type || "subagent",
      detail: input.prompt || input.subagent_type,
      msgKey: msg.key,
      startedAt: Date.parse(rec.timestamp) || Date.now(),
      updatedAt: Date.parse(rec.timestamp) || Date.now(),
      bg,
      done: false,
    });
  } else if (tool.name === "Bash" && bg) {
    store.activity.set(tool.id, {
      kind: "shell",
      label: input.description || (input.command ?? "shell").slice(0, 80),
      detail: input.command,
      msgKey: msg.key,
      startedAt: Date.parse(rec.timestamp) || Date.now(),
      updatedAt: Date.parse(rec.timestamp) || Date.now(),
      bg: true,
      done: false,
    });
  }
}

// A tool_result arriving for a tracked tool: synchronous work is over;
// background launches instead reveal the id later notifications refer to.
function trackToolResult(store, toolId, tool, resultText, rec) {
  const now = Date.parse(rec?.timestamp) || Date.now();
  const input = tool?.input ?? {};
  const id = input.bash_id ?? input.task_id ?? input.shell_id;
  if (["KillShell", "KillBash", "TaskStop"].includes(tool?.name) && !tool.isError) {
    completeByBgId(store, id, { output: resultText, updatedAt: now });
  }
  if (["BashOutput", "TaskOutput"].includes(tool?.name)) {
    const status = /<(?:status|task_status)>\s*(completed|failed|killed|running)\s*<\//i.exec(resultText ?? "")?.[1]?.toLowerCase();
    for (const act of store.activity.values()) {
      if (act.bgId !== id || act.done) continue;
      act.output = (resultText ?? "").slice(-12000);
      act.updatedAt = now;
      if (status && status !== "running") {
        act.done = true;
        act.failed = status === "failed";
        act.endedAt = now;
      }
    }
  }
  const act = store.activity.get(toolId);
  if (!act || act.done) return;
  act.output = (resultText ?? "").slice(-12000);
  act.updatedAt = now;
  if (!act.bg || tool?.isError) {
    act.done = true;
    act.failed = !!tool?.isError;
    act.endedAt = now;
    store.rev++;
    return;
  }
  const result = rec?.toolUseResult;
  const structuredId = result?.backgroundTaskId ?? result?.agentId;
  if (structuredId) { act.bgId = structuredId; return; }
  if (tool.name === "Bash" && result && typeof result === "object"
      && ("stdout" in result || "stderr" in result) && !("backgroundTaskId" in result)) {
    act.done = true; act.failed = !!result.interrupted; act.endedAt = now; store.rev++;
    return;
  }
  const m = /<(?:task-id|task_id)>\s*([^<\s]+)\s*<\//i.exec(resultText ?? "")
    ?? /\b(?:agentId|task_id|shell_id|bash_id)\s*[:=]\s*([A-Za-z0-9_-]+)/i.exec(resultText ?? "")
    ?? /\b(?:background|agent|task|shell)\s+(?:with\s+)?ID\s*[:=]?\s*([A-Za-z0-9_-]+)/i.exec(resultText ?? "");
  if (m) act.bgId = m[1];
}

function completeByBgId(store, id, details = {}) {
  if (!id) return;
  for (const [toolId, act] of store.activity) {
    if (!act.done && (act.bgId === id || toolId === id)) {
      Object.assign(act, details, { done: true, endedAt: details.updatedAt || Date.now() });
      store.rev++;
    }
  }
}

function completeNotifiedTasks(store, text, timestamp) {
  const before = store.rev;
  const updatedAt = Date.parse(timestamp) || Date.now();
  for (const notice of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const id = /<task-id>\s*([^<]+?)\s*<\/task-id>/.exec(notice[1])?.[1];
    const status = /<status>\s*([^<]+?)\s*<\/status>/.exec(notice[1])?.[1];
    if (["completed", "failed", "killed"].includes(status)) {
      completeByBgId(store, id, { failed: status === "failed", output: notice[1].slice(-12000), updatedAt });
    }
  }
  return store.rev !== before;
}

function applyUser(store, rec) {
  // Meta task notifications still carry authoritative completion events.
  const notificationText = textOf(rec.message?.content);
  completeNotifiedTasks(store, notificationText);
  if (rec.isMeta) return notificationText.includes("<task-notification>");
  const content = rec.message?.content;
  const { sidechain, agentId, agent } = sidechainOf(store, rec);

  // A user record with top-level image block(s) is a pasted/attached-image
  // turn — tool-result images are nested inside a tool_result block, not
  // top-level, so this cleanly targets only what the user sent. Render the
  // image(s) for real and fold them into the optimistic echo (upgrading its
  // local preview to the transcript bytes) so we don't double up.
  if (Array.isArray(content) && content.some((b) => b.type === "image")) {
    const text = cleanImageText(
      unwrapPasted(
        content
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("\n"),
      ),
    );
    // label each image with the marker Claude placed for it, in order
    const nums = tokenNumbers(text);
    const images = content
      .filter((b) => b.type === "image")
      .map((b) => imageUrlFromSource(b.source))
      .filter(Boolean)
      .map((url, k) => ({ url, n: nums[k] }));
    // a sub-agent's records must never confirm (and eat) a pending echo
    let i = sidechain ? -1 : findPending(store, text);
    if (i === -1 && !sidechain) i = store.pending.findIndex((p) => p.images?.length);
    if (i !== -1) {
      const [msg] = store.pending.splice(i, 1);
      if (images.length) msg.images = images;
      if (text) msg.text = text; // Claude's numbering is what the model saw
      msg.local = false;
      msg.failed = false; // a marked-failed send that landed after all
      msg.queued = false;
      msg.rev = ++store.rev;
    } else {
      push(store, { role: "user", kind: "text", text, images, sidechain, agentId, agent });
    }
    return true;
  }

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
          trackToolResult(store, b.tool_use_id, tool, tool.result, rec);
          changed = true;
        }
      } else if (b.type === "text" && b.text?.trim()) {
        const notice = harnessNotice(b.text);
        const chip = commandChip(b.text);
        if (notice) {
          completeNotifiedTasks(store, b.text);
          push(store, { role: "system", kind: "notice", notice, sidechain, agentId, agent });
          changed = true;
        } else if (chip) {
          pushCommandChip(store, chip, sidechain);
          changed = true;
        } else if (!isNoiseUserText(b.text)) {
          const text = unwrapPasted(b.text);
          // a sub-agent's "user" text is its spawn prompt, not something the
          // person typed — it must never confirm (and eat) a pending echo
          if (sidechain || !confirmLocalUser(store, text)) {
            push(store, { role: "user", kind: "text", text, sidechain, agentId, agent });
          }
          changed = true;
        }
      }
    }
  } else if (typeof content === "string" && content.trim()) {
    const notice = harnessNotice(content);
    const chip = commandChip(content);
    if (notice) {
      completeNotifiedTasks(store, content);
      push(store, { role: "system", kind: "notice", notice, sidechain, agentId, agent });
      changed = true;
    } else if (chip) {
      pushCommandChip(store, chip, sidechain);
      changed = true;
    } else if (!isNoiseUserText(content)) {
      const text = unwrapPasted(content);
      if (sidechain || !confirmLocalUser(store, text)) {
        push(store, { role: "user", kind: "text", text, sidechain, agentId, agent });
      }
      changed = true;
    }
  }
  return changed;
}

function applyStreamEvent(store, rec) {
  const ev = rec.event;
  if (!ev) return false;
  // Sub-agent token deltas must not stream into the main agent's draft —
  // that was the most literal form of "suddenly talking to a sub-agent".
  // Their complete records render (folded) when they land.
  if (rec.parent_tool_use_id) return false;
  if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
    if (!store.draft) {
      confirmPending(store); // a reply started — the send definitely landed
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

// Signature that ties a live PreToolUse ping to its later transcript record:
// the questions array is identical in both, so it dedupes even when the hook
// carried no tool_use id.
//
// Key ORDER differs between the two paths, so the stringify must be canonical:
// the hook's copy round-trips through serde_json (a BTreeMap without the
// preserve_order feature — keys come back sorted), while the transcript's is
// JSON.parsed straight from the JSONL in Claude Code's original order. Plain
// JSON.stringify never matched, so every question rendered twice.
const canon = (v) =>
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canon(v[k])]),
        )
      : v;
const askSig = (questions) => JSON.stringify(canon(questions ?? null));

/** A pending AskUserQuestion pushed by the PreToolUse hook, before the
 *  transcript catches up. Renders an answerable card immediately; deduped so
 *  repeated pings (or an already-present transcript record) don't stack. */
export function applyAsk(store, toolId, questions) {
  if (!Array.isArray(questions)) return false;
  const sig = askSig(questions);
  for (const t of store.tools.values()) {
    if (t.name === "AskUserQuestion" && askSig(t.input?.questions) === sig) {
      return false; // already showing this question (synthetic or real)
    }
  }
  const id = toolId || `ask-${store.nextKey}`;
  const tool = { id, name: "AskUserQuestion", input: { questions }, done: false, synthetic: true };
  store.tools.set(id, tool);
  const msg = push(store, { role: "assistant", kind: "tool", tool });
  store.toolMsg.set(id, msg);
  return true;
}

// When the transcript finally delivers the real AskUserQuestion tool_use,
// rebind the synthetic card (matched by identical questions) to the real
// tool_use id so its tool_result lands here — instead of pushing a duplicate.
function adoptSyntheticAsk(store, b) {
  const sig = askSig(b.input?.questions);
  for (const [key, msg] of store.toolMsg) {
    const t = msg.tool;
    if (!t?.synthetic || t.name !== "AskUserQuestion") continue;
    // The hook usually carries the real tool_use_id, so prefer that exact
    // match; the signature is the fallback for hooks that didn't. Without the
    // id check a same-id synthetic card would be silently orphaned below —
    // store.tools.set(b.id, …) would overwrite it and its tool_result would
    // land on the new card, leaving the old one spinning forever.
    if (key === b.id || askSig(t.input?.questions) === sig) {
      store.tools.delete(key);
      store.toolMsg.delete(key);
      t.id = b.id;
      t.input = b.input;
      t.synthetic = false;
      store.tools.set(b.id, t);
      store.toolMsg.set(b.id, msg);
      msg.rev = ++store.rev;
      return true;
    }
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
