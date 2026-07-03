import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import {
  BellSimple,
  Keyboard,
  PaintBrushBroad,
  Robot,
  SquaresFour,
} from "@phosphor-icons/react";
import { THEMES, themeVars } from "./themes";
import {
  PROBEABLE,
  SETTINGS_KEY,
  getHarnesses,
  harnessBin,
  loadSettings,
} from "./settings";
import { themeVarsFromImage } from "./lib/autoTheme";
import { formatHotkey, hotkeyFromEvent } from "./lib/hotkey";
import WindowControls from "./components/WindowControls";
import notifyWav from "./assets/notify.wav";

const IS_MAC = navigator.userAgent.includes("Mac");
const IS_WINDOWS = navigator.userAgent.includes("Windows");

// Constructed on first preview so the wav isn't fetched at window load.
let ping = null;

const NAV_MODS = [
  ["off", "Off"],
  ["ctrl", "⌃ Ctrl"],
  ["alt", "⌥ Alt"],
  ["meta", "⌘ Cmd"],
];
const NAV_MOD_SYMBOL = { ctrl: "⌃", alt: "⌥", meta: "⌘" };

// Click to arm, then the next modifier+key combo becomes the hotkey.
// Escape cancels; bare keys are ignored so recording can't eat typing.
function HotkeyRecorder({ value, onChange }) {
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(false);
        return;
      }
      const combo = hotkeyFromEvent(e);
      if (combo) {
        onChange(combo);
        setRecording(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, onChange]);

  return (
    <button
      className={`hotkey-recorder ${recording ? "recording" : ""}`}
      onClick={() => setRecording((r) => !r)}
    >
      {recording ? "Press keys…" : <kbd>{formatHotkey(value)}</kbd>}
    </button>
  );
}

function Toggle({ on, onClick }) {
  return (
    <button className={`toggle ${on ? "on" : ""}`} onClick={onClick}>
      <span className="toggle-knob" />
    </button>
  );
}

// One consistent row: title + optional sub on the left, control on the
// right; `stack` puts the control full-width below for wide pickers.
function Row({ title, sub, stack, children }) {
  return (
    <div className={`settings-row ${stack ? "stack" : ""}`}>
      <div className="settings-row-text">
        <div className="settings-row-title">{title}</div>
        {sub && <div className="settings-row-sub">{sub}</div>}
      </div>
      {children}
    </div>
  );
}

function Card({ title, children }) {
  return (
    <div className="settings-card">
      {title && <div className="settings-card-head">{title}</div>}
      {children}
    </div>
  );
}

