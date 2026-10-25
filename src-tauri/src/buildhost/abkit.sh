#!/usr/bin/env bash
# AgentBench build-host kit. `agentbench-build` uploads this to
# ~/.agentbench/builds/bin/abkit.sh and drives it over SSH; nothing here is
# meant to be run by hand, though every subcommand works if you do.
#
# Everything it touches lives under ~/.agentbench/builds:
#
#   bin/         this script, shot.mjs, mise, tart
#   kit/         node_modules for the Playwright capture script
#   toolchains/  mise installs, rustup/cargo, Playwright browsers, Android SDK,
#                Tart VMs, the private simulator device set
#   cache/       npm, gradle, mise download caches — shared by all projects
#   projects/<slug>/{src,shots,run}
#
# Nothing needs root except the system packages a kit asks for, and those are
# only installed when `sudo -n` works; otherwise the exact command is reported
# back so a person can run it once.
#
# Every GUI it starts is invisible to whoever is sitting at the machine: web
# pages render in headless browsers, Linux apps on a private Xvfb display, iOS
# in a simulator whose window is never opened, Android in an emulator started
# with -no-window, and macOS apps inside a Tart VM with no graphics window.
#
# Must stay bash 3.2 compatible: macOS build hosts run /bin/bash 3.2, so no
# associative arrays, no mapfile, no globstar, no ${x,,}.

set -uo pipefail

B="$HOME/.agentbench/builds"
OS="$(uname -s)"
ARCH="$(uname -m)"

# Pinned releases. Bump deliberately: each is downloaded onto someone's
# machine, and the mise binary is checked against its published SHA256.
MISE_VERSION="v2026.10.1"
PLAYWRIGHT_VERSION="1.63.0"
TART_VERSION="2.40.1"
ANDROID_TOOLS="15641748"
ANDROID_API="35"
KIT_NODE="node@22"
KIT_JAVA="java@temurin-17"
AVD="agentbench"
TART_VM="agentbench"
TART_IMAGE="ghcr.io/cirruslabs/macos-sequoia-base:latest"

# Keep every toolchain and cache inside the builds folder rather than the
# user's own ~/.cargo, ~/.npm and friends.
export MISE_DATA_DIR="$B/toolchains/mise"
export MISE_CACHE_DIR="$B/cache/mise"
export MISE_STATE_DIR="$B/toolchains/mise-state"
export MISE_GLOBAL_CONFIG_FILE="$B/mise.toml"
export MISE_CARGO_HOME="$B/toolchains/cargo"
export MISE_RUSTUP_HOME="$B/toolchains/rustup"
export MISE_YES=1
export MISE_TRUSTED_CONFIG_PATHS="$B/projects"
export npm_config_cache="$B/cache/npm"
export GRADLE_USER_HOME="$B/cache/gradle"
export PIP_CACHE_DIR="$B/cache/pip"
export PLAYWRIGHT_BROWSERS_PATH="$B/toolchains/ms-playwright"
export ANDROID_HOME="$B/toolchains/android"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export ANDROID_USER_HOME="$ANDROID_HOME/user"
export ANDROID_AVD_HOME="$ANDROID_HOME/avd"
export TART_HOME="$B/toolchains/tart-home"
export PATH="$B/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

SIMSET="$B/toolchains/simdevices"

# ------------------------------------------------------------------ helpers

have() { command -v "$1" >/dev/null 2>&1; }
log() { printf '%s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

# JSON string body: escape backslash, quote and control characters.
jstr() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/	/\\t/g' | awk 'BEGIN{ORS=""} NR>1{print "\\n"} {print}'
}

sudo_ok() { have sudo && sudo -n true 2>/dev/null; }

sha256_of() {
  if have sha256sum; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}

ms_sleep() { sleep "$(awk "BEGIN{print $1/1000}")"; }

# Locks are directories: mkdir is atomic everywhere, flock is not on macOS. A
# lock whose owner died is broken rather than waited on forever.
LOCKS=""
acquire() {
  local dir="$1" waited=0
  mkdir -p "$(dirname "$dir")"
  until mkdir "$dir" 2>/dev/null; do
    local owner
    owner="$(cat "$dir/pid" 2>/dev/null || true)"
    if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
      rm -rf "$dir"
      continue
    fi
    [ "$waited" = 0 ] && log "waiting for $(basename "$dir") (held by pid ${owner:-?})"
    waited=$((waited + 1))
    sleep 1
  done
  echo $$ >"$dir/pid"
  LOCKS="$LOCKS $dir"
}
CLEANUP=""
on_exit() {
  eval "$CLEANUP"
  local d
  for d in $LOCKS; do rm -rf "$d"; done
}
trap on_exit EXIT
trap 'exit 130' INT TERM HUP

# Kill a process and everything it started. setsid is Linux-only, so walk the
# tree instead of relying on a process group.
killtree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do killtree "$child"; done
  kill "$pid" 2>/dev/null || true
}

