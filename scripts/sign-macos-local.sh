#!/bin/bash
# Re-sign an installed AgentBench.app with a stable signing identity.
#
# Why: CI releases are ad-hoc (linker-signed), and macOS TCC keys ad-hoc
# grants to the exact binary hash — every update invalidates any Screen
# Recording / Microphone grant, and System Settings drops the entry. Signing
# with a real certificate gives TCC a stable designated requirement
# (identifier + cert), so grants survive updates. Run this again after each
# app update; the existing grant then keeps matching — no Settings dance.
#
# Usage: scripts/sign-macos-local.sh [identity] [app-path]
set -euo pipefail

IDENTITY="${1:-Apple Development: Connor Moody (KD2WA363T3)}"
APP="${2:-/Applications/AgentBench.app}"

[ -d "$APP" ] || { echo "no app at $APP" >&2; exit 1; }

# helpers first (nested code must be signed before the bundle)
for bin in agentbench-broker agentbench-gateway; do
  p="$APP/Contents/MacOS/$bin"
  [ -f "$p" ] || continue
  codesign --force --sign "$IDENTITY" \
    --identifier "com.connor.agentbench.${bin#agentbench-}" "$p"
  echo "signed $bin"
done

# the bundle itself; keep the mic entitlement the bundler applied
codesign --force --sign "$IDENTITY" \
  --identifier com.connor.agentbench \
  --preserve-metadata=entitlements "$APP"
echo "signed $(basename "$APP")"

codesign --verify --deep --strict "$APP" && echo "verify: OK"
echo
echo "Restart the broker + gateway so the new identity is what asks for"
echo "permissions (Settings → Workspace → Restart broker; gateway from its"
echo "toggle), then grant Screen Recording when macOS prompts."
