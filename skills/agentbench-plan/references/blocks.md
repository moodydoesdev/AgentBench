# AgentBench Plan Block Catalog

Authoritative reference for every component available in `plan.mdx`. Plans are
MDX: normal Markdown (headings, lists, tables, links, fenced code) plus these
components. No imports — the registry is built in. Anything not listed here
does not exist.

General rules:

- Multi-line text props use template literals: `` code={`...`} ``.
- Never put raw `{` `}` or `<` in plain MDX prose/children — MDX parses them
  as expressions/JSX. Keep mermaid, code, and trees inside props or fenced
  code blocks.
- `id` props on interactive blocks (`QuestionForm`, `Checklist`, `Options`)
  are required and must be unique within the plan.

## Code (fenced — preferred for plain code)

Normal Markdown fences are syntax-highlighted automatically:

    ```js
    const x = compile(source);
    ```

Supported languages: js, jsx, ts, tsx, json, bash, rust, css, html, sql,
python, diff, markdown. Unknown languages render as plain text.

## Diagram

Mermaid diagram. Code goes in the `code` prop (template literal), never in
children.

```mdx
<Diagram title="Event flow" code={`
graph LR
  agent[Agent pty] --> hook[Hook server]
  hook --> app[App.jsx]
  app --> pane[Plan pane]
`} />
```

Props: `code` (string, required — any mermaid syntax: graph, sequenceDiagram,
erDiagram, stateDiagram, flowchart), `title` (string, optional).

## FileTree

Indented tree, two spaces per level. After the name, separated by two or more
spaces: an optional status token, then an optional description.

```mdx
<FileTree title="Files touched" tree={`
src/
  plan/
    PlanPane.jsx  A  plan pane component, mirrors AgentPane chrome
    registry.js  A  block registry for the MDX runtime
  App.jsx  M  pane kinds + plan-ready listener
  old/
    legacy.js  D
`} />
```

Props: `tree` (string, required), `title` (optional). Status tokens: `A`/`new`
(added, green), `M`/`modified` (amber), `D`/`deleted` (red) — rendered as
badges with +/~/− counts in the header. Text after the status is a per-file
description. Trees longer than 14 rows collapse behind "Show all N rows".

## AnnotatedCode

Code with numbered line callouts.

```mdx
<AnnotatedCode lang="rust" file="src-tauri/src/broker/mod.rs" code={`
fn write_hook_settings(core: &Core, pane_id: u32) {
    let dir = core.config_dir.join("hooks");
}
`} notes={[
  { line: 1, text: "Called once per pane at spawn." },
  { line: 2, text: "Settings dir is created lazily." },
]} />
```

Props: `code` (required), `lang`, `file` (header label), `notes`
(array of `{ line, text }`, 1-based within the snippet).

## Diff

Unified diff with +/- coloring.

```mdx
<Diff file="src/App.jsx" code={`
-  const [panes, setPanes] = useState([]);
+  const [panes, setPanes] = useState([]); // {id, kind, ...}
`} />
```

Props: `code` (required, lines starting with `+`/`-`/` `), `file` (optional).

## Callout

```mdx
<Callout kind="warn" title="Broker restart required">
  The broker daemon survives app restarts; kill it after rebuilding.
</Callout>
```

Props: `kind` — `info` (default, blue) | `warn` (amber) | `danger` (red) |
`success` (green) | `decision` (violet — use for settled strategy calls and
hard-to-reverse choices, with the reasoning in the body); `title` (optional,
renders as a bold lead flowing into the first sentence). Children: Markdown.

## ApiEndpoint

```mdx
<ApiEndpoint method="POST" path="/event/{pane_id}/plan"
  request={`{ "path": "/abs/plan.mdx", "title": "Auth refactor" }`}
  response={`200 (empty body)`}>
  Publishes or refreshes a plan pane.
</ApiEndpoint>
```

Props: `method` (GET/POST/PUT/PATCH/DELETE), `path` (required), `request`,
`response` (template strings, optional). Children: description (Markdown).

## DataModel

```mdx
<DataModel name="PlanPaneState" fields={[
  { name: "id", type: "string", req: true, desc: "\"plan:\" + file path" },
  { name: "agentId", type: "u32", req: true, desc: "owning terminal pane" },
  { name: "title", type: "string", desc: "from the publish payload" },
]} />
```

Props: `name` (required), `fields` (array of `{ name, type, req?, desc? }`).

