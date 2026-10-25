//! Terminal-only dialogs, surfaced to the chat view.
//!
//! Some of Claude's prompts never touch a hook: the "do you trust this folder"
//! check at startup, computer-use access requests, and any other selection
//! menu the TUI draws for itself. They exist only as pixels in the pty, so a
//! chat-view user (and every phone) would sit waiting on a question they can't
//! see. The broker keeps a minimal screen model per pane, spots a `❯` menu on
//! it, and broadcasts it as a `tty-prompt` event the chat renders as a card.
//!
//! The emulator is deliberately small: cursor motion, erase, scroll and text.
//! It only has to be right enough to read the bottom of Claude's screen.

use serde_json::{json, Value};

pub struct Screen {
    rows: usize,
    cols: usize,
    grid: Vec<Vec<char>>,
    row: usize,
    col: usize,
    saved: (usize, usize),
    /// Incomplete escape sequence or UTF-8 tail carried to the next feed.
    pending: Vec<u8>,
}

impl Screen {
    pub fn new(cols: u16, rows: u16) -> Screen {
        let (cols, rows) = (cols.max(10) as usize, rows.max(5) as usize);
        Screen {
            rows,
            cols,
            grid: vec![vec![' '; cols]; rows],
            row: 0,
            col: 0,
            saved: (0, 0),
            pending: Vec::new(),
        }
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        let (cols, rows) = (cols.max(10) as usize, rows.max(5) as usize);
        // keep the bottom of the screen — that's where dialogs live
        while self.grid.len() > rows {
            self.grid.remove(0);
            self.row = self.row.saturating_sub(1);
        }
        while self.grid.len() < rows {
            self.grid.push(vec![' '; cols]);
        }
        for line in &mut self.grid {
            line.resize(cols, ' ');
        }
        self.rows = rows;
        self.cols = cols;
        self.row = self.row.min(rows - 1);
        self.col = self.col.min(cols - 1);
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        let mut data = std::mem::take(&mut self.pending);
        data.extend_from_slice(bytes);
        let mut i = 0;
        while i < data.len() {
            let b = data[i];
            match b {
                0x1b => match self.escape(&data[i..]) {
                    Some(n) => i += n,
                    None => {
                        // cap a runaway unterminated sequence
                        if data.len() - i < 4096 {
                            self.pending = data[i..].to_vec();
                        }
                        return;
                    }
                },
                b'\r' => {
                    self.col = 0;
                    i += 1;
                }
                b'\n' | 0x0b | 0x0c => {
                    self.line_feed();
                    i += 1;
                }
                0x08 => {
                    self.col = self.col.saturating_sub(1);
                    i += 1;
                }
                b'\t' => {
                    self.col = ((self.col / 8 + 1) * 8).min(self.cols - 1);
                    i += 1;
                }
                0..=0x1f | 0x7f => i += 1,
                _ => {
                    let len = utf8_len(b);
                    if i + len > data.len() {
                        self.pending = data[i..].to_vec();
                        return;
                    }
                    let ch = std::str::from_utf8(&data[i..i + len])
                        .ok()
                        .and_then(|s| s.chars().next())
                        .unwrap_or('?');
                    self.put(ch);
                    i += len;
                }
            }
        }
    }

    fn put(&mut self, ch: char) {
        if self.col >= self.cols {
            self.col = 0;
            self.line_feed();
        }
        self.grid[self.row][self.col] = ch;
        self.col += 1;
    }

    fn line_feed(&mut self) {
        if self.row + 1 >= self.rows {
            self.grid.remove(0);
            self.grid.push(vec![' '; self.cols]);
        } else {
            self.row += 1;
        }
    }

    /// Consume one escape sequence starting at `s[0] == ESC`. Returns its
    /// length, or None when it is incomplete.
    fn escape(&mut self, s: &[u8]) -> Option<usize> {
        let kind = *s.get(1)?;
        match kind {
            b'[' => {
                let mut j = 2;
                while j < s.len() && !(0x40..=0x7e).contains(&s[j]) {
                    j += 1;
                }
                let fin = *s.get(j)?;
                let raw = std::str::from_utf8(&s[2..j]).unwrap_or("");
                self.csi(raw, fin);
                Some(j + 1)
            }
            // OSC / DCS / APC / PM / SOS: skip to BEL or ST
            b']' | b'P' | b'_' | b'^' | b'X' => {
                let mut j = 2;
                while j < s.len() {
                    if s[j] == 0x07 {
                        return Some(j + 1);
                    }
                    if s[j] == 0x1b && s.get(j + 1) == Some(&b'\\') {
                        return Some(j + 2);
                    }
                    j += 1;
                }
                None
            }
            b'7' => {
                self.saved = (self.row, self.col);
                Some(2)
            }
            b'8' => {
                (self.row, self.col) = self.saved;
                Some(2)
            }
            // charset designations carry one more byte
            b'(' | b')' | b'*' | b'+' | b'#' | b'%' => s.get(2).map(|_| 3),
            _ => Some(2),
        }
    }

