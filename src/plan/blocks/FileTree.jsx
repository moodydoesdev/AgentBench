import { useState } from "react";
import { Folder, File, CaretDown } from "@phosphor-icons/react";

// trailing annotation: optional status token, then optional description
const STATUS = {
  new: { letter: "A", triple: "--green" },
  A: { letter: "A", triple: "--green" },
  added: { letter: "A", triple: "--green" },
  modified: { letter: "M", triple: "--amber" },
  M: { letter: "M", triple: "--amber" },
  deleted: { letter: "D", triple: "--red" },
  D: { letter: "D", triple: "--red" },
};

const COLLAPSED_ROWS = 14;

function parseTree(tree) {
  return String(tree)
    .split("\n")
    .filter((l) => l.trim())
    .map((line) => {
      const depth = Math.floor((line.length - line.trimStart().length) / 2);
      const body = line.trim();
      const m = /^(\S+)(?:\s{2,}(\S+))?(?:\s{2,}(.+))?$/.exec(body);
      const name = m?.[1] ?? body;
      let status = m?.[2] ? STATUS[m[2]] : undefined;
      // second token wasn't a status keyword → whole tail is the description
      let desc = m?.[3];
      if (m?.[2] && !status) desc = [m[2], m[3]].filter(Boolean).join(" ");
      return { depth, name, status, desc, dir: name.endsWith("/") };
    });
}

export function FileTree({ tree = "", title }) {
  const rows = parseTree(tree);
  const [open, setOpen] = useState(rows.length <= COLLAPSED_ROWS);
  const shown = open ? rows : rows.slice(0, COLLAPSED_ROWS);
  const files = rows.filter((r) => !r.dir);
  const added = files.filter((r) => r.status?.letter === "A").length;
  const modified = files.filter((r) => r.status?.letter === "M").length;
  const deleted = files.filter((r) => r.status?.letter === "D").length;

  return (
    <figure className="plan-filetree">
      {title && <figcaption className="plan-block-title">{title}</figcaption>}
      <div className="plan-filetree-head">
        <span>
          {files.length} file{files.length === 1 ? "" : "s"}
        </span>
        <span className="plan-filetree-counts">
          {added > 0 && <span className="c-green">+{added}</span>}
          {modified > 0 && <span className="c-amber">~{modified}</span>}
          {deleted > 0 && <span className="c-red">−{deleted}</span>}
        </span>
      </div>
      <div className="plan-filetree-rows">
        {shown.map((r, i) => (
          <div
            key={i}
            className="plan-filetree-row"
            style={{ paddingLeft: r.depth * 16 }}
          >
            {r.dir ? (
              <Folder size={12} className="plan-filetree-icon dir" />
            ) : (
              <File size={12} className="plan-filetree-icon" />
            )}
            <span className={r.dir ? "plan-filetree-dir" : "plan-filetree-file"}>
              {r.name}
            </span>
            {r.status && (
              <span
                className="plan-filetree-badge"
                style={{
                  color: `rgb(var(${r.status.triple}))`,
                  background: `rgba(var(${r.status.triple}), 0.12)`,
                }}
              >
                {r.status.letter}
              </span>
            )}
            {r.desc && <span className="plan-filetree-desc">{r.desc}</span>}
          </div>
        ))}
      </div>
      {!open && (
        <button
          type="button"
          className="plan-expand"
          onClick={() => setOpen(true)}
        >
          <CaretDown size={11} weight="bold" /> Show all {rows.length} rows
        </button>
      )}
    </figure>
  );
}
