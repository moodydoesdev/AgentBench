# Ship the working tree to the installed AgentBench that phones talk to.
#
# The gateway serves the PWA from the INSTALLED app's dist/ (next to its exe),
# not the repo's — so `npm run build` alone never reaches a phone. This builds
# the frontend and the gateway, mirrors dist into the install dir, swaps the
# gateway exe (backing up the old one), and restarts it. The phone then shows
# its "updated on your computer" banner on its own.
#
#   npm run deploy:local            # frontend + gateway
#   npm run deploy:local -- -SkipRust   # frontend only (no cargo build/swap)
#   npm run deploy:local -- -Broker     # ALSO swap the broker — KILLS every
#                                       # running agent on this machine
#
# The desktop app exe is deliberately not touched: it embeds its own frontend
# and replacing it under a running webview helps nobody. Build a real bundle
# when the desktop needs updating.
param(
  [switch]$SkipRust,
  [switch]$Broker
)
$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
$install = Join-Path $env:LOCALAPPDATA "AgentBench"
$config = Join-Path $env:APPDATA "com.connor.agentbench"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

if (-not (Test-Path (Join-Path $install "agentbench-gateway.exe"))) {
  throw "No installed AgentBench at $install - install the app first."
}

Write-Host "== frontend build" -ForegroundColor Cyan
Push-Location $repo
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "vite build failed" }
} finally { Pop-Location }

$bins = @()
if (-not $SkipRust) { $bins += "agentbench-gateway" }
if ($Broker) { $bins += "agentbench-broker" }
if ($bins.Count) {
  Write-Host "== cargo build --release ($($bins -join ', '))" -ForegroundColor Cyan
  Push-Location (Join-Path $repo "src-tauri")
  try {
    cargo build --release @($bins | ForEach-Object { "--bin"; $_ })
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }
  } finally { Pop-Location }
}

Write-Host "== sync dist -> $install\dist" -ForegroundColor Cyan
robocopy (Join-Path $repo "dist") (Join-Path $install "dist") /MIR /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }
$global:LASTEXITCODE = 0

function File-Sha256($path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    [BitConverter]::ToString($sha.ComputeHash([System.IO.File]::ReadAllBytes($path)))
  } finally {
    $sha.Dispose()
  }
}

function Swap-Binary($name, $stopScript) {
  $built = Join-Path $repo "src-tauri\target\release\$name.exe"
  $target = Join-Path $install "$name.exe"
  if ((File-Sha256 $built) -eq (File-Sha256 $target)) {
    Write-Host "== $name unchanged, no swap" -ForegroundColor DarkGray
    return
  }
  Write-Host "== swap $name" -ForegroundColor Cyan
  & $stopScript
  # the old process holds the file until it is really gone
  for ($i = 0; $i -lt 20; $i++) {
    if (-not (Get-Process $name -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 250
  }
  Get-Process $name -ErrorAction SilentlyContinue | Stop-Process -Force -Confirm:$false
  Start-Sleep -Milliseconds 300
  Copy-Item $target "$target.bak-$stamp"
  Copy-Item $built $target -Force
}

if (-not $SkipRust) {
  Swap-Binary "agentbench-gateway" {
    $adv = Get-Content (Join-Path $config "gateway.json") -ErrorAction SilentlyContinue | ConvertFrom-Json
    if ($adv.controlPort) {
      try {
        Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($adv.controlPort)/local/quit" -ContentType "application/json" -Body "{}" -TimeoutSec 5 | Out-Null
      } catch {}
    }
  }
  if (-not (Get-Process "agentbench-gateway" -ErrorAction SilentlyContinue)) {
    Write-Host "== start gateway" -ForegroundColor Cyan
    Start-Process -FilePath (Join-Path $install "agentbench-gateway.exe") -WorkingDirectory $install
  }
  $ok = $false
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $h = Invoke-RestMethod -Uri "http://127.0.0.1:8473/api/health" -TimeoutSec 2
      if ($h.ok) { $ok = $true; break }
    } catch {}
  }
  if (-not $ok) { throw "gateway did not come back - check $install\agentbench-gateway.exe by hand" }
  Write-Host "== gateway healthy (protocol v$($h.protocolVersion), $($h.machine))" -ForegroundColor Green
}

if ($Broker) {
  Write-Host "!! swapping the broker ends every running agent on this machine" -ForegroundColor Yellow
  Swap-Binary "agentbench-broker" {
    # no graceful remote stop worth using here: killing it is the point
  }
  Write-Host "== broker swapped; it restarts on demand when the app or gateway next connects" -ForegroundColor Green
}

Write-Host "done - phones will offer 'reload to latest' on their own." -ForegroundColor Green