    fn csi(&mut self, raw: &str, fin: u8) {
        let private = raw.starts_with(['?', '>', '<', '=']);
        let params: Vec<usize> = raw
            .trim_start_matches(['?', '>', '<', '='])
            .split(';')
            .map(|p| p.parse().unwrap_or(0))
            .collect();
        let p = |i: usize, d: usize| params.get(i).copied().filter(|&v| v != 0).unwrap_or(d);
        let (rows, cols) = (self.rows, self.cols);
        if private {
            // alternate screen in or out: either way, a fresh canvas
            if (fin == b'h' || fin == b'l') && params.contains(&1049) {
                self.clear(0, rows);
                self.row = 0;
                self.col = 0;
            }
            return;
        }
        match fin {
            b'A' => self.row = self.row.saturating_sub(p(0, 1)),
            b'B' | b'e' => self.row = (self.row + p(0, 1)).min(rows - 1),
            b'C' | b'a' => self.col = (self.col + p(0, 1)).min(cols - 1),
            b'D' => self.col = self.col.saturating_sub(p(0, 1)),
            b'E' => {
                self.row = (self.row + p(0, 1)).min(rows - 1);
                self.col = 0;
            }
            b'F' => {
                self.row = self.row.saturating_sub(p(0, 1));
                self.col = 0;
            }
            b'G' | b'`' => self.col = (p(0, 1) - 1).min(cols - 1),
            b'd' => self.row = (p(0, 1) - 1).min(rows - 1),
            b'H' | b'f' => {
                self.row = (p(0, 1) - 1).min(rows - 1);
                self.col = (p(1, 1) - 1).min(cols - 1);
            }
            b'J' => match params.first().copied().unwrap_or(0) {
                0 => {
                    self.erase_line(self.row, self.col.min(cols), cols);
                    self.clear(self.row + 1, rows);
                }
                1 => {
                    self.clear(0, self.row);
                    self.erase_line(self.row, 0, (self.col + 1).min(cols));
                }
                _ => self.clear(0, rows),
            },
            b'K' => match params.first().copied().unwrap_or(0) {
                0 => self.erase_line(self.row, self.col.min(cols), cols),
                1 => self.erase_line(self.row, 0, (self.col + 1).min(cols)),
                _ => self.erase_line(self.row, 0, cols),
            },
            b'X' => {
                let end = (self.col + p(0, 1)).min(cols);
                self.erase_line(self.row, self.col.min(cols), end);
            }
            b'L' => {
                for _ in 0..p(0, 1).min(rows - self.row) {
                    self.grid.pop();
                    self.grid.insert(self.row, vec![' '; cols]);
                }
            }
            b'M' => {
                for _ in 0..p(0, 1).min(rows - self.row) {
                    self.grid.remove(self.row);
                    self.grid.push(vec![' '; cols]);
                }
            }
            b'S' => {
                for _ in 0..p(0, 1).min(rows) {
                    self.grid.remove(0);
                    self.grid.push(vec![' '; cols]);
                }
            }
            b'T' => {
                for _ in 0..p(0, 1).min(rows) {
                    self.grid.pop();
                    self.grid.insert(0, vec![' '; cols]);
                }
            }
            b's' => self.saved = (self.row, self.col),
            b'u' => (self.row, self.col) = self.saved,
            _ => {}
        }
    }

    fn clear(&mut self, from: usize, to: usize) {
        for r in from..to.min(self.rows) {
            self.grid[r].iter_mut().for_each(|c| *c = ' ');
        }
    }

    fn erase_line(&mut self, r: usize, from: usize, to: usize) {
        if r < self.rows {
            for c in from..to.min(self.cols) {
                self.grid[r][c] = ' ';
            }
        }
    }

    fn lines(&self) -> Vec<String> {
        self.grid
            .iter()
            .map(|l| l.iter().collect::<String>().trim_end().to_string())
            .collect()
    }
}

fn utf8_len(b: u8) -> usize {
    match b {
        0xc0..=0xdf => 2,
        0xe0..=0xef => 3,
        0xf0..=0xf7 => 4,
        _ => 1,
    }
}