# The system package manager, and the install command for it.
pkg_cmd() {
  if have apt-get; then echo "apt-get install -y"
  elif have dnf; then echo "dnf install -y"
  elif have pacman; then echo "pacman -S --noconfirm --needed"
  elif have zypper; then echo "zypper install -y"
  else echo ""; fi
}

# Install system packages when we may; otherwise print what a person must run.
# Returns 0 when installed, 2 when root is needed and not available.
pkg_install() {
  [ $# -eq 0 ] && return 0
  local pm
  pm="$(pkg_cmd)"
  [ -n "$pm" ] || { NEEDS="no supported package manager; install: $*"; return 2; }
  if sudo_ok; then
    if have apt-get; then sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update -qq >&2 || true; fi
    # shellcheck disable=SC2086
    sudo -n env DEBIAN_FRONTEND=noninteractive $pm "$@" >&2 && return 0
    NEEDS="sudo $pm $* (failed when tried)"
    return 2
  fi
  NEEDS="sudo $pm $*"
  return 2
}

mise_bin() { echo "$B/bin/mise"; }

install_mise() {
  local want="$MISE_VERSION" have_ver=""
  [ -x "$B/bin/mise" ] && have_ver="$(cat "$B/bin/.mise-version" 2>/dev/null || true)"
  [ "$have_ver" = "$want" ] && return 0
  have curl || die "curl is required on the build host"
  local os arch asset tmp
  case "$OS" in Linux) os=linux ;; Darwin) os=macos ;; *) die "no mise build for $OS" ;; esac
  case "$ARCH" in x86_64 | amd64) arch=x64 ;; aarch64 | arm64) arch=arm64 ;; *) die "no mise build for $ARCH" ;; esac
  asset="mise-$want-$os-$arch"
  tmp="$(mktemp -d)"
  log "installing mise $want"
  curl -fsSL --retry 3 -o "$tmp/$asset" "https://github.com/jdx/mise/releases/download/$want/$asset" || die "mise download failed"
  curl -fsSL --retry 3 -o "$tmp/SHASUMS256.txt" "https://github.com/jdx/mise/releases/download/$want/SHASUMS256.txt" || die "mise checksum download failed"
  local expect got
  expect="$(grep -E "[ *./]$asset\$" "$tmp/SHASUMS256.txt" | head -1 | awk '{print $1}')"
  got="$(sha256_of "$tmp/$asset")"
  [ -n "$expect" ] && [ "$expect" = "$got" ] || { rm -rf "$tmp"; die "mise checksum mismatch (expected ${expect:-none}, got $got)"; }
  mv "$tmp/$asset" "$B/bin/mise"
  chmod +x "$B/bin/mise"
  printf '%s' "$want" >"$B/bin/.mise-version"
  rm -rf "$tmp"
}

# Run a command with the requested toolchains on PATH. `mise exec` installs a
# missing tool@version first, and also honours the project's own mise.toml or
# .tool-versions when run inside its folder.
with_tools() {
  local tools="$1"
  shift
  # Nothing asked for and no project tool file: use what the host has, and
  # do not download mise just to run a plain command.
  if [ -z "$tools" ] && [ ! -x "$B/bin/mise" ] &&
    [ ! -e mise.toml ] && [ ! -e .mise.toml ] && [ ! -e .tool-versions ]; then
    "$@"
    return
  fi
  install_mise
  # shellcheck disable=SC2086
  "$B/bin/mise" exec $tools -- "$@"
}

project_dir() {
  case "$1" in "" | *[!A-Za-z0-9._-]* | .*) die "bad project slug: $1" ;; esac
  echo "$B/projects/$1"
}

# ------------------------------------------------------------------ probe

kit_state() {
  case "$1" in
    web)
      [ -d "$B/kit/node_modules/playwright" ] && [ -n "$(ls -A "$PLAYWRIGHT_BROWSERS_PATH" 2>/dev/null)" ] && echo ready || echo missing
      ;;
    linux)
      [ "$OS" = Linux ] || { echo unsupported; return; }
      have Xvfb && have xdotool && have import && echo ready || echo missing
      ;;
    android)
      [ -x "$ANDROID_HOME/emulator/emulator" ] && [ -d "$ANDROID_AVD_HOME/$AVD.avd" ] && echo ready || echo missing
      ;;
    ios)
      [ "$OS" = Darwin ] || { echo unsupported; return; }
      xcrun simctl list runtimes 2>/dev/null | grep -q '^iOS' && echo ready || echo missing
      ;;
    mac)
      [ "$OS" = Darwin ] && [ "$ARCH" = arm64 ] || { echo unsupported; return; }
      [ -x "$B/bin/tart" ] && "$B/bin/tart" list 2>/dev/null | awk '{print $2}' | grep -qx "$TART_VM" && echo ready || echo missing
      ;;
  esac
}

cmd_probe() {
  local sudo=false cores mem kits="" k
  sudo_ok && sudo=true
  cores="$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 0)"
  if [ "$OS" = Darwin ]; then
    mem="$(($(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1048576))"
  else
    mem="$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)"
  fi
  for k in web linux android ios mac; do
    kits="$kits\"$k\":\"$(kit_state "$k")\","
  done
  printf '{"ok":true,"os":"%s","arch":"%s","sudo":%s,"cores":%s,"memMb":%s,"mise":%s,"kits":{%s}}\n' \
    "$OS" "$ARCH" "$sudo" "${cores:-0}" "${mem:-0}" \
    "$([ -x "$B/bin/mise" ] && echo true || echo false)" "${kits%,}"
}