## QuestionForm (interactive)

The user answers in the pane; answers arrive in your terminal via
`[plan-feedback]`.

```mdx
<QuestionForm id="q-storage" title="Where should sessions live?" mode="single"
  recommended="redis" options={[
    { id: "redis", label: "Redis", desc: "Shared across instances." },
    { id: "jwt", label: "Stateless JWT", desc: "No storage, larger tokens." },
  ]} />
```

Props: `id` (required, unique), `title` (required), `mode` — `single`
(default) | `multi`, `options` (array of `{ id, label, desc? }`, required),
`recommended` (option id, optional — badged in the UI).

## Checklist (interactive)

```mdx
<Checklist id="scope" title="In scope for v1" items={[
  { id: "viewer", label: "MDX plan pane", done: true },
  { id: "canvas", label: "Wireframe canvas" },
]} />
```

Props: `id` (required, unique), `title` (optional), `items` (array of
`{ id, label, done? }`). User toggles are included in feedback.

## Options (interactive decision block)

```mdx
<Options id="engine" title="Rendering engine" recommended="mdx" options={[
  { id: "mdx", label: "Runtime MDX",
    pros: ["Real JSX blocks", "Matches skill format"],
    cons: ["Needs eval at runtime"] },
  { id: "directives", label: "remark-directive",
    pros: ["Plain markdown"], cons: ["Less expressive"] },
]} />
```

Props: `id` (required, unique), `title` (required), `options` (array of
`{ id, label, pros?, cons? }`), `recommended` (option id, optional). The
user's selection is included in feedback.

## Canvas / Artboard / primitives (wireframes)

Top-level wireframe surface for UI plans: a pan/zoom board (left- or
middle-drag or gentle scrolling to pan, pinch or ctrl/cmd+wheel to zoom, zoom
controls bottom-left, drag the bottom edge to resize the board height) with
artboards side by side. Each artboard is its own canvas element with a
hover-revealed Sketch/Clean toggle; `look="clean"` on the Canvas sets the
default for all artboards (prop values stay `sketchy`/`clean`). Primitives
are flexbox only — no coordinates.

The **first** Canvas in a plan automatically becomes the full-bleed top
review surface, rendered edge-to-edge above the document regardless of where
it appears in the MDX. Pass `inline` to keep a canvas in the document flow
instead (use `inline` for secondary canvases next to prose). For UI plans,
lead with the primary Canvas; for non-UI plans, omit canvases entirely.

```mdx
<Canvas title="Dashboard states">
  <Artboard title="Default" surface="desktop">
    <Row>
      <Col w={220} id="sidebar">
        <Text bold>Projects</Text>
        <Divider />
        <Text dim>alpha</Text>
        <Text dim>beta</Text>
      </Col>
      <Col grow>
        <Row>
          <Input placeholder="Search..." />
          <Button primary>New</Button>
        </Row>
        <Img h={160} label="chart" />
        <Box h={80} label="recent activity" />
      </Col>
    </Row>
    <Note target="sidebar">Collapses on mobile</Note>
  </Artboard>
  <Artboard title="Empty state" surface="mobile">
    <Col grow>
      <Text size="lg" bold>No projects yet</Text>
      <Button primary>Add project</Button>
    </Col>
  </Artboard>
</Canvas>
```

- `Canvas` — props: `title` (optional). Children: one or more `Artboard`.
- `Artboard` — props: `title`, `surface` — `desktop` (1200×760, default) |
  `mobile` (390×760) | `browser` (desktop + URL bar).
- `Row` / `Col` — flex containers. Props: `gap` (px, default 8), `id`
  (annotation anchor); `Col` also takes `w` (fixed px) or `grow`.
- `Box` — placeholder region. Props: `h` (px), `label` (centered dim text),
  `id`.
- `Text` — props: `size` — `xs|sm|md|lg|xl` (default `md`), `dim`, `bold`.
  Children: plain text.
- `Button` — props: `primary`, `id`. Children: label text.
- `Input` — props: `placeholder`, `id`.
- `Img` — image placeholder (crossed box). Props: `h` (px), `label`, `id`.
- `Pill` — small tag. Children: text.
- `Divider` — horizontal rule, no props/children.
- `Note` — numbered annotation marker. Props: `target` (an `id` used on a
  primitive in the same artboard, required). Children: the note text. Notes
  render as numbered dots on the wireframe plus a legend below.