const POINTER: char = '❯';

fn indent(s: &str) -> usize {
    s.chars().take_while(|c| *c == ' ').count()
}

fn is_rule(s: &str) -> bool {
    let t = s.trim();
    t.chars().count() >= 10
        && t.chars().all(|c| matches!(c, '─' | '━' | '═' | '╌' | '╭' | '╮' | '╰' | '╯' | '┌' | '┐' | '└' | '┘'))
}

/// Strip a box border (`│ text │`) so dialog text reads clean.
fn unbox(s: &str) -> String {
    s.trim()
        .trim_start_matches(['│', '┃'])
        .trim_end_matches(['│', '┃'])
        .trim()
        .to_string()
}

/// "1. Yes" -> ("Yes", true)
fn strip_number(s: &str) -> (String, bool) {
    let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
    if !digits.is_empty() {
        if let Some(rest) = s[digits.len()..].strip_prefix(". ") {
            return (rest.trim().to_string(), true);
        }
    }
    (s.trim().to_string(), false)
}

/// The selection dialog currently on screen, if any:
/// `{ title, body, options: [{label, description}], selected, sig }`.
pub fn detect(screen: &Screen) -> Option<Value> {
    let lines: Vec<String> = screen.lines().iter().map(|l| unbox_left(l)).collect();
    let bottom = lines.iter().rposition(|l| !l.trim().is_empty())?;
    // Only the lower part of the screen: an old menu scrolled up into the
    // history is not waiting on anyone.
    let top = bottom.saturating_sub(40);
    let footer = (top..=bottom).rev().find(|&r| {
        let l = &lines[r];
        l.contains("Esc to cancel") || l.contains("Enter to confirm") || l.contains("Enter to select")
    });
    let search_end = footer.unwrap_or(bottom);
    let cursor = (top..=search_end).rev().find(|&r| {
        let l = &lines[r];
        let ind = indent(l);
        ind <= 6 && l[ind..].starts_with(POINTER) && l[ind..].chars().nth(1) == Some(' ')
    })?;
    // A footer must sit just under the menu, not belong to something else.
    if let Some(f) = footer {
        if f - cursor > 30 {
            return None;
        }
    }
    let ptr_col = indent(&lines[cursor]);
    let text_col = lines[cursor].chars().skip(ptr_col + 1).take_while(|c| *c == ' ').count() + ptr_col + 1;

    // An option row: pointer or blank at ptr_col, text starting at text_col.
    let option_at = |r: usize| -> Option<String> {
        let l: Vec<char> = lines[r].chars().collect();
        if l.len() <= text_col || l[text_col] == ' ' {
            return None;
        }
        let lead: String = l[..text_col].iter().collect();
        let lead_ok = lead.trim().is_empty() || lead.trim() == POINTER.to_string();
        lead_ok.then(|| l[text_col..].iter().collect::<String>().trim_end().to_string())
    };
    let is_desc = |r: usize| -> bool {
        let l = &lines[r];
        !l.trim().is_empty() && indent(l) > text_col
    };

    let mut first = cursor;
    while first > top && (option_at(first - 1).is_some() || is_desc(first - 1)) {
        first -= 1;
    }
    let mut last = cursor;
    while last < bottom && (option_at(last + 1).is_some() || is_desc(last + 1)) {
        last += 1;
    }
    let mut options: Vec<Value> = Vec::new();
    let mut selected = 0;
    let mut numbered = false;
    for r in first..=last {
        if let Some(label) = option_at(r) {
            let (label, num) = strip_number(&label);
            numbered |= num;
            if r == cursor {
                selected = options.len();
            }
            options.push(json!({ "label": label, "description": "" }));
        } else if let Some(o) = options.last_mut() {
            let d = o["description"].as_str().unwrap_or("").to_string();
            let add = lines[r].trim();
            o["description"] = json!(if d.is_empty() { add.to_string() } else { format!("{d} {add}") });
        }
    }
    if options.len() < 2 || (footer.is_none() && !numbered) {
        return None;
    }

    // Question text: everything above the options back to a rule or box top.
    let mut start = first;
    while start > top && start + 25 > first && !is_rule(&lines[start - 1]) {
        start -= 1;
    }
    let mut text: Vec<String> = Vec::new();
    for l in &lines[start..first] {
        let t = unbox(l);
        if t.is_empty() && text.last().is_none_or(|p: &String| p.is_empty()) {
            continue;
        }
        text.push(t);
    }
    while text.last().is_some_and(|t| t.is_empty()) {
        text.pop();
    }
    let title = if text.is_empty() { "Claude needs your approval".to_string() } else { text.remove(0) };
    while text.first().is_some_and(|t| t.is_empty()) {
        text.remove(0);
    }
    let body = text.join("\n");
    // The signature names the question, not the cursor: moving the selection
    // is the same prompt, answering it is a different screen.
    let labels: Vec<&str> = options.iter().filter_map(|o| o["label"].as_str()).collect();
    let sig = format!("{title}\u{1f}{}", labels.join("\u{1f}"));
    Some(json!({
        "title": title,
        "body": body,
        "options": options,
        "selected": selected,
        "sig": sig,
    }))
}