# ------------------------------------------------------------------ provision

KIT_RESULTS=""
report() {
  # kit, status (ok|needs|unsupported|failed), detail
  printf '{"kit":"%s","status":"%s","detail":"%s"}\n' "$1" "$2" "$(jstr "$3")"
  KIT_RESULTS="$KIT_RESULTS\"$1\":{\"status\":\"$2\",\"detail\":\"$(jstr "$3")\"},"
}

kit_web() {
  with_tools "$KIT_NODE" npm install --prefix "$B/kit" --no-audit --no-fund --loglevel=error \
    "playwright@$PLAYWRIGHT_VERSION" >&2 || { report web failed "npm install playwright failed"; return; }
  local browsers="chromium"
  [ "$OS" = Darwin ] && browsers="chromium webkit"
  # shellcheck disable=SC2086
  with_tools "$KIT_NODE" "$B/kit/node_modules/.bin/playwright" install $browsers >&2 ||
    { report web failed "playwright browser download failed"; return; }
  # A headless Chromium still links GTK, NSS and friends on Linux. Launch it
  # once: if it starts, the libraries are there whoever installed them.
  if with_tools "$KIT_NODE" node "$B/bin/shot.mjs" --selftest >/dev/null 2>&1; then
    report web ok "Playwright $PLAYWRIGHT_VERSION ($browsers)"
    return
  fi
  if [ "$OS" = Linux ]; then
    if sudo_ok; then
      sudo -n env "PATH=$PATH" "PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH" \
        "$B/toolchains/mise/installs/node/$(ls "$B/toolchains/mise/installs/node" | tail -1)/bin/node" \
        "$B/kit/node_modules/playwright/cli.js" install-deps chromium >&2 &&
        with_tools "$KIT_NODE" node "$B/bin/shot.mjs" --selftest >/dev/null 2>&1 &&
        { report web ok "Playwright $PLAYWRIGHT_VERSION (browser libraries installed)"; return; }
    fi
    report web needs "Chromium is missing system libraries. Run once on the host: sudo $HOME/.agentbench/builds/bin/mise exec $KIT_NODE -- npx --prefix $HOME/.agentbench/builds/kit playwright install-deps chromium"
    return
  fi
  report web failed "headless Chromium does not start; see: node $B/bin/shot.mjs --selftest"
}

kit_linux() {
  [ "$OS" = Linux ] || { report linux unsupported "Linux desktop capture needs a Linux host"; return; }
  if have Xvfb && have xdotool && have import; then
    report linux ok "Xvfb, xdotool, ImageMagick"
    return
  fi
  local pkgs
  if have apt-get; then pkgs="xvfb xdotool imagemagick dbus-x11 x11-utils"
  elif have dnf; then pkgs="xorg-x11-server-Xvfb xdotool ImageMagick dbus-x11 xorg-x11-utils"
  elif have pacman; then pkgs="xorg-server-xvfb xdotool imagemagick xorg-xwininfo"
  else pkgs="Xvfb xdotool ImageMagick"; fi
  NEEDS=""
  # shellcheck disable=SC2086
  if pkg_install $pkgs; then report linux ok "installed $pkgs"; else report linux needs "$NEEDS"; fi
}

kit_android() {
  have unzip || { report android needs "unzip is required: $(pkg_cmd) unzip"; return; }
  with_tools "$KIT_JAVA" java -version >/dev/null 2>&1 || { report android failed "could not install $KIT_JAVA"; return; }
  local os abi
  case "$OS" in Linux) os=linux ;; Darwin) os=mac ;; *) report android unsupported "$OS"; return ;; esac
  case "$ARCH" in x86_64 | amd64) abi=x86_64 ;; aarch64 | arm64) abi=arm64-v8a ;; *) report android unsupported "$ARCH"; return ;; esac
  if [ ! -x "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" ]; then
    local tmp
    tmp="$(mktemp -d)"
    log "downloading Android command-line tools $ANDROID_TOOLS"
    curl -fsSL --retry 3 -o "$tmp/t.zip" \
      "https://dl.google.com/android/repository/commandlinetools-$os-${ANDROID_TOOLS}_latest.zip" ||
      { rm -rf "$tmp"; report android failed "command-line tools download failed"; return; }
    mkdir -p "$ANDROID_HOME/cmdline-tools"
    unzip -q "$tmp/t.zip" -d "$tmp" && rm -rf "$ANDROID_HOME/cmdline-tools/latest" &&
      mv "$tmp/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
    rm -rf "$tmp"
  fi
  local image="system-images;android-$ANDROID_API;google_apis;$abi"
  yes 2>/dev/null | with_tools "$KIT_JAVA" sdkmanager --licenses >/dev/null 2>&1
  with_tools "$KIT_JAVA" sdkmanager "platform-tools" "emulator" "build-tools;$ANDROID_API.0.0" \
    "platforms;android-$ANDROID_API" "$image" >&2 || { report android failed "sdkmanager failed"; return; }
  if [ ! -d "$ANDROID_AVD_HOME/$AVD.avd" ]; then
    mkdir -p "$ANDROID_AVD_HOME"
    echo no | with_tools "$KIT_JAVA" avdmanager create avd -n "$AVD" -k "$image" -d pixel_7 --force >&2 ||
      { report android failed "avdmanager could not create the emulator"; return; }
  fi
  if [ "$OS" = Linux ] && [ ! -w /dev/kvm ]; then
    report android needs "emulator installed, but /dev/kvm is not usable by $(id -un); without it the emulator is too slow to use. Run: sudo usermod -aG kvm $(id -un) (then reconnect)"
    return
  fi
  report android ok "API $ANDROID_API emulator ($abi)"
}

