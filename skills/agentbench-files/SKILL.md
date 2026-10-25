---
name: agentbench-files
description: >-
  Send files back to the user in AgentBench. Use whenever the user asks you to
  send, share, give, export, attach or "get me" a file, or when you produce a
  deliverable they will want to keep (report, export, generated image, build
  artifact, zip). The user is often on a phone or browser with no access to
  this machine's filesystem, so a bare path is not enough.
---

# Sending files to the user

AgentBench's chat renders a markdown link to an **absolute local path** as a
download button. On a phone or in a browser, tapping it downloads the file
from this machine; on the desktop, it reveals the file in Finder/Explorer.
Images render inline, and audio files (mp3, wav, m4a, aac, ogg, opus, flac,
aiff) render as an in-chat player — link them the same way.

## How

1. Make sure the file exists on disk (write it, or copy it somewhere stable if
   it lives in a temp dir that may be cleaned up).
2. In your reply, link to it with its absolute path:

   ```markdown
   [report.pdf](/Users/me/project/out/report.pdf)
   ```

   - Paths with spaces: wrap the target in angle brackets —
     `[Q3 summary.xlsx](</Users/me/Q3 summary.xlsx>)`.
   - `~/…` and `file:///…` targets also work.
   - One link per file; the link text is the button label.
3. To send a folder, zip it first (`zip -r out.zip dir/`) and link the zip.

## Don't

- Don't use relative paths — only absolute paths become download buttons.
- Don't paste a large file's contents into chat instead of linking it.
- Don't wrap the link in a code block (it would render as plain text).