/// Box borders on the left would push the pointer past its column limit.
fn unbox_left(l: &str) -> String {
    let t = l.trim_start();
    if let Some(rest) = t.strip_prefix(['│', '┃']) {
        let lead = l.len() - t.len();
        // keep column positions: replace the border with a space
        format!("{}{}{}", " ".repeat(lead), " ", rest.trim_end().trim_end_matches(['│', '┃']).trim_end())
    } else {
        l.to_string()
    }
}

/// Keys that move the pointer from `from` to `to` and confirm.
pub fn answer_keys(from: usize, to: usize) -> Vec<&'static str> {
    let mut keys = Vec::new();
    if to > from {
        keys.extend(std::iter::repeat_n("\x1b[B", to - from));
    } else {
        keys.extend(std::iter::repeat_n("\x1b[A", from - to));
    }
    keys.push("\r");
    keys
}

#[cfg(test)]
mod tests {
    use super::*;

    // Captured from Claude Code 2.x starting in an untrusted folder.
    const TRUST: &[u8] = b"\x1b7\x1b[r\x1b8\x1b[?25h\x1b[?25l\x1b[?2004h\r\r\n\x1b[38;2;255;193;7m\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\x1b[39m\r\r\n\x1b[2G\x1b[1mAccessing\x1b[12Gworkspace:\x1b[22m\r\r\n\r\r\n\x1b[2G\x1b[1m/tmp/x\x1b[22m\r\r\n\r\r\n\x1b[2GQuick\x1b[8Gsafety\x1b[15Gcheck:\r\r\n\r\r\n\x1b[2G\x1b[38;2;177;185;249m\xe2\x9d\xaf\x1b[4GNo,\x1b[8Gexit\x1b[39m\r\r\n\x1b[4GYes,\x1b[9GI\x1b[11Gtrust\x1b[17Gthis\x1b[22Gfolder\r\r\n\r\r\n\x1b[2G\x1b[38;2;153;153;153mEnter\x1b[8Gto\x1b[11Gconfirm\x1b[19G\xc2\xb7\x1b[21GEsc\x1b[25Gto\x1b[28Gcancel\x1b[39m\r\r\n\x1b[1C\x1b[4A";

    #[test]
    fn trust_dialog() {
        let mut s = Screen::new(100, 40);
        s.feed(TRUST);
        let p = detect(&s).expect("trust prompt");
        assert_eq!(p["title"], "Accessing workspace:");
        assert_eq!(p["options"][0]["label"], "No, exit");
        assert_eq!(p["options"][1]["label"], "Yes, I trust this folder");
        assert_eq!(p["selected"], 0);
        assert!(p["body"].as_str().unwrap().contains("Quick safety check:"));
    }

    #[test]
    fn split_feed_and_cursor_move() {
        let mut s = Screen::new(100, 40);
        let (a, b) = TRUST.split_at(200);
        s.feed(a);
        s.feed(b);
        assert!(detect(&s).is_some());
        // pointer moves to option 2 via a diff redraw of two rows
        s.feed(b"\x1b[9H\r\x1b[2K\x1b[4GNo, exit\r\n\x1b[2K\x1b[2G\xe2\x9d\xaf\x1b[4GYes, I trust this folder\r\n");
        assert_eq!(detect(&s).unwrap()["selected"], 1);
    }

    #[test]
    fn numbered_permission_box() {
        let mut s = Screen::new(80, 20);
        s.feed("╭──────────────────────────╮\r\n│ Computer use             │\r\n│ Allow access to Safari?  │\r\n│ ❯ 1. Yes                 │\r\n│   2. No                  │\r\n╰──────────────────────────╯\r\n".as_bytes());
        let p = detect(&s).expect("box prompt");
        assert_eq!(p["title"], "Computer use");
        assert_eq!(p["body"], "Allow access to Safari?");
        assert_eq!(p["options"][1]["label"], "No");
    }

