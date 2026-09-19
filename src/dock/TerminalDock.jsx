import { useRef } from "react";
import { ArrowsInSimple, ArrowsOutSimple, ArrowClockwise, Plus, X } from "@phosphor-icons/react";
import { XtermInner } from "../AgentPane";
import { isTerminalReport } from "../lib/terminalReports";
import { tauriTransport } from "../lib/transport";

// Bottom terminal dock, Claude-Code-Desktop style: a tab strip of plain
// shells per project, outside the agent grid. Every dock pane stays mounted
// (hidden tabs and other projects' tabs included) so ptys keep flowing and
// tab switches are instant — the same keep-mounted trick the project
// switcher and the Term⇄Chat toggle already rely on; XtermInner's
// hidden→visible resize recovery handles the reveal.
//
// One instance per bench: the local machine gets the default transport, and
// each linked bench gets its own socket, so a dock tab on a VM is the same
// component driving a pty on the other end.

const MIN_H = 120;
const LOCAL_TRANSPORT = tauriTransport();

export default function TerminalDock({
  panes, // all dock panes for this bench, every project
  activePath,
  // Key for the active-tab map. Local docks key by project path; a linked
  // bench folds its url in, because two benches can have the same cwd and
  // pane ids collide across brokers.
  scope = activePath,
  visible, // this bench's project view is the one on screen
  transport = LOCAL_TRANSPORT,
  open,
  height,
  expanded,
  activeTabs, // projectPath -> pane id
  focusedId,
  titles,
  statuses,
  termTheme,
  copyOnSelect,
  scrollback = 2000,
  pageVisible = true,
  initialData,
  onSelectTab,
  onNewTerm,
  onCloseTerm,
  onRestart,
  onToggleExpand,
  onHeightChange,
  onRegister,
  onActivity,
  onTitle,
}) {
  const dockRef = useRef(null);

  const tabs = panes.filter((p) => p.projectPath === activePath);
  const activeId = tabs.some((p) => p.id === activeTabs[scope])
    ? activeTabs[scope]
    : tabs[0]?.id;

  const activePane = tabs.find((p) => p.id === activeId);

  const startHeightDrag = (ev) => {
    ev.preventDefault();
    const grip = ev.currentTarget;
    const y0 = ev.clientY;
    const h0 = dockRef.current?.offsetHeight ?? height;
    const max = Math.max(
      MIN_H,
      (dockRef.current?.parentElement?.clientHeight ?? 800) - 160,
    );
    const onMove = (e) => {
      const h = Math.max(MIN_H, Math.min(max, h0 + (y0 - e.clientY)));
      onHeightChange(h);
    };
    const onUp = (e) => {
      try {
        grip.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = "";
    };
    grip.setPointerCapture(ev.pointerId);
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onUp);
    document.body.style.cursor = "row-resize";
  };

  const shown = visible && open;

  return (
    <div
      ref={dockRef}
      className="dock"
      // hidden, never unmounted — terminals and ptys must survive project
      // switches and dock toggles
      style={{
        display: shown ? undefined : "none",
        // expanded: dominate the content column (the grid keeps a sliver)
        height: expanded ? "78%" : height,
        maxHeight: "calc(100% - 80px)",
      }}
    >
      <div className="dock-resize" onPointerDown={startHeightDrag} />
      <div className="dock-strip">
        {tabs.map((p, i) => (
          <div
            key={p.id}
            className={`dock-tab${p.id === activeId ? " on" : ""}${
              focusedId === p.id ? " focused" : ""
            } status-${statuses[p.id] || "working"}`}
            role="tab"
            title={titles[p.id] || p.label}
            onMouseDown={(ev) => {
              if (ev.button === 1) {
                ev.preventDefault();
                onCloseTerm(p.id);
                return;
              }
              onSelectTab(scope, p.id);
            }}
          >
            <span className="dock-tab-label">
              {titles[p.id] || p.label || `Terminal ${i + 1}`}
            </span>
            <span
              className="dock-tab-x"
              role="button"
              title="Kill shell and close tab"
              onMouseDown={(ev) => {
                ev.stopPropagation();
                onCloseTerm(p.id);
              }}
            >
              <X size={10} weight="bold" />
            </span>
          </div>
        ))}
        <button
          className="dock-new"
          title="New terminal in this project"
          onClick={onNewTerm}
        >
          <Plus size={12} weight="bold" />
        </button>
        <span className="dock-spacer" />
        {activePane?.kind === "run" && (
          <>
            {statuses[activeId] === "exited" && <span className="task-sub">Exited</span>}
            <button className="btn-icon" title="Restart task" onClick={() => onRestart(activePane)}>
              <ArrowClockwise size={13} />
            </button>
          </>
        )}
        <button
          className="btn-icon"
          title={expanded ? "Restore dock height" : "Expand dock"}
          onClick={onToggleExpand}
        >
          {expanded ? <ArrowsInSimple size={13} /> : <ArrowsOutSimple size={13} />}
        </button>
      </div>
      {panes.map((p) => (
        <div
          key={p.id}
          className="dock-body"
          style={{
            display:
              shown && p.projectPath === activePath && p.id === activeId
                ? undefined
                : "none",
          }}
          onMouseDown={() => onActivity(p.id)}
          onContextMenu={(ev) => ev.preventDefault()}
        >
          <XtermInner
            id={p.id}
            cwd={p.projectPath}
            transport={transport}
            visible={pageVisible && shown && p.projectPath === activePath && p.id === activeId}
            scrollback={scrollback}
            termTheme={termTheme}
            copyOnSelect={copyOnSelect}
            initialData={initialData[p.id]}
            register={(h) => onRegister(p.id, h)}
            sendData={(d) => {
              if (!isTerminalReport(d)) onActivity(p.id);
              transport.invoke("write_pane", { id: p.id, data: d }).catch(() => {});
            }}
            onTitle={(t) => onTitle(p.id, t)}
          />
        </div>
      ))}
      {tabs.length === 0 && (
        <div className="dock-empty">
          No terminals yet — <button className="dock-empty-new" onClick={onNewTerm}>open one</button>
        </div>
      )}
    </div>
  );
}