kit_ios() {
  [ "$OS" = Darwin ] || { report ios unsupported "the iOS simulator needs a macOS host"; return; }
  xcode-select -p >/dev/null 2>&1 && xcrun simctl help >/dev/null 2>&1 ||
    { report ios needs "install Xcode from the App Store, open it once, then run: sudo xcode-select -s /Applications/Xcode.app"; return; }
  if ! xcrun simctl list runtimes 2>/dev/null | grep -q '^iOS'; then
    log "downloading the iOS simulator runtime"
    xcodebuild -downloadPlatform iOS >&2 || { report ios needs "no iOS runtime; run: xcodebuild -downloadPlatform iOS"; return; }
  fi
  report ios ok "$(xcrun simctl list runtimes | grep '^iOS' | tail -1 | sed 's/ (.*//')"
}

kit_mac() {
  [ "$OS" = Darwin ] && [ "$ARCH" = arm64 ] ||
    { report mac unsupported "macOS app capture runs in a Tart VM, which needs an Apple Silicon Mac"; return; }
  if [ ! -x "$B/bin/tart" ]; then
    local tmp expect got
    tmp="$(mktemp -d)"
    log "installing tart $TART_VERSION"
    curl -fsSL --retry 3 -o "$tmp/tart.tar.gz" "https://github.com/cirruslabs/tart/releases/download/$TART_VERSION/tart.tar.gz" &&
      curl -fsSL --retry 3 -o "$tmp/sums" "https://github.com/cirruslabs/tart/releases/download/$TART_VERSION/tart_${TART_VERSION}_checksums.txt" ||
      { rm -rf "$tmp"; report mac failed "tart download failed"; return; }
    expect="$(grep -E ' tart\.tar\.gz$' "$tmp/sums" | awk '{print $1}')"
    got="$(sha256_of "$tmp/tart.tar.gz")"
    [ -n "$expect" ] && [ "$expect" = "$got" ] || { rm -rf "$tmp"; report mac failed "tart checksum mismatch"; return; }
    mkdir -p "$B/toolchains/tart"
    tar -xzf "$tmp/tart.tar.gz" -C "$B/toolchains/tart"
    ln -sf "$B/toolchains/tart/tart.app/Contents/MacOS/tart" "$B/bin/tart"
    rm -rf "$tmp"
  fi
  if ! "$B/bin/tart" list 2>/dev/null | awk '{print $2}' | grep -qx "$TART_VM"; then
    log "cloning $TART_IMAGE (a large download, once)"
    "$B/bin/tart" clone "$TART_IMAGE" "$TART_VM" >&2 || { report mac failed "tart clone failed"; return; }
  fi
  report mac ok "VM $TART_VM from $TART_IMAGE"
}

cmd_provision() {
  local tools="" pkgs="" kits=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --tools) tools="$2"; shift 2 ;;
      --pkgs) pkgs="$2"; shift 2 ;;
      --kits) kits="$2"; shift 2 ;;
      *) die "provision: unknown option $1" ;;
    esac
  done
  mkdir -p "$B/bin" "$B/kit" "$B/toolchains" "$B/cache" "$B/projects"
  install_mise
  report mise ok "mise $MISE_VERSION"
  if [ -n "$tools" ]; then
    # shellcheck disable=SC2086
    if "$B/bin/mise" install $tools >&2; then report tools ok "$tools"; else report tools failed "mise install $tools"; fi
  fi
  if [ -n "$pkgs" ]; then
    NEEDS=""
    # shellcheck disable=SC2086
    if pkg_install $pkgs; then report packages ok "$pkgs"; else report packages needs "$NEEDS"; fi
  fi
  local k
  for k in $(echo "$kits" | tr ',' ' '); do
    case "$k" in
      web) kit_web ;; linux) kit_linux ;; android) kit_android ;; ios) kit_ios ;; mac) kit_mac ;;
      *) report "$k" failed "unknown kit" ;;
    esac
  done
  printf '{"ok":true,"done":true,"kits":{%s}}\n' "${KIT_RESULTS%,}"
}

# ------------------------------------------------------------------ sync

