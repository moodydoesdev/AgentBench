// What the agent actually changed: branch, touched files, unified diff.
// This is the review step that used to require walking back to the desk —
// read the diff, then tell the agent "ship it" or what to fix.
import { useEffect, useState } from "react";
import { ArrowClockwise, GitBranch } from "@phosphor-icons/react";

// A 200 KB diff is thousands of lines; past this the phone is the wrong
// review surface anyway.
const MAX_LINES = 4000;

const STATUS_LABEL = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  "??": "new",
};

function DiffBlock({ diff }) {
  const all = diff.split("\n");
  const lines = all.slice(0, MAX_LINES);
  return (
    <pre className="mob-diff">
      {lines.map((l, i) => {
        const cls =
          l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ") || l.startsWith("index ")
            ? "meta"
            : l.startsWith("@@")
              ? "hunk"
              : l.startsWith("+")
                ? "add"
                : l.startsWith("-")
                  ? "del"
                  : "";
        return (
          <div key={i} className={cls || undefined}>
            {l || " "}
          </div>
        );
      })}
      {all.length > MAX_LINES && (
        <div className="meta">… {all.length - MAX_LINES} more lines</div>
      )}
    </pre>
  );
}

export default function ChangesView({ transport, cwd }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setBusy(true);
    transport
      .invoke("git_changes", { cwd })
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setBusy(false));
  };
  useEffect(load, [cwd]);

  if (error) return <div className="mob-warn" style={{ margin: 14 }}>{error}</div>;
  if (!data) return <div className="mob-note" style={{ margin: 14 }}>Reading changes…</div>;
  if (data.git === false)
    return (
      <div className="mob-note" style={{ margin: 14 }}>
        This project isn't a git repository, so there is no diff to show.
      </div>
    );

  const clean = (data.files ?? []).length === 0 && !data.diff?.trim();
  return (
    <div className="mob-changes">
      <div className="mob-changes-head">
        <GitBranch size={13} />
        <span className="mob-mono">{data.branch ?? "?"}</span>
        <span className="mob-spacer" />
        <span className="mob-pill">
          {clean ? "clean" : `${(data.files ?? []).length} file${(data.files ?? []).length === 1 ? "" : "s"}`}
        </span>
        <button className="mob-icon" onClick={load} disabled={busy} aria-label="Refresh">
          <ArrowClockwise size={16} className={busy ? "mob-spin" : undefined} />
        </button>
      </div>
      {clean ? (
        <div className="mob-note" style={{ margin: "0 14px" }}>
          Working tree is clean — nothing uncommitted.
        </div>
      ) : (
        <>
          <div className="mob-changes-files">
            {(data.files ?? []).map((f, i) => (
              <div key={i} className="mob-changes-file">
                <span className={`mob-file-status s-${f.status === "??" ? "new" : (f.status || "x")[0]}`}>
                  {STATUS_LABEL[f.status] ?? f.status}
                </span>
                <span className="mob-mono">{f.path}</span>
              </div>
            ))}
          </div>
          {data.truncated && (
            <div className="mob-note" style={{ margin: "0 14px 8px" }}>
              Diff truncated — it's large; review the tail at the desk.
            </div>
          )}
          {data.diff?.trim() && <DiffBlock diff={data.diff} />}
        </>
      )}
    </div>
  );
}
