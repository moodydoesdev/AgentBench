---
name: agentbench-plan
description: >-
  Publish rich visual plans inside AgentBench. Write an MDX plan document with
  diagrams, file trees, annotated code, question forms, and wireframes; it
  renders as an interactive plan pane next to your terminal. Use before
  starting non-trivial, ambiguous, multi-file, or UI-heavy work.
---

# AgentBench Visual Plans

You are running inside AgentBench, a multi-agent workspace. Instead of pasting
a long plan into the terminal, publish it as a visual plan: AgentBench renders
your MDX document as a rich, interactive pane next to your terminal. The user
reviews it there, answers your open questions, and their feedback is typed
back into your terminal automatically.

## When to plan

Create a visual plan when the work is non-trivial, ambiguous, risky,
multi-file, or UI-heavy — anywhere the user should see and approve a direction
before you write code. Skip it for trivial, unambiguous changes (typos,
one-line fixes, a single well-specified function): just make the change.
Never pad a plan with filler and never ship a single-step plan.

## Workflow

1. **Research first.** Read the real files, symbols, and patterns before
   drafting. Name actual files and data shapes; never invent them.
2. **Write the plan file** to `.agentbench/plans/<slug>/plan.mdx` inside the
   project (create directories as needed; suggest adding `.agentbench/` to
   `.gitignore` if it isn't ignored). The file is MDX: normal Markdown plus
   the block components documented in `references/blocks.md` — READ that file
   before authoring, do not write blocks from memory.
   - **No `import` or `export` statements.** Components come from a built-in
     registry; an import will fail compilation and the pane will show the
     error instead of your plan.
   - Every interactive block (`QuestionForm`, `Checklist`, `Options`) needs a
     unique `id` prop — feedback is keyed by it.
   - Mermaid/diagram code, file trees, and code passed as props use template
     literals: `code={` + backtick + ... + backtick + `}`.
3. **Publish** by notifying AgentBench (env vars are preset in your shell):

   ```bash
   curl -sf -m 3 -X POST -H 'Content-Type: application/json' \
     -d '{"path":"/abs/path/to/.agentbench/plans/<slug>/plan.mdx","title":"Short plan title"}' \
     "http://127.0.0.1:${AGENTBENCH_HOOK_PORT}/event/${AGENTBENCH_PANE_ID}/plan"
   ```

   `path` must be absolute. The plan pane opens (or refreshes) immediately.
4. **The plan is the approval gate.** After publishing, tell the user the plan
   is ready for review in the plan pane, then WAIT. Do not start implementing.
   Feedback arrives in your terminal as a message starting with
   `[plan-feedback]` — it contains the user's answers to your question forms
   and whether they approved or requested changes.
5. **Updates:** when scope changes or feedback requires revisions, rewrite the
   same `plan.mdx` and re-POST the same curl. The open pane re-renders in
   place. The document is the source of truth — keep it standalone (a reader
   who never saw the chat should understand it) and never phrase it as a diff
   against an earlier draft.

## Fallback

If `AGENTBENCH_HOOK_PORT` or `AGENTBENCH_PANE_ID` is unset, you are not
running inside AgentBench. Skip the curl; write the plan as plain Markdown and
present it in chat as usual.

## Document quality

- Lead with the outcome and a concrete description of what changes for the
  user, then architecture, then steps.
- Prefer prose + the right block over walls of bullets. One diagram per
  genuine relationship; don't decorate.
- For each step, name what it **reuses** (existing files, helpers, patterns)
  before what it adds.
- Put all unresolved decisions in question forms with a recommended default —
  don't ask how to build it in chat when the plan can present options.
- UI work: lead with a `Canvas` wireframe of the primary screen states before
  the implementation details. Non-UI work: no canvas; use inline diagrams
  next to the relevant prose.