cmd_manifest() {
  local p
  p="$(project_dir "$1")" || exit 1
  cat "$p/manifest.json" 2>/dev/null || echo '{}'
}

# stdin: a tar of changed files, extracted over src/.
cmd_unpack() {
  local p
  p="$(project_dir "$1")" || exit 1
  mkdir -p "$p/src"
  tar -xf - -C "$p/src"
}

# stdin: NUL-separated relative paths to delete from src/, then the manifest
# arrives in a second call. Paths that try to leave src/ are refused.
cmd_prune() {
  local p f
  p="$(project_dir "$1")" || exit 1
  while IFS= read -r -d '' f; do
    case "/$f/" in */../* | //*) log "refusing to delete $f"; continue ;; esac
    rm -f -- "$p/src/$f"
  done
}

cmd_put_manifest() {
  local p
  p="$(project_dir "$1")" || exit 1
  mkdir -p "$p"
  cat >"$p/manifest.json.tmp" && mv "$p/manifest.json.tmp" "$p/manifest.json"
}

# stdout: a tar of everything under src/ matching the given patterns. find's
# -path lets `*` cross slashes, which is what `**` means in the config.
cmd_pack() {
  local p pat list
  p="$(project_dir "$1")" || exit 1
  shift
  cd "$p/src" || die "nothing synced for this project yet"
  list="$(mktemp)"
  for pat in "$@"; do
    pat="${pat#./}"
    pat="$(printf '%s' "$pat" | sed 's/\*\*/*/g')"
    find . -path "./$pat" -prune -print >>"$list"
  done
  if [ ! -s "$list" ]; then
    rm -f "$list"
    log "no files matched: $*"
    tar -cf - -T /dev/null
    return
  fi
  tar -cf - -T "$list"
  rm -f "$list"
}

# ------------------------------------------------------------------ run

read_env_args() {
  # --env K=V pairs into the environment
  while [ $# -gt 0 ]; do
    case "$1" in --env) export "$2"; shift 2 ;; *) shift ;; esac
  done
}