    #[test]
    fn input_box_is_not_a_prompt() {
        let mut s = Screen::new(80, 20);
        s.feed("────────────────────\r\n❯ hello\r\n  more text\r\n────────────────────\r\n  ? for shortcuts\r\n".as_bytes());
        assert!(detect(&s).is_none());
    }

    // Live capture: initial draw, then the diff redraw after one Down arrow.
    #[test]
    fn live_arrow_redraw() {
        let mut s = Screen::new(90, 30);
        s.feed(b"\x1b7\x1b[r\x1b8\x1b[?25h\x1b[?25l\x1b[?2004h\x1b[?2031h\x1b[?1004h\x0d\x0d\x0a\x1b[38;2;255;193;7m\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\x1b[39m\x0d\x0d\x0a\x1b[2G\x1b[38;2;255;193;7m\x1b[1mAccessing\x1b[12Gworkspace:\x1b[22m\x1b[39m\x0d\x0d\x0a\x0d\x0d\x0a\x1b[2G\x1b[1m/tmp/trusttest\x1b[22m\x0d\x0d\x0a\x0d\x0d\x0a\x1b[2GQuick\x1b[8Gsafety\x1b[15Gcheck:\x1b[22GIs\x1b[25Gthis\x1b[30Ga\x1b[32Gproject\x1b[40Gyou\x1b[44Gcreated\x1b[52Gor\x1b[55Gone\x1b[59Gyou\x1b[63Gtrust?\x1b[70G(Like\x1b[76Gyour\x1b[81Gown\x1b[85Gcode,\x0d\x0d\x0a\x1b[2Ga\x1b[4Gwell-known\x1b[15Gopen\x1b[20Gsource\x1b[27Gproject,\x1b[36Gor\x1b[39Gwork\x1b[44Gfrom\x1b[49Gyour\x1b[54Gteam).\x1b[61GIf\x1b[64Gnot,\x1b[69Gtake\x1b[74Ga\x1b[76Gmoment\x1b[83Gto\x0d\x0d\x0a\x1b[2Greview\x1b[9Gwhat's\x1b[16Gin\x1b[19Gthis\x1b[24Gfolder\x1b[31Gfirst.\x0d\x0d\x0a\x0d\x0d\x0a\x1b[2GClaude\x1b[9GCode'll\x1b[17Gbe\x1b[20Gable\x1b[25Gto\x1b[28Gread,\x1b[34Gedit,\x1b[40Gand\x1b[44Gexecute\x1b[52Gfiles\x1b[58Ghere.\x0d\x0d\x0a\x0d\x0d\x0a\x1b[2G\x1b[38;2;153;153;153mSecurity\x1b[11Gguide\x1b[39m\x0d\x0d\x0a\x0d\x0d\x0a\x1b[2G\x1b[38;2;177;185;249m\xe2\x9d\xaf\x1b[4GNo,\x1b[8Gexit\x1b[39m\x0d\x0d\x0a\x1b[4GYes,\x1b[9GI\x1b[11Gtrust\x1b[17Gthis\x1b[22Gfolder\x0d\x0d\x0a\x0d\x0d\x0a\x1b[2G\x1b[38;2;153;153;153mEnter\x1b[8Gto\x1b[11Gconfirm\x1b[19G\xc2\xb7\x1b[21GEsc\x1b[25Gto\x1b[28Gcancel\x1b[39m\x0d\x0d\x0a\x1b[1C\x1b[4A\x1b[>0q\x1b[?u\x1b[c");
        assert_eq!(detect(&s).expect("initial")["selected"], 0);
        s.feed(b"\x1b(B\x0f\x1b[?2004h\x1b[1D\x1b[4B\x0d\x1b[1C\x1b[4A \x1b[4GNo, exit\x0d\x1b[1C\x1b[1B\x1b[38;2;177;185;249m\xe2\x9d\xaf\x1b[4GYes, I trust this folder\x1b[39m\x0d\x0d\x0a\x0d\x0a\x0d\x0a\x1b[1C\x1b[3A");
        let p = detect(&s).expect("after arrow");
        assert_eq!(p["selected"], 1);
        assert_eq!(p["options"][1]["label"], "Yes, I trust this folder");
    }

    #[test]
    fn keys() {
        assert_eq!(answer_keys(0, 2), vec!["\x1b[B", "\x1b[B", "\r"]);
        assert_eq!(answer_keys(1, 0), vec!["\x1b[A", "\r"]);
    }
}
