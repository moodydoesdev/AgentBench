// Dev-only harness: `?window=plan-test` renders every block outside Tauri so
// the plan renderer can be smoke-tested in a plain browser.
import PlanRenderer from "./PlanRenderer";
import "./plan.css";

const FIXTURE = `
# Auth refactor — visual plan

Move session handling out of the request loop. This plan exercises **every**
plan block for smoke testing.

<Callout kind="warn" title="Broker restart required">
  The broker daemon survives app restarts — kill it after rebuilding.
</Callout>

## Architecture

<Diagram title="Event flow" code={\`
graph LR
  agent[Agent pty] --> hook[Hook server]
  hook --> app[App.jsx]
  app --> pane[Plan pane]
\`} />

<FileTree title="Files touched" tree={\`
src/
  plan/
    PlanPane.jsx  A  plan pane component, mirrors AgentPane chrome
    registry.js  A  block registry for the MDX runtime
  App.jsx  M  pane kinds + plan-ready listener
  old/
    legacy.js  D
\`} />

## Code

\`\`\`js
const mod = await evaluate(source, { ...runtime, format: "mdx" });
\`\`\`

<AnnotatedCode lang="rust" file="src-tauri/src/broker/mod.rs" code={\`
fn claude_command(cwd: &str, pane_id: u32) {
    cmd.env("AGENTBENCH_PANE_ID", pane_id.to_string());
}
\`} notes={[
  { line: 1, text: "Called once per pane at spawn." },
  { line: 2, text: "Env var the skill reads for the curl handshake." },
]} />

<Diff file="src/App.jsx" code={\`
-  const [panes, setPanes] = useState([]);
+  const [panes, setPanes] = useState([]); // agent | plan panes
   const unchanged = true;
\`} />

## API & data

<ApiEndpoint method="POST" path="/event/{pane_id}/plan"
  request={\`{ "path": "/abs/plan.mdx", "title": "Auth refactor" }\`}
  response={\`200 (empty body)\`}>
  Publishes or refreshes a plan pane.
</ApiEndpoint>

<DataModel name="PlanPaneState" fields={[
  { name: "id", type: "string", req: true, desc: "plan: + file path" },
  { name: "agentId", type: "u32", req: true, desc: "owning terminal pane" },
  { name: "title", type: "string", desc: "from the publish payload" },
]} />

| col a | col b |
| ----- | ----- |
| gfm   | works |

## Wireframes

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
          <Input placeholder="Search…" />
          <Button primary>New</Button>
          <Pill>beta</Pill>
        </Row>
        <Img h={140} label="chart" />
        <Box h={70} label="recent activity" />
      </Col>
    </Row>
    <Note target="sidebar">Collapses on mobile</Note>
  </Artboard>
  <Artboard title="Empty" surface="mobile">
    <Col grow>
      <Text size="lg" bold>No projects yet</Text>
      <Button primary>Add project</Button>
    </Col>
  </Artboard>
</Canvas>

## Open questions

<QuestionForm id="q-storage" title="Where should sessions live?" mode="single"
  recommended="redis" options={[
    { id: "redis", label: "Redis", desc: "Shared across instances." },
    { id: "jwt", label: "Stateless JWT", desc: "No storage, larger tokens." },
  ]} />

<Options id="engine" title="Rendering engine" recommended="mdx" options={[
  { id: "mdx", label: "Runtime MDX", pros: ["Real JSX blocks"], cons: ["Runtime eval"] },
  { id: "directives", label: "remark-directive", pros: ["Plain markdown"], cons: ["Less expressive"] },
]} />

<Checklist id="scope" title="In scope for v1" items={[
  { id: "viewer", label: "MDX plan pane", done: true },
  { id: "canvas", label: "Wireframe canvas" },
]} />
`;

export default function PlanTestHarness() {
  return (
    <div
      className="plan-body"
      style={{ height: "100vh", background: "var(--panel)" }}
    >
      <PlanRenderer
        source={FIXTURE}
        title="Harness plan"
        onSend={(text) => console.log("[plan-feedback-out]\n" + text)}
      />
    </div>
  );
}