cmd_run() {
  local slug="" tools="" cmd=""
  local envs=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --slug) slug="$2"; shift 2 ;;
      --tools) tools="$2"; shift 2 ;;
      --env) envs+=(--env "$2"); shift 2 ;;
      --) shift; cmd="$*"; break ;;
      *) die "run: unknown option $1" ;;
    esac
  done
  [ -n "$cmd" ] || die "run: no command"
  local p
  p="$(project_dir "$slug")" || exit 1
  [ -d "$p/src" ] || die "nothing synced for this project yet"
  [ ${#envs[@]} -gt 0 ] && read_env_args "${envs[@]}"
  # One build per project at a time: two agents building into the same
  # target/ would corrupt each other's output.
  acquire "$p/run/build.lock"
  cd "$p/src" || exit 1
  with_tools "$tools" bash -c "$cmd"
}

# ------------------------------------------------------------------ shots

# Common shot options. Parsed into globals so each capture mode can use what it
# needs and ignore the rest.
parse_shot_args() {
  SLUG="" TOOLS="" OUT="" URL="" SERVE="" APP="" SIZE="1440x900" FULL=0 WAIT="" DELAY=""
  BROWSER="chromium" DEVICE="" PKG="" APPEARANCE="" STEPS=() ENVS=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --slug) SLUG="$2"; shift 2 ;;
      --tools) TOOLS="$2"; shift 2 ;;
      --out) OUT="$2"; shift 2 ;;
      --url) URL="$2"; shift 2 ;;
      --serve) SERVE="$2"; shift 2 ;;
      --app) APP="$2"; shift 2 ;;
      --size) SIZE="$2"; shift 2 ;;
      --full) FULL=1; shift ;;
      --wait) WAIT="$2"; shift 2 ;;
      --delay) DELAY="$2"; shift 2 ;;
      --browser) BROWSER="$2"; shift 2 ;;
      --device) DEVICE="$2"; shift 2 ;;
      --package) PKG="$2"; shift 2 ;;
      --appearance) APPEARANCE="$2"; shift 2 ;;
      --do) STEPS+=("$2"); shift 2 ;;
      --env) ENVS+=(--env "$2"); shift 2 ;;
      *) die "shot: unknown option $1" ;;
    esac
  done
  case "$OUT" in "" | */* | .*) die "shot: bad --out name" ;; esac
  P="$(project_dir "$SLUG")" || exit 1
  [ -d "$P/src" ] || die "nothing synced for this project yet"
  mkdir -p "$P/shots"
  SHOT="$P/shots/$OUT"
  W="${SIZE%x*}"
  H="${SIZE#*x}"
  [ ${#ENVS[@]} -gt 0 ] && read_env_args "${ENVS[@]}"
  cd "$P/src" || exit 1
}

shot_done() {
  # path on the host, then anything worth telling the agent (console errors,
  # the app's log tail) as a JSON string.
  [ -s "$SHOT" ] || die "no screenshot was produced"
  printf '{"ok":true,"path":"%s","notes":"%s"}\n' "$(jstr "$SHOT")" "$(jstr "${1:-}")"
}

# Start --serve in the background and wait until the URL answers.
start_server() {
  [ -n "$SERVE" ] || return 0
  [ -n "$URL" ] || die "--serve needs --url to know when it is up"
  mkdir -p "$P/run"
  with_tools "$TOOLS" bash -c "$SERVE" >"$P/run/serve.log" 2>&1 &
  SERVER_PID=$!
  CLEANUP="$CLEANUP killtree $SERVER_PID;"
  local i
  for i in $(seq 1 180); do
    curl -fs -o /dev/null --max-time 2 "$URL" 2>/dev/null && return 0
    curl -s -o /dev/null --max-time 2 -w '%{http_code}' "$URL" 2>/dev/null | grep -q '^[1-5]' && return 0
    kill -0 "$SERVER_PID" 2>/dev/null || { tail -n 30 "$P/run/serve.log" >&2; die "--serve exited before $URL answered"; }
    sleep 1
  done
  tail -n 30 "$P/run/serve.log" >&2
  die "$URL did not answer within 180s"
}

cmd_shot_web() {
  parse_shot_args "$@"
  [ -n "$URL" ] || die "shot --web needs a URL"
  start_server
  local args=(--url "$URL" --out "$SHOT" --width "$W" --height "$H" --browser "$BROWSER")
  [ "$FULL" = 1 ] && args+=(--full)
  [ -n "$WAIT" ] && args+=(--wait "$WAIT")
  [ -n "$DELAY" ] && args+=(--delay "$DELAY")
  [ -n "$APPEARANCE" ] && args+=(--appearance "$APPEARANCE")
  [ -n "$DEVICE" ] && args+=(--device "$DEVICE")
  local s
  for s in ${STEPS[@]+"${STEPS[@]}"}; do args+=(--do "$s"); done
  local notes
  notes="$(with_tools "$KIT_NODE" node "$B/bin/shot.mjs" "${args[@]}")" || die "capture failed: $notes"
  shot_done "$notes"
}

# A private X display per capture. -displayfd has Xvfb pick a free display
# number and write it back, so concurrent captures never collide.
start_xvfb() {
  local fifo
  fifo="$(mktemp)"
  Xvfb -displayfd 9 -screen 0 "${W}x${H}x24" -nolisten tcp -noreset 9>"$fifo" 2>/dev/null &
  XVFB_PID=$!
  CLEANUP="$CLEANUP kill $XVFB_PID 2>/dev/null;"
  local i n=""
  for i in $(seq 1 50); do
    n="$(tr -dc '0-9' <"$fifo")"
    [ -n "$n" ] && break
    sleep 0.1
  done
  rm -f "$fifo"
  [ -n "$n" ] || die "Xvfb did not start"
  export DISPLAY=":$n"
}

xdo_step() {
  local step="$1" verb arg
  verb="${step%%:*}"
  arg="${step#*:}"
  case "$verb" in
    click) xdotool mousemove "${arg%,*}" "${arg#*,}" click 1 ;;
    dblclick) xdotool mousemove "${arg%,*}" "${arg#*,}" click --repeat 2 1 ;;
    type) xdotool type --delay 15 -- "$arg" ;;
    key | press) xdotool key -- "$arg" ;;
    sleep) ms_sleep "$arg" ;;
    window) timeout 60 xdotool search --sync --onlyvisible --name "$arg" windowactivate --sync >/dev/null 2>&1 ||
      log "window '$arg' did not appear" ;;
    *) log "unknown step for a desktop app: $step" ;;
  esac
}

cmd_shot_linux() {
  parse_shot_args "$@"
  [ "$OS" = Linux ] || die "--app capture with Xvfb needs a Linux host"
  have Xvfb && have xdotool && have import || die "the linux kit is not installed (agentbench-build provision --kits linux)"
  [ -n "$APP" ] || die "shot --app needs a command"
  start_xvfb
  # Software rendering: there is no GPU behind Xvfb, and WebKitGTK (Tauri) and
  # Chromium (Electron) both draw blank windows if they try to use one.
  export LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
  export NO_AT_BRIDGE=1 ELECTRON_DISABLE_GPU=1 GDK_BACKEND=x11 QT_QPA_PLATFORM=xcb
  mkdir -p "$P/run"
  local launcher=(bash -c "$APP")
  have dbus-run-session && launcher=(dbus-run-session -- bash -c "$APP")
  with_tools "$TOOLS" "${launcher[@]}" >"$P/run/app.log" 2>&1 &
  local app_pid=$!
  CLEANUP="$CLEANUP killtree $app_pid;"
  if [ -n "$WAIT" ]; then
    timeout 90 xdotool search --sync --onlyvisible --name "$WAIT" >/dev/null 2>&1 ||
      { kill -0 $app_pid 2>/dev/null || { tail -n 40 "$P/run/app.log" >&2; die "the app exited"; }; log "no window named '$WAIT' after 90s; capturing anyway"; }
  fi
  ms_sleep "${DELAY:-4000}"
  kill -0 $app_pid 2>/dev/null || { tail -n 40 "$P/run/app.log" >&2; die "the app exited before the capture"; }
  local s
  for s in ${STEPS[@]+"${STEPS[@]}"}; do xdo_step "$s"; done
  [ ${#STEPS[@]} -gt 0 ] && ms_sleep 600
  import -window root "$SHOT" 2>/dev/null || die "ImageMagick could not grab the display"
  shot_done "$(tail -n 15 "$P/run/app.log" 2>/dev/null)"
}

sim() { xcrun simctl --set "$SIMSET" "$@"; }

# A brand-new device reports booted while it is still on first-boot setup,
# and launch/openurl time out until that finishes. Retry instead of failing.
sim_retry() {
  local i
  for i in 1 2 3 4; do
    sim "$@" >/dev/null 2>&1 && return 0
    log "simulator not ready yet (attempt $i), retrying"
    sleep 15
  done
  sim "$@" >/dev/null
}

# Find or create a simulator in AgentBench's private device set, so captures
# never boot, reset or clutter the person's own simulators.
sim_udid() {
  local name="$1" udid runtime dtype
  mkdir -p "$SIMSET"
  udid="$(sim list devices available | grep -F "    $name (" | head -1 | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')"
  if [ -z "$udid" ]; then
    runtime="$(xcrun simctl list runtimes available | grep '^iOS' | tail -1 | sed -E 's/.* - (com\.apple\.[^ ]+).*/\1/')"
    [ -n "$runtime" ] || die "no iOS simulator runtime installed (agentbench-build provision --kits ios)"
    dtype="$(xcrun simctl list devicetypes | grep -F "$name (" | head -1 | sed -E 's/.*\((com\.apple\.[^)]+)\).*/\1/')"
    [ -n "$dtype" ] || die "unknown simulator device '$name' (xcrun simctl list devicetypes)"
    udid="$(sim create "$name" "$dtype" "$runtime")" || die "could not create simulator"
  fi
  echo "$udid"
}