function Segmented({ value, options, onChange }) {
  return (
    <div className="col-picker">
      {options.map(([v, label]) => (
        <button
          key={v}
          className={value === v ? "on" : ""}
          onClick={() => onChange(v)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Slider({ value, min = 0, max = 1, step = 0.05, onChange, onCommit }) {
  const fill = ((value - min) / (max - min)) * 100;
  return (
    <input
      type="range"
      className="volume-slider"
      min={min}
      max={max}
      step={step}
      value={value}
      style={{ "--fill": `${fill}%` }}
      onChange={(ev) => onChange(Number(ev.target.value))}
      onMouseUp={onCommit}
    />
  );
}

const SECTIONS = [
  { id: "appearance", label: "Appearance", icon: PaintBrushBroad },
  { id: "workspace", label: "Workspace", icon: SquaresFour },
  { id: "agents", label: "Agents", icon: Robot },
  { id: "notifications", label: "Notifications", icon: BellSimple },
  { id: "keyboard", label: "Keyboard", icon: Keyboard },
];

export default function SettingsWindow() {
  const [settings, setSettings] = useState(loadSettings);
  const [section, setSection] = useState("appearance");
  const [avail, setAvail] = useState(null); // Set of bins found on PATH
  const [installing, setInstalling] = useState({}); // harness id -> true
  const [installErr, setInstallErr] = useState({}); // harness id -> message

  const set = (patch) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    emit("settings-changed", next).catch(() => {});
  };

  const probeHarnesses = () => {
    const bins = [
      ...new Set(
        getHarnesses(loadSettings())
          .map(harnessBin)
          .filter((b) => PROBEABLE.test(b)),
      ),
    ];
    if (!bins.length) return;
    invoke("check_binaries", { bins })
      .then((found) => setAvail(new Set(found)))
      .catch(() => {});
  };

  // probe when the Agents section is opened, not on hidden-window preload
  useEffect(() => {
    if (section === "agents") probeHarnesses();
  }, [section]);

  const installHarness = async (h) => {
    setInstalling((m) => ({ ...m, [h.id]: true }));
    setInstallErr(({ [h.id]: _gone, ...rest }) => rest);
    try {
      await invoke("install_harness", {
        command: h.install,
        shell: settings.shell?.trim() || null,
      });
    } catch (e) {
      setInstallErr((m) => ({ ...m, [h.id]: String(e) }));
    }
    setInstalling((m) => ({ ...m, [h.id]: false }));
    probeHarnesses();
  };

  // Mirror the main window's theming so this window matches instantly.
  useEffect(() => {
    const vars = themeVars(settings);
    const root = document.documentElement;
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  }, [settings.theme, settings.autoThemeVars]);

  // The window is pre-spawned hidden and reused: Escape and the close
  // button hide it so the next open is instant.
  useEffect(() => {
    const win = getCurrentWindow();
    const onKey = (e) => {
      if (e.key === "Escape") win.hide();
    };
    window.addEventListener("keydown", onKey);
    let unClose;
    win
      .onCloseRequested((e) => {
        e.preventDefault();
        win.hide();
      })
      .then((fn) => {
        unClose = fn;
      });
    return () => {
      window.removeEventListener("keydown", onKey);
      unClose?.();
    };
  }, []);

  // While hidden, adopt settings changed elsewhere so the window never
  // shows stale state.
  useEffect(() => {
    const un = listen("settings-changed", (e) => setSettings(e.payload));
    return () => {
      un.then((f) => f());
    };
  }, []);

  const pickBgImage = async () => {
    const file = await open({
      title: "Choose a background image",
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"] },
      ],
    }).catch(() => null);
    if (!file) return;
    const patch = { bgImage: file };
    // theme is following the wallpaper — re-sample it for the new image
    if (settings.theme === "auto") {
      patch.autoThemeVars = await themeVarsFromImage(file).catch(
        () => settings.autoThemeVars,
      );
    }
    set(patch);
  };

  const matchWallpaper = async () => {
    if (!settings.bgImage) return;
    try {
      const vars = await themeVarsFromImage(settings.bgImage);
      set({ theme: "auto", autoThemeVars: vars });
    } catch (e) {
      console.error("wallpaper theme sampling failed", e);
    }
  };

  const previewSound = () => {
    if (!ping) ping = new Audio(notifyWav);
    ping.volume = settings.volume ?? 0.8;
    ping.currentTime = 0;
    ping.play().catch(() => {});
  };

  return (
    <div className="settings-window">
      <header
        className={`settings-titlebar${IS_MAC ? " mac" : ""}`}
        data-tauri-drag-region
      >
        <span className="settings-titlebar-label" data-tauri-drag-region>
          Settings
        </span>
        {IS_WINDOWS && <WindowControls />}
      </header>

      <div className="settings-body">
        <aside className="settings-nav">
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`settings-nav-item ${section === id ? "on" : ""}`}
              onClick={() => setSection(id)}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </aside>

        <main className="settings-content">
        {section === "appearance" && (
          <section className="settings-section">
            <h2>Appearance</h2>
            <Card title="Theme">
              <div className="theme-picker">
                {settings.bgImage && (
                  <button
                    className={`theme-swatch ${settings.theme === "auto" ? "on" : ""}`}
                    onClick={matchWallpaper}
                  >
                    <span
                      className="theme-chips"
                      style={{
                        background:
                          settings.autoThemeVars?.["--bg"] ?? "#26262e",
                      }}
                    >
                      <i
                        style={{
                          background: `rgb(${settings.autoThemeVars?.["--blue"] ?? "150, 150, 170"})`,
                        }}
                      />
                      <i
                        style={{
                          background:
                            settings.autoThemeVars?.["--border"] ?? "#4a4a55",
                        }}
                      />
                      <i
                        style={{
                          background:
                            settings.autoThemeVars?.["--text"] ?? "#d8d8e2",
                        }}
                      />
                    </span>
                    Match wallpaper
                  </button>
                )}
                {Object.entries(THEMES).map(([id, t]) => (
                  <button
                    key={id}
                    className={`theme-swatch ${(settings.theme ?? "midnight") === id ? "on" : ""}`}
                    onClick={() => set({ theme: id })}
                  >
                    <span
                      className="theme-chips"
                      style={{ background: t.vars["--bg"] }}
                    >
                      <i style={{ background: `rgb(${t.vars["--green"]})` }} />
                      <i style={{ background: `rgb(${t.vars["--amber"]})` }} />
                      <i style={{ background: t.vars["--text"] }} />
                    </span>
                    {t.name}
                  </button>
                ))}
              </div>
            </Card>
            <Card title="Background">
              <Row
                title="Background image"
                sub={
                  settings.bgImage
                    ? settings.bgImage.split(/[\\/]/).pop()
                    : "Use a custom image behind the workspace"
                }
              >
                <div className="bg-image-actions">
                  <button className="btn-sm" onClick={pickBgImage}>
                    {settings.bgImage ? "Change…" : "Choose…"}
                  </button>
                  {settings.bgImage && (
                    <button
                      className="btn-sm"
                      onClick={() => set({ bgImage: "" })}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </Row>
              {settings.bgImage && (
                <>
                  <Row
                    title="Overlay opacity"
                    sub={`${Math.round((settings.bgOverlay ?? 0.85) * 100)}% — how solid panels and terminals are over the image`}
                  >
                    <Slider
                      value={settings.bgOverlay ?? 0.85}
                      onChange={(v) => set({ bgOverlay: v })}
                    />
                  </Row>
                  <Row
                    title="Header opacity"
                    sub={`${Math.round((settings.bgHeadOpacity ?? 1) * 100)}% — terminal headers, independent of the overlay`}
                  >
                    <Slider
                      value={settings.bgHeadOpacity ?? 1}
                      onChange={(v) => set({ bgHeadOpacity: v })}
                    />
                  </Row>
                  <Row
                    title="Frosted glass"
                    sub="Blur the image behind panels and terminals"
                  >
                    <Toggle
                      on={settings.bgFrosted !== false}
                      onClick={() =>
                        set({ bgFrosted: !(settings.bgFrosted !== false) })
                      }
                    />
                  </Row>
                  {settings.bgFrosted !== false && (
                    <Row
                      title="Frost strength"
                      sub={`${settings.bgFrostBlur ?? 24}px blur`}
                    >
                      <Slider
                        value={settings.bgFrostBlur ?? 24}
                        min={2}
                        max={60}
                        step={2}
                        onChange={(v) => set({ bgFrostBlur: v })}
                      />
                    </Row>
                  )}
                </>
              )}
            </Card>
          </section>
        )}

        {section === "workspace" && (
          <section className="settings-section">
            <h2>Workspace</h2>
            <Card title="Layout">
              <Row title="Agents per row" sub="Grid columns in the workspace">
                <Segmented
                  value={settings.cols}
                  options={[1, 2, 3, 4].map((n) => [n, String(n)])}
                  onChange={(n) => set({ cols: n })}
                />
              </Row>
            </Card>
            <Card title="Terminal">
              <Row
                title="Engine"
                sub="xterm.js is battle-tested; the wterm engines are experimental"
                stack
              >
                <Segmented
                  value={settings.engine}
                  options={[
                    ["xterm", "xterm"],
                    ["wterm", "wterm·zig"],
                    ["wterm-ghostty", "wterm·ghostty"],
                  ]}
                  onChange={(v) => set({ engine: v })}
                />
              </Row>
              <Row
                title="Shell"
                sub="Shell agents and Terminal panes run through. Empty = auto ($SHELL on macOS/Linux, pwsh then powershell on Windows)"
              >
                <input
                  className="harness-input cmd"
                  value={settings.shell ?? ""}
                  placeholder="auto"
                  spellCheck={false}
                  onChange={(ev) => set({ shell: ev.target.value })}
                />
              </Row>
              <Row
                title="Copy on select"
                sub="Highlighting text in a terminal copies it to the clipboard (xterm engine)"
              >
                <Toggle
                  on={settings.copyOnSelect !== false}
                  onClick={() =>
                    set({ copyOnSelect: !(settings.copyOnSelect !== false) })
                  }
                />
              </Row>
            </Card>
          </section>
        )}

        {section === "agents" && (
          <section className="settings-section">
            <h2>Agents</h2>
            <Card title="Default agent">
              <Row
                title="New Agent spawns"
                sub="Used by the New Agent button, splits and restored panes. Status glow, resume and plan panes are Claude-only for now — other agents run as plain terminals."
                stack
              >
                <Segmented
                  value={settings.defaultHarness ?? "claude"}
                  options={getHarnesses(settings).map((h) => [h.id, h.name])}
                  onChange={(v) => set({ defaultHarness: v })}
                />
              </Row>
            </Card>
            <Card title="Installed">
              {getHarnesses(settings).map((h) => {
                const bin = harnessBin(h);
                const probeable = PROBEABLE.test(bin);
                const ok = !probeable || avail?.has(bin);
                return (
                  <Row
                    key={h.id}
                    title={h.name}
                    sub={installErr[h.id] ?? (probeable ? bin : h.command)}
                  >
                    {avail == null || ok ? (
                      <span className="harness-status ok">
                        {avail == null ? "…" : "installed"}
                      </span>
                    ) : h.install ? (
                      <button
                        className="btn-sm"
                        disabled={!!installing[h.id]}
                        onClick={() => installHarness(h)}
                      >
                        {installing[h.id] ? "Installing…" : "Install"}
                      </button>
                    ) : (
                      <span className="harness-status">not found</span>
                    )}
                  </Row>
                );
              })}
            </Card>
            <Card title="Custom agents">
              {(settings.customHarnesses ?? []).map((h) => (
                <div className="harness-row" key={h.id}>
                  <input
                    className="harness-input name"
                    value={h.name}
                    placeholder="Name"
                    spellCheck={false}
                    onChange={(ev) =>
                      set({
                        customHarnesses: settings.customHarnesses.map((x) =>
                          x.id === h.id ? { ...x, name: ev.target.value } : x,
                        ),
                      })
                    }
                  />
                  <input
                    className="harness-input cmd"
                    value={h.command}
                    placeholder="my-agent --flags"
                    spellCheck={false}
                    onChange={(ev) =>
                      set({
                        customHarnesses: settings.customHarnesses.map((x) =>
                          x.id === h.id ? { ...x, command: ev.target.value } : x,
                        ),
                      })
                    }
                  />
                  <button
                    className="btn-sm"
                    onClick={() => {
                      const patch = {
                        customHarnesses: settings.customHarnesses.filter(
                          (x) => x.id !== h.id,
                        ),
                      };
                      if (settings.defaultHarness === h.id)
                        patch.defaultHarness = "claude";
                      set(patch);
                    }}
                  >
                    Remove
                  </button>
                </div>
              ))}
              <Row
                title="Add custom agent"
                sub="Any CLI on your PATH — launched in a login shell inside the project folder"
              >
                <button
                  className="btn-sm"
                  onClick={() =>
                    set({
                      customHarnesses: [
                        ...(settings.customHarnesses ?? []),
                        {
                          id: `custom-${crypto.randomUUID().slice(0, 8)}`,
                          name: "",
                          command: "",
                        },
                      ],
                    })
                  }
                >
                  Add
                </button>
              </Row>
            </Card>
          </section>
        )}

        {section === "notifications" && (
          <section className="settings-section">
            <h2>Notifications</h2>
            <Card title="Alerts">
              <Row title="Sound" sub="Ping when an agent finishes or needs input">
                <Toggle
                  on={settings.sound}
                  onClick={() => set({ sound: !settings.sound })}
                />
              </Row>
              {settings.sound && (
                <Row
                  title="Volume"
                  sub={`${Math.round((settings.volume ?? 0.8) * 100)}%`}
                >
                  <Slider
                    value={settings.volume ?? 0.8}
                    onChange={(v) => set({ volume: v })}
                    onCommit={previewSound}
                  />
                </Row>
              )}
              <Row
                title="System notifications"
                sub="Notify when the window is in the background"
              >
                <Toggle
                  on={settings.osNotify}
                  onClick={() => set({ osNotify: !settings.osNotify })}
                />
              </Row>
            </Card>
            <Card title="Agents">
              <Row
                title="Plan skill sync"
                sub="Keep the visual-plan skill in ~/.claude/skills up to date on launch so agents can publish plan panes"
              >
                <Toggle
                  on={settings.planSkillSync !== false}
                  onClick={() =>
                    set({ planSkillSync: !(settings.planSkillSync !== false) })
                  }
                />
              </Row>
            </Card>
          </section>
        )}

        {section === "keyboard" && (
          <section className="settings-section">
            <h2>Keyboard</h2>
            <Card title="Modifiers">
              <Row
                title="Word-jump modifier"
                sub="Modifier+←/→ jumps by word, modifier+⌫ deletes a word (⌥-style sequences). Pick the modifier as macOS sees it after any remaps."
                stack
              >
                <Segmented
                  value={settings.wordMod ?? "ctrl"}
                  options={[
                    ["off", "Off"],
                    ["ctrl", "⌃ Ctrl"],
                    ["meta", "⌘ Cmd"],
                  ]}
                  onChange={(v) => set({ wordMod: v })}
                />
              </Row>
              <Row
                title="Pane navigation"
                sub="Hold this + arrows to move focus across the grid. On a Windows keyboard: ⌘ is the Win key, ⌥ is Alt, ⌃ is Ctrl."
                stack
              >
                <Segmented
                  value={settings.navMod ?? "off"}
                  options={NAV_MODS}
                  onChange={(v) => set({ navMod: v })}
                />
              </Row>
            </Card>
            <Card title="Hotkeys">
              <Row
                title="Command menu"
                sub="Click, then press a modifier+key combo to rebind"
              >
                <HotkeyRecorder
                  value={settings.commandMenuKey ?? "mod+shift+p"}
                  onChange={(combo) => set({ commandMenuKey: combo })}
                />
              </Row>
              <div className="settings-shortcuts">
                {[
                  ["⌘1–9", "Focus agent 1–9 in the current project"],
                  ["⌘⇧1–9", "Switch to project 1–9"],
                  ["⌘`", "Cycle to next agent"],
                  ["⌘⇧`", "Cycle to previous agent"],
                  ...(settings.navMod && settings.navMod !== "off"
                    ? [
                        [
                          `${NAV_MOD_SYMBOL[settings.navMod]} + arrows`,
                          "Move focus across the grid",
                        ],
                      ]
                    : []),
                  ["⌘H/J/K/L", "Move focus, vim-style"],
                ].map(([key, desc]) => (
                  <div className="settings-shortcut" key={key}>
                    <span className="settings-row-sub">{desc}</span>
                    <kbd>{key}</kbd>
                  </div>
                ))}
              </div>
            </Card>
          </section>
        )}
        </main>
      </div>
    </div>
  );
}