cmd_shot_ios() {
  parse_shot_args "$@"
  [ "$OS" = Darwin ] || die "iOS capture needs a macOS host"
  [ -n "$APP" ] || [ -n "$URL" ] || die "shot --ios needs an .app path or --url"
  local name="${DEVICE:-iPhone 16}" udid
  acquire "$B/toolchains/locks/sim-$(printf '%s' "$name" | tr -c 'A-Za-z0-9' '_')"
  udid="$(sim_udid "$name")"
  # bootstatus -b boots if needed and waits. Simulator.app is never opened, so
  # no window appears on the host's screen.
  sim bootstatus "$udid" -b >/dev/null || die "simulator did not boot"
  [ -n "$APPEARANCE" ] && sim ui "$udid" appearance "$APPEARANCE" >/dev/null 2>&1
  if [ -n "$APP" ]; then
    [ -d "$APP" ] || die "no .app at $APP (build for the simulator first)"
    local bundle
    bundle="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist" 2>/dev/null)" ||
      die "$APP has no CFBundleIdentifier"
    sim install "$udid" "$APP" || die "install failed"
    sim terminate "$udid" "$bundle" >/dev/null 2>&1
    sim_retry launch "$udid" "$bundle" || die "launch failed"
  fi
  [ -n "$URL" ] && { sim_retry openurl "$udid" "$URL" || die "could not open $URL"; }
  ms_sleep "${DELAY:-3000}"
  sim io "$udid" screenshot "$SHOT" >/dev/null 2>&1 || die "simctl screenshot failed"
  shot_done "simulator: $name"
}

adb_ready() { adb -e get-state 2>/dev/null | grep -q device; }

cmd_shot_android() {
  parse_shot_args "$@"
  [ -x "$ANDROID_HOME/emulator/emulator" ] || die "the android kit is not installed (agentbench-build provision --kits android)"
  [ -n "$APP" ] || [ -n "$PKG" ] || [ -n "$URL" ] || die "shot --android needs an .apk, --package or --url"
  acquire "$B/toolchains/locks/emulator"
  if ! adb_ready; then
    # Left running between captures: a cold boot is a minute, a warm one is
    # instant. `agentbench-build stop` shuts it down.
    nohup emulator -avd "$AVD" -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect \
      >"$B/toolchains/android/emulator.log" 2>&1 </dev/null &
    adb wait-for-device
    local i
    for i in $(seq 1 240); do
      [ "$(adb -e shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] && break
      sleep 1
    done
  fi
  adb -e shell settings put system screen_off_timeout 1800000 >/dev/null 2>&1
  adb -e shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1
  [ -n "$APPEARANCE" ] && adb -e shell cmd uimode night "$([ "$APPEARANCE" = dark ] && echo yes || echo no)" >/dev/null 2>&1
  if [ -n "$APP" ]; then
    [ -f "$APP" ] || die "no apk at $APP"
    adb -e install -r "$APP" >&2 || die "adb install failed"
    if [ -z "$PKG" ]; then
      local aapt
      aapt="$(ls -d "$ANDROID_HOME"/build-tools/*/aapt2 2>/dev/null | tail -1)"
      [ -n "$aapt" ] && PKG="$("$aapt" dump packagename "$APP" 2>/dev/null)"
      [ -n "$PKG" ] || die "could not read the package name; pass --package"
    fi
  fi
  if [ -n "$PKG" ]; then
    adb -e shell am force-stop "$PKG" >/dev/null 2>&1
    adb -e shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || die "could not launch $PKG"
  elif [ -n "$URL" ]; then
    # Inside the emulator, localhost is the emulator; the host is 10.0.2.2.
    local durl="${URL/localhost/10.0.2.2}"
    durl="${durl/127.0.0.1/10.0.2.2}"
    adb -e shell am start -a android.intent.action.VIEW -d "$durl" >/dev/null || die "could not open $durl"
  fi
  ms_sleep "${DELAY:-4000}"
  local s
  for s in ${STEPS[@]+"${STEPS[@]}"}; do
    case "${s%%:*}" in
      tap | click) adb -e shell input tap $(echo "${s#*:}" | tr ',' ' ') ;;
      type) adb -e shell input text "$(printf '%s' "${s#*:}" | sed 's/ /%s/g')" ;;
      key | press) adb -e shell input keyevent "${s#*:}" ;;
      sleep) ms_sleep "${s#*:}" ;;
      *) log "unknown step for android: $s" ;;
    esac
  done
  [ ${#STEPS[@]} -gt 0 ] && ms_sleep 600
  adb -e exec-out screencap -p >"$SHOT" || die "screencap failed"
  shot_done "emulator: $AVD"
}

tart_running() { "$B/bin/tart" list 2>/dev/null | awk -v vm="$TART_VM" '$2==vm{print $NF}' | grep -qi running; }

cmd_shot_mac() {
  parse_shot_args "$@"
  [ -x "$B/bin/tart" ] || die "the mac kit is not installed (agentbench-build provision --kits mac)"
  [ -n "$APP" ] || die "shot --mac needs an .app path"
  [ -d "$APP" ] || die "no .app at $APP"
  acquire "$B/toolchains/locks/tart"
  if ! tart_running; then
    # --no-graphics: the VM has a display of its own but no window on the host.
    # The projects folder is shared in so the guest can open the built app and
    # write the capture straight back.
    nohup "$B/bin/tart" run --no-graphics --dir="ab:$B/projects" "$TART_VM" \
      >"$B/toolchains/tart.log" 2>&1 </dev/null &
    local i
    for i in $(seq 1 180); do
      "$B/bin/tart" exec "$TART_VM" true >/dev/null 2>&1 && break
      sleep 1
    done
  fi
  "$B/bin/tart" exec "$TART_VM" true >/dev/null 2>&1 || die "the VM did not come up (see $B/toolchains/tart.log)"
  local share="/Volumes/My Shared Files/ab/$SLUG"
  local guest_app="$share/src/$APP" guest_out="$share/shots/$OUT"
  "$B/bin/tart" exec "$TART_VM" open -n "$guest_app" || die "could not open the app in the VM"
  ms_sleep "${DELAY:-5000}"
  "$B/bin/tart" exec "$TART_VM" screencapture -x "$guest_out" || die "screencapture failed in the VM"
  "$B/bin/tart" exec "$TART_VM" pkill -f "$guest_app" >/dev/null 2>&1
  shot_done "vm: $TART_VM"
}

# Shut down everything kept warm between captures.
cmd_stop() {
  if [ "$OS" = Darwin ] && [ -d "$SIMSET" ]; then sim shutdown all >/dev/null 2>&1; fi
  have adb && adb -e emu kill >/dev/null 2>&1
  [ -x "$B/bin/tart" ] && tart_running && "$B/bin/tart" stop "$TART_VM" >/dev/null 2>&1
  printf '{"ok":true}\n'
}

# Delete a project's synced tree (keeps the shared toolchains and caches).
cmd_clean() {
  local p
  p="$(project_dir "$1")" || exit 1
  rm -rf "$p"
  printf '{"ok":true}\n'
}

# ------------------------------------------------------------------ main

sub="${1:-}"
[ $# -gt 0 ] && shift
mkdir -p "$B/bin" "$B/projects" "$B/toolchains/locks"
case "$sub" in
  probe) cmd_probe ;;
  provision) cmd_provision "$@" ;;
  manifest) cmd_manifest "$@" ;;
  unpack) cmd_unpack "$@" ;;
  prune) cmd_prune "$@" ;;
  put-manifest) cmd_put_manifest "$@" ;;
  pack) cmd_pack "$@" ;;
  run) cmd_run "$@" ;;
  shot-web) cmd_shot_web "$@" ;;
  shot-app) cmd_shot_linux "$@" ;;
  shot-ios) cmd_shot_ios "$@" ;;
  shot-android) cmd_shot_android "$@" ;;
  shot-mac) cmd_shot_mac "$@" ;;
  stop) cmd_stop ;;
  clean) cmd_clean "$@" ;;
  *) die "usage: abkit.sh probe|provision|run|shot-web|shot-app|shot-ios|shot-android|shot-mac|stop|clean" ;;
esac
