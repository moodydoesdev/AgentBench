# AgentBench build-host kit for Windows. The PowerShell twin of abkit.sh:
# `agentbench-build` uploads it to %USERPROFILE%\.agentbench\builds\bin and
# drives it over Windows OpenSSH. Every call arrives as -EncodedCommand, so
# neither cmd.exe nor PowerShell as the SSH default shell can mangle the
# arguments.
#
# Everything it touches lives under %USERPROFILE%\.agentbench\builds:
#
#   bin\         this script, shot.mjs, mise.exe
#   kit\         node_modules for the Playwright capture script
#   toolchains\  mise installs, rustup/cargo, Playwright browsers, Android SDK
#   cache\       npm, gradle, mise caches, shared by all projects
#   projects\<slug>\{src,shots,run}
#
# Captures never appear on the machine's screen. Web pages render in a
# headless browser. Desktop apps are started on a private, never-shown
# desktop and drawn with PrintWindow. The Android emulator runs with
# -no-window.
#
# Windows PowerShell 5.1 compatible: no ternaries, no ??, no &&. Keep this
# file ASCII: it is written as-is on the host.

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$B = Join-Path $env:USERPROFILE '.agentbench\builds'

# Pinned releases, kept in step with abkit.sh.
$MiseVersion = 'v2026.10.1'
$PlaywrightVersion = '1.63.0'
$AndroidTools = '15641748'
$AndroidApi = '35'
$KitNode = 'node@22'
$KitJava = 'java@temurin-17'
$Avd = 'agentbench'

$env:MISE_DATA_DIR = "$B\toolchains\mise"
$env:MISE_CACHE_DIR = "$B\cache\mise"
$env:MISE_STATE_DIR = "$B\toolchains\mise-state"
$env:MISE_GLOBAL_CONFIG_FILE = "$B\mise.toml"
$env:MISE_CARGO_HOME = "$B\toolchains\cargo"
$env:MISE_RUSTUP_HOME = "$B\toolchains\rustup"
$env:MISE_YES = '1'
$env:MISE_TRUSTED_CONFIG_PATHS = "$B\projects"
$env:npm_config_cache = "$B\cache\npm"
$env:GRADLE_USER_HOME = "$B\cache\gradle"
$env:PLAYWRIGHT_BROWSERS_PATH = "$B\toolchains\ms-playwright"
$env:ANDROID_HOME = "$B\toolchains\android"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:ANDROID_USER_HOME = "$env:ANDROID_HOME\user"
$env:ANDROID_AVD_HOME = "$env:ANDROID_HOME\avd"
$env:PATH = "$B\bin;$env:ANDROID_HOME\cmdline-tools\latest\bin;$env:ANDROID_HOME\platform-tools;$env:ANDROID_HOME\emulator;$env:PATH"

# ------------------------------------------------------------------ helpers

function Log([string]$m) { [Console]::Error.WriteLine($m) }
function Fail([string]$m) { Log "error: $m"; exit 1 }
function Out-Json($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 6)) }
# Native chatter to stderr, so stdout carries only our JSON.
function To-Err { process { [Console]::Error.WriteLine("$_") } }
function Have([string]$c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }
function IsAdmin {
  $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Project-Dir([string]$slug) {
  if ($slug -notmatch '^[A-Za-z0-9_][A-Za-z0-9._-]*$') { Fail "bad project slug: $slug" }
  Join-Path $B "projects\$slug"
}

function Read-StdinBase64 {
  $text = [Console]::In.ReadToEnd().Trim()
  if (-not $text) { return [byte[]]@() }
  [Convert]::FromBase64String($text)
}

# Locks are directories, as in abkit.sh. A lock whose owner died is broken.
$script:Locks = @()
function Acquire([string]$dir) {
  New-Item -ItemType Directory -Force -Path (Split-Path $dir) | Out-Null
  $waited = $false
  while ($true) {
    try {
      New-Item -ItemType Directory -Path $dir -ErrorAction Stop | Out-Null
      break
    } catch {
      $owner = Get-Content "$dir\pid" -ErrorAction SilentlyContinue
      if ($owner -and -not (Get-Process -Id $owner -ErrorAction SilentlyContinue)) {
        Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
        continue
      }
      if (-not $waited) { Log "waiting for $(Split-Path -Leaf $dir) (held by pid $owner)"; $waited = $true }
      Start-Sleep -Seconds 1
    }
  }
  Set-Content -Path "$dir\pid" -Value $PID
  $script:Locks += $dir
}
function Release-All { foreach ($d in $script:Locks) { Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue } }

function Kill-Tree([int]$id) { & taskkill.exe /T /F /PID $id 2>&1 | Out-Null }

function Download([string]$url, [string]$out) {
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $out
}

function Install-Mise {
  $want = $MiseVersion
  $have = Get-Content "$B\bin\.mise-version" -ErrorAction SilentlyContinue
  if ((Test-Path "$B\bin\mise.exe") -and $have -eq $want) { return }
  $arch = 'x64'
  if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $arch = 'arm64' }
  $asset = "mise-$want-windows-$arch.exe"
  $tmp = Join-Path $env:TEMP ("ab-mise-" + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  Log "installing mise $want"
  try {
    Download "https://github.com/jdx/mise/releases/download/$want/$asset" "$tmp\$asset"
    Download "https://github.com/jdx/mise/releases/download/$want/SHASUMS256.txt" "$tmp\sums"
  } catch { Remove-Item -Recurse -Force $tmp; Fail "mise download failed: $_" }
  $line = Select-String -Path "$tmp\sums" -Pattern ([regex]::Escape($asset) + '$') | Select-Object -First 1
  $expect = ''
  if ($line) { $expect = ($line.Line -split '\s+')[0].ToLower() }
  $got = (Get-FileHash -Algorithm SHA256 "$tmp\$asset").Hash.ToLower()
  if (-not $expect -or $expect -ne $got) { Remove-Item -Recurse -Force $tmp; Fail "mise checksum mismatch (expected $expect, got $got)" }
  Move-Item -Force "$tmp\$asset" "$B\bin\mise.exe"
  Set-Content -Path "$B\bin\.mise-version" -Value $want -NoNewline
  Remove-Item -Recurse -Force $tmp
}

# Put the requested toolchains on this process's PATH. Applying `mise env`
# rather than wrapping each command in `mise exec` keeps every command line
# out of a second round of Windows argument quoting. Run it from the project
# folder so a mise.toml or .tool-versions there counts too.
function Use-Tools([string]$tools) {
  $t = @($tools -split '\s+' | Where-Object { $_ })
  $plain = $t.Count -eq 0 -and -not (Test-Path "$B\bin\mise.exe") -and
    -not (Test-Path 'mise.toml') -and -not (Test-Path '.mise.toml') -and -not (Test-Path '.tool-versions')
  if ($plain) { return }
  Install-Mise
  if ($t.Count -gt 0) { & "$B\bin\mise.exe" install @t 2>&1 | To-Err }
  $json = & "$B\bin\mise.exe" env --json @t 2>$null | Out-String
  if (-not $json.Trim()) { return }
  foreach ($v in ($json | ConvertFrom-Json).PSObject.Properties) {
    [Environment]::SetEnvironmentVariable($v.Name, [string]$v.Value, 'Process')
  }
}

# A cmd.exe batch file holding `line`. User commands are cmd syntax
# (`npm run build && dir`) and go through a file so no layer of argument
# quoting can change them.
function Write-Job([string]$dir, [string]$name, [string]$line) {
  $f = Join-Path $dir "$name-$PID.cmd"
  [IO.File]::WriteAllText($f, "@echo off`r`n$line`r`nexit /b %errorlevel%`r`n", [Text.Encoding]::ASCII)
  $f
}

# ------------------------------------------------------------------ probe

function Kit-State([string]$kit) {
  switch ($kit) {
    'web' {
      if ((Test-Path "$B\kit\node_modules\playwright") -and (Get-ChildItem $env:PLAYWRIGHT_BROWSERS_PATH -ErrorAction SilentlyContinue)) { 'ready' } else { 'missing' }
    }
    'windows' { 'ready' }
    'android' {
      if ((Test-Path "$env:ANDROID_HOME\emulator\emulator.exe") -and (Test-Path "$env:ANDROID_AVD_HOME\$Avd.avd")) { 'ready' } else { 'missing' }
    }
    default { 'unsupported' }
  }
}

function Cmd-Probe {
  $cs = Get-CimInstance Win32_ComputerSystem
  $kits = [ordered]@{}
  foreach ($k in 'web', 'linux', 'android', 'ios', 'mac', 'windows') { $kits[$k] = Kit-State $k }
  Out-Json ([ordered]@{
    ok = $true; os = 'Windows'; arch = $env:PROCESSOR_ARCHITECTURE
    sudo = (IsAdmin); cores = [int]$cs.NumberOfLogicalProcessors
    memMb = [int]($cs.TotalPhysicalMemory / 1MB); mise = (Test-Path "$B\bin\mise.exe"); kits = $kits
  })
}

# ------------------------------------------------------------------ provision

$script:Results = [ordered]@{}
function Report([string]$kit, [string]$status, [string]$detail) {
  Out-Json ([ordered]@{ kit = $kit; status = $status; detail = $detail })
  $script:Results[$kit] = [ordered]@{ status = $status; detail = $detail }
}

function Kit-Web {
  New-Item -ItemType Directory -Force -Path "$B\kit" | Out-Null
  Use-Tools $KitNode
  & npm.cmd install --prefix "$B\kit" --no-audit --no-fund --loglevel=error "playwright@$PlaywrightVersion" 2>&1 | To-Err
  if ($LASTEXITCODE -ne 0) { Report web failed 'npm install playwright failed'; return }
  & node.exe "$B\kit\node_modules\playwright\cli.js" install chromium 2>&1 | To-Err
  if ($LASTEXITCODE -ne 0) { Report web failed 'playwright browser download failed'; return }
  & node.exe "$B\bin\shot.mjs" --selftest 2>&1 | To-Err
  if ($LASTEXITCODE -ne 0) { Report web failed "headless Chromium does not start; try: node $B\bin\shot.mjs --selftest"; return }
  Report web ok "Playwright $PlaywrightVersion (chromium)"
}

function Kit-Android {
  Use-Tools $KitJava
  & java.exe -version 2>&1 | To-Err
  if ($LASTEXITCODE -ne 0) { Report android failed "could not install $KitJava"; return }
  $sdkm = "$env:ANDROID_HOME\cmdline-tools\latest\bin\sdkmanager.bat"
  if (-not (Test-Path $sdkm)) {
    $tmp = Join-Path $env:TEMP ("ab-android-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $tmp | Out-Null
    Log "downloading Android command-line tools $AndroidTools"
    try { Download "https://dl.google.com/android/repository/commandlinetools-win-${AndroidTools}_latest.zip" "$tmp\t.zip" }
    catch { Remove-Item -Recurse -Force $tmp; Report android failed 'command-line tools download failed'; return }
    Expand-Archive -Path "$tmp\t.zip" -DestinationPath $tmp
    New-Item -ItemType Directory -Force -Path "$env:ANDROID_HOME\cmdline-tools" | Out-Null
    Remove-Item -Recurse -Force "$env:ANDROID_HOME\cmdline-tools\latest" -ErrorAction SilentlyContinue
    Move-Item "$tmp\cmdline-tools" "$env:ANDROID_HOME\cmdline-tools\latest"
    Remove-Item -Recurse -Force $tmp
  }
  $abi = 'x86_64'
  if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $abi = 'arm64-v8a' }
  $image = "system-images;android-$AndroidApi;google_apis;$abi"
  ("y`n" * 20) | & $sdkm --licenses 2>&1 | To-Err
  & $sdkm platform-tools emulator "build-tools;$AndroidApi.0.0" "platforms;android-$AndroidApi" $image 2>&1 | To-Err
  if ($LASTEXITCODE -ne 0) { Report android failed 'sdkmanager failed'; return }
  if (-not (Test-Path "$env:ANDROID_AVD_HOME\$Avd.avd")) {
    New-Item -ItemType Directory -Force -Path $env:ANDROID_AVD_HOME | Out-Null
    'no' | & "$env:ANDROID_HOME\cmdline-tools\latest\bin\avdmanager.bat" create avd -n $Avd -k $image -d pixel_7 --force 2>&1 | To-Err
    if ($LASTEXITCODE -ne 0) { Report android failed 'avdmanager could not create the emulator'; return }
  }
  $accel = & "$env:ANDROID_HOME\emulator\emulator.exe" -accel-check 2>&1 | Out-String
  if ($accel -notmatch 'is installed and usable|WHPX.*usable|AEHD.*usable') {
    Report android needs "emulator installed, but no hypervisor acceleration. Enable 'Windows Hypervisor Platform' in Windows Features (needs a reboot)."
    return
  }
  Report android ok "API $AndroidApi emulator ($abi)"
}

function Install-Packages([string[]]$ids) {
  if (-not (Have winget)) { return "winget is not available; install by hand: $($ids -join ', ')" }
  $failed = @()
  foreach ($id in $ids) {
    & winget install -e --id $id --silent --disable-interactivity --accept-package-agreements --accept-source-agreements 2>&1 | To-Err
    # 0 installed, -1978335189 already installed
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) { $failed += $id }
  }
  if ($failed.Count -eq 0) { return '' }
  "winget could not install: $($failed -join ', '). Installs that need elevation must run from an administrator account; or install them by hand."
}

function Cmd-Provision([string[]]$a) {
  $tools = ''; $pkgs = ''; $kits = ''
  for ($i = 0; $i -lt $a.Length; $i++) {
    switch ($a[$i]) {
      '--tools' { $tools = $a[++$i] }
      '--pkgs' { $pkgs = $a[++$i] }
      '--kits' { $kits = $a[++$i] }
      default { Fail "provision: unknown option $($a[$i])" }
    }
  }
  foreach ($d in 'bin', 'kit', 'toolchains', 'cache', 'projects') { New-Item -ItemType Directory -Force -Path "$B\$d" | Out-Null }
  Install-Mise
  Report mise ok "mise $MiseVersion"
  if ($tools) {
    & "$B\bin\mise.exe" install @($tools -split '\s+' | Where-Object { $_ }) 2>&1 | To-Err
    if ($LASTEXITCODE -eq 0) { Report tools ok $tools } else { Report tools failed "mise install $tools" }
  }
  if ($pkgs) {
    $need = Install-Packages @($pkgs -split '\s+' | Where-Object { $_ })
    if ($need) { Report packages needs $need } else { Report packages ok $pkgs }
  }
  foreach ($k in ($kits -split ',' | Where-Object { $_ })) {
    switch ($k) {
      'web' { Kit-Web }
      'windows' { Report windows ok 'private desktop + PrintWindow (built into Windows)' }
      'android' { Kit-Android }
      'linux' { Report linux unsupported 'Linux desktop capture needs a Linux host' }
      'ios' { Report ios unsupported 'the iOS simulator needs a macOS host' }
      'mac' { Report mac unsupported 'macOS app capture needs an Apple Silicon Mac' }
      default { Report $k failed 'unknown kit' }
    }
  }
  Out-Json ([ordered]@{ ok = $true; done = $true; kits = $script:Results })
}

# ------------------------------------------------------------------ sync
# Binary data never passes through PowerShell's pipeline, which would
# re-encode it. Tar streams go straight to tar.exe (see buildhost/mod.rs);
# small payloads here travel as base64 text.

function Cmd-Manifest([string]$slug) {
  $f = Join-Path (Project-Dir $slug) 'manifest.json'
  $bytes = [Text.Encoding]::UTF8.GetBytes('{}')
  if (Test-Path $f) { $bytes = [IO.File]::ReadAllBytes($f) }
  [Console]::Out.WriteLine([Convert]::ToBase64String($bytes))
}

function Cmd-Prepare([string]$slug) {
  $p = Project-Dir $slug
  foreach ($d in 'src', 'shots', 'run') { New-Item -ItemType Directory -Force -Path "$p\$d" | Out-Null }
  Out-Json @{ ok = $true }
}

function Cmd-PutManifest([string]$slug) {
  $p = Project-Dir $slug
  New-Item -ItemType Directory -Force -Path $p | Out-Null
  [IO.File]::WriteAllBytes("$p\manifest.json", (Read-StdinBase64))
  Out-Json @{ ok = $true }
}

function Cmd-Prune([string]$slug) {
  $src = Join-Path (Project-Dir $slug) 'src'
  $text = [Text.Encoding]::UTF8.GetString((Read-StdinBase64))
  foreach ($rel in ($text -split "`0" | Where-Object { $_ })) {
    if ($rel -match '(^|[\\/])\.\.([\\/]|$)' -or $rel -match '^[\\/]' -or $rel -match ':') { Log "refusing to delete $rel"; continue }
    Remove-Item -LiteralPath (Join-Path $src $rel) -Force -ErrorAction SilentlyContinue
  }
  Out-Json @{ ok = $true }
}

# Write the list of files under src\ matching the patterns, for tar -T. `*`
# crosses folders here, as `find -path` does in abkit.sh.
function Cmd-PackList([string]$slug, [string[]]$patterns) {
  $p = Project-Dir $slug
  $src = Join-Path $p 'src'
  if (-not (Test-Path $src)) { Fail 'nothing synced for this project yet' }
  New-Item -ItemType Directory -Force -Path "$p\run" | Out-Null
  $root = (Resolve-Path $src).Path.TrimEnd('\') + '\'
  $files = Get-ChildItem -LiteralPath $src -Recurse -File -Force -ErrorAction SilentlyContinue |
    ForEach-Object { $_.FullName.Substring($root.Length).Replace('\', '/') }
  $hits = New-Object System.Collections.Generic.List[string]
  foreach ($f in $files) {
    foreach ($pat in $patterns) {
      $pt = $pat.TrimStart('.', '/').Replace('**', '*').TrimEnd('/')
      if ($f -like $pt -or $f -like "$pt/*") { $hits.Add($f); break }
    }
  }
  $list = "$p\run\pack.list"
  [IO.File]::WriteAllText($list, (($hits -join "`n") + "`n"), (New-Object Text.UTF8Encoding($false)))
  Out-Json ([ordered]@{ ok = $true; count = $hits.Count; list = $list.Replace('\', '/'); src = $src.Replace('\', '/') })
}

# ------------------------------------------------------------------ run

function Apply-Env([string[]]$pairs) {
  foreach ($kv in $pairs) {
    $i = $kv.IndexOf('=')
    if ($i -gt 0) { [Environment]::SetEnvironmentVariable($kv.Substring(0, $i), $kv.Substring($i + 1), 'Process') }
  }
}

function Cmd-Run([string[]]$a) {
  $slug = ''; $tools = ''; $envs = @(); $cmd = ''
  for ($i = 0; $i -lt $a.Length; $i++) {
    switch ($a[$i]) {
      '--slug' { $slug = $a[++$i] }
      '--tools' { $tools = $a[++$i] }
      '--env' { $envs += $a[++$i] }
      '--' { $cmd = (@($a | Select-Object -Skip ($i + 1)) -join ' '); $i = $a.Length }
      default { Fail "run: unknown option $($a[$i])" }
    }
  }
  if (-not $cmd) { Fail 'run: no command' }
  $p = Project-Dir $slug
  if (-not (Test-Path "$p\src")) { Fail 'nothing synced for this project yet' }
  Apply-Env $envs
  Acquire "$p\run\build.lock"
  New-Item -ItemType Directory -Force -Path "$p\run" | Out-Null
  Set-Location "$p\src"
  Use-Tools $tools
  $job = Write-Job "$p\run" 'job' $cmd
  & cmd.exe /d /c $job
  $code = $LASTEXITCODE
  Remove-Item -Force $job -ErrorAction SilentlyContinue
  Release-All
  exit $code
}

# ------------------------------------------------------------------ shots

function Parse-Shot([string[]]$a) {
  $o = [ordered]@{ slug = ''; tools = ''; out = ''; url = ''; serve = ''; app = ''; size = '1440x900'; full = $false
    wait = ''; delay = ''; browser = 'chromium'; device = ''; package = ''; appearance = ''; steps = @(); envs = @() }
  for ($i = 0; $i -lt $a.Length; $i++) {
    $f = $a[$i]
    switch ($f) {
      '--full' { $o.full = $true }
      '--do' { $o.steps += $a[++$i] }
      '--env' { $o.envs += $a[++$i] }
      default {
        $key = $f.TrimStart('-')
        if (-not $o.Contains($key)) { Fail "shot: unknown option $f" }
        $o[$key] = $a[++$i]
      }
    }
  }
  if (-not $o.out -or $o.out -match '[\\/]' -or $o.out.StartsWith('.')) { Fail 'shot: bad --out name' }
  $o.dir = Project-Dir $o.slug
  if (-not (Test-Path "$($o.dir)\src")) { Fail 'nothing synced for this project yet' }
  New-Item -ItemType Directory -Force -Path "$($o.dir)\shots", "$($o.dir)\run" | Out-Null
  $o.shot = "$($o.dir)\shots\$($o.out)"
  $wh = $o.size -split 'x'
  $o.w = [int]$wh[0]; $o.h = [int]$wh[1]
  Apply-Env $o.envs
  Set-Location "$($o.dir)\src"
  $o
}

function Shot-Done($o, [string]$notes) {
  if (-not (Test-Path $o.shot) -or (Get-Item $o.shot).Length -eq 0) { Fail 'no screenshot was produced' }
  Out-Json ([ordered]@{ ok = $true; path = $o.shot.Replace('\', '/'); notes = $notes })
}

# Start --serve hidden in the background and wait for the URL to answer.
function Start-Server($o) {
  if (-not $o.serve) { return $null }
  if (-not $o.url) { Fail '--serve needs --url to know when it is up' }
  $log = "$($o.dir)\run\serve.log"
  Use-Tools $o.tools
  $job = Write-Job "$($o.dir)\run" 'serve' "($($o.serve)) > `"$log`" 2>&1"
  $proc = Start-Process -FilePath cmd.exe -ArgumentList '/d', '/c', "`"$job`"" -WindowStyle Hidden -PassThru
  for ($i = 0; $i -lt 180; $i++) {
    try { Invoke-WebRequest -UseBasicParsing -Uri $o.url -TimeoutSec 2 | Out-Null; return $proc }
    catch { if ($_.Exception.Response) { return $proc } }
    if ($proc.HasExited) { Get-Content $log -Tail 30 | To-Err; Fail "--serve exited before $($o.url) answered" }
    Start-Sleep -Seconds 1
  }
  Get-Content $log -Tail 30 | To-Err
  Kill-Tree $proc.Id
  Fail "$($o.url) did not answer within 180s"
}

function Cmd-ShotWeb([string[]]$a) {
  $o = Parse-Shot $a
  if (-not $o.url) { Fail 'shot --web needs a URL' }
  $server = Start-Server $o
  Use-Tools $KitNode
  $args2 = @("$B\bin\shot.mjs", '--url', $o.url, '--out', $o.shot, '--width', $o.w, '--height', $o.h, '--browser', $o.browser)
  if ($o.full) { $args2 += '--full' }
  if ($o.wait) { $args2 += @('--wait', $o.wait) }
  if ($o.delay) { $args2 += @('--delay', $o.delay) }
  if ($o.appearance) { $args2 += @('--appearance', $o.appearance) }
  if ($o.device) { $args2 += @('--device', $o.device) }
  foreach ($s in $o.steps) { $args2 += @('--do', $s) }
  $notes = (& node.exe @args2 2>&1 | Out-String).Trim()
  $code = $LASTEXITCODE
  if ($server) { Kill-Tree $server.Id }
  if ($code -ne 0) { Fail "capture failed: $notes" }
  Shot-Done $o $notes
}

# Desktop apps run on a desktop of their own that is never switched to, so
# nothing appears on the screen of whoever is using the machine. Windows
# still lays the windows out, and PrintWindow asks each one to draw itself
# into a bitmap.
$WinCapture = @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public static class AbWin {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  delegate bool EnumProc(IntPtr h, IntPtr l);

  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateDesktop(string name, IntPtr dev, IntPtr mode, int flags, uint access, IntPtr sa);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit,
    uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("user32.dll")] static extern bool EnumDesktopWindows(IntPtr desk, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool repaint);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);

  public static IntPtr Desktop(string name) {
    // GENERIC_ALL. The desktop is never passed to SwitchDesktop, so it is
    // never what the monitor shows.
    IntPtr d = CreateDesktop(name, IntPtr.Zero, IntPtr.Zero, 0, 0x10000000, IntPtr.Zero);
    if (d == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
    return d;
  }
  public static void Close(IntPtr d) { CloseDesktop(d); }

  public static int Launch(string desktop, string cmdline, string cwd) {
    STARTUPINFO si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(si);
    si.lpDesktop = desktop;
    PROCESS_INFORMATION pi;
    if (!CreateProcess(null, new StringBuilder(cmdline), IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, cwd, ref si, out pi))
      throw new System.ComponentModel.Win32Exception();
    return pi.dwProcessId;
  }

  // Largest visible window on the desktop owned by one of `pids`, optionally
  // with `title` in its caption.
  public static IntPtr Find(IntPtr desk, int[] pids, string title) {
    IntPtr best = IntPtr.Zero; long bestArea = 0;
    var set = new HashSet<int>(pids);
    EnumDesktopWindows(desk, (h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!set.Contains((int)pid) || !IsWindowVisible(h)) return true;
      if (!string.IsNullOrEmpty(title)) {
        var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
        if (sb.ToString().IndexOf(title, StringComparison.OrdinalIgnoreCase) < 0) return true;
      }
      RECT r; GetWindowRect(h, out r);
      long area = (long)(r.R - r.L) * (r.B - r.T);
      if (area > bestArea) { bestArea = area; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }

  public static void Size(IntPtr h, int w, int hh) { MoveWindow(h, 0, 0, w, hh, true); }

  // PW_RENDERFULLCONTENT (2) captures DirectComposition content such as
  // WebView2 and Chromium; plain PrintWindow is the fallback for old GDI apps.
  public static void Save(IntPtr h, string path) {
    RECT r; GetWindowRect(h, out r);
    int w = Math.Max(1, r.R - r.L), hh = Math.Max(1, r.B - r.T);
    using (var bmp = new Bitmap(w, hh, PixelFormat.Format32bppArgb)) {
      using (var g = Graphics.FromImage(bmp)) {
        IntPtr hdc = g.GetHdc();
        if (!PrintWindow(h, hdc, 2)) PrintWindow(h, hdc, 0);
        g.ReleaseHdc(hdc);
      }
      bmp.Save(path, ImageFormat.Png);
    }
  }

  // Input goes to the window as messages, not through the real mouse and
  // keyboard, which belong to the person at the machine.
  public static void Click(IntPtr h, int x, int y) {
    IntPtr lp = (IntPtr)((y << 16) | (x & 0xFFFF));
    PostMessage(h, 0x0201, (IntPtr)1, lp);
    PostMessage(h, 0x0202, IntPtr.Zero, lp);
  }
  public static void Type(IntPtr h, string text) {
    foreach (char c in text) PostMessage(h, 0x0102, (IntPtr)c, IntPtr.Zero);
  }
  public static void Key(IntPtr h, int vk) {
    PostMessage(h, 0x0100, (IntPtr)vk, IntPtr.Zero);
    PostMessage(h, 0x0101, (IntPtr)vk, IntPtr.Zero);
  }
}
'@

function Process-Tree([int]$root) {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
  $ids = New-Object System.Collections.Generic.List[int]
  $ids.Add($root)
  $grew = $true
  while ($grew) {
    $grew = $false
    foreach ($p in $all) {
      if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) { $ids.Add([int]$p.ProcessId); $grew = $true }
    }
  }
  , $ids.ToArray()
}

function Cmd-ShotApp([string[]]$a) {
  $o = Parse-Shot $a
  if (-not $o.app) { Fail 'shot --windows needs a command or .exe' }
  Add-Type -TypeDefinition $WinCapture -ReferencedAssemblies System.Drawing
  $deskName = 'agentbench-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
  $desk = [AbWin]::Desktop($deskName)
  Use-Tools $o.tools
  $cmdline = $o.app
  $rootPid = 0
  try {
    $rootPid = [AbWin]::Launch($deskName, $cmdline, (Get-Location).Path)
    $deadline = (Get-Date).AddSeconds(90)
    $win = [IntPtr]::Zero
    while ((Get-Date) -lt $deadline) {
      $win = [AbWin]::Find($desk, (Process-Tree $rootPid), $o.wait)
      if ($win -ne [IntPtr]::Zero) { break }
      if (-not (Get-Process -Id $rootPid -ErrorAction SilentlyContinue) -and (Process-Tree $rootPid).Length -le 1) { Fail 'the app exited before it showed a window' }
      Start-Sleep -Milliseconds 500
    }
    if ($win -eq [IntPtr]::Zero) { Fail 'no window appeared within 90s' }
    [AbWin]::Size($win, $o.w, $o.h)
    $delay = 4000
    if ($o.delay) { $delay = [int]$o.delay }
    Start-Sleep -Milliseconds $delay
    $keys = @{ enter = 0x0D; tab = 0x09; esc = 0x1B; escape = 0x1B; space = 0x20; backspace = 0x08; up = 0x26; down = 0x28; left = 0x25; right = 0x27 }
    foreach ($s in $o.steps) {
      $verb, $arg = $s -split ':', 2
      switch ($verb) {
        'click' { $xy = $arg -split ','; [AbWin]::Click($win, [int]$xy[0], [int]$xy[1]) }
        'type' { [AbWin]::Type($win, $arg) }
        'key' { if ($keys.ContainsKey($arg.ToLower())) { [AbWin]::Key($win, $keys[$arg.ToLower()]) } else { Log "unknown key $arg" } }
        'sleep' { Start-Sleep -Milliseconds ([int]$arg) }
        default { Log "unknown step for a desktop app: $s" }
      }
    }
    if ($o.steps.Count -gt 0) { Start-Sleep -Milliseconds 600 }
    [AbWin]::Save($win, $o.shot)
  } finally {
    if ($rootPid) { Kill-Tree $rootPid }
    [AbWin]::Close($desk)
  }
  Shot-Done $o "private desktop $deskName"
}

function Cmd-ShotAndroid([string[]]$a) {
  $o = Parse-Shot $a
  $emu = "$env:ANDROID_HOME\emulator\emulator.exe"
  if (-not (Test-Path $emu)) { Fail 'the android kit is not installed (agentbench-build provision --kits android)' }
  if (-not $o.app -and -not $o.package -and -not $o.url) { Fail 'shot --android needs an .apk, --package or --url' }
  Acquire "$B\toolchains\locks\emulator"
  $state = (& adb -e get-state 2>$null | Out-String).Trim()
  if ($state -ne 'device') {
    Start-Process -FilePath $emu -ArgumentList "-avd $Avd -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect" -WindowStyle Hidden
    & adb wait-for-device
    for ($i = 0; $i -lt 240; $i++) {
      if ((& adb -e shell getprop sys.boot_completed 2>$null | Out-String).Trim() -eq '1') { break }
      Start-Sleep -Seconds 1
    }
  }
  & adb -e shell input keyevent KEYCODE_WAKEUP | Out-Null
  if ($o.appearance) {
    $night = 'no'
    if ($o.appearance -eq 'dark') { $night = 'yes' }
    & adb -e shell cmd uimode night $night | Out-Null
  }
  if ($o.app) {
    if (-not (Test-Path $o.app)) { Fail "no apk at $($o.app)" }
    & adb -e install -r $o.app 2>&1 | To-Err
    if ($LASTEXITCODE -ne 0) { Fail 'adb install failed' }
    if (-not $o.package) {
      $aapt = Get-ChildItem "$env:ANDROID_HOME\build-tools\*\aapt2.exe" -ErrorAction SilentlyContinue | Select-Object -Last 1
      if ($aapt) { $o.package = (& $aapt.FullName dump packagename $o.app 2>$null | Out-String).Trim() }
      if (-not $o.package) { Fail 'could not read the package name; pass --package' }
    }
  }
  if ($o.package) {
    & adb -e shell am force-stop $o.package | Out-Null
    & adb -e shell monkey -p $o.package -c android.intent.category.LAUNCHER 1 | Out-Null
  } elseif ($o.url) {
    $durl = $o.url.Replace('localhost', '10.0.2.2').Replace('127.0.0.1', '10.0.2.2')
    & adb -e shell am start -a android.intent.action.VIEW -d $durl | Out-Null
  }
  $delay = 4000
  if ($o.delay) { $delay = [int]$o.delay }
  Start-Sleep -Milliseconds $delay
  foreach ($s in $o.steps) {
    $verb, $arg = $s -split ':', 2
    switch ($verb) {
      { $_ -in 'tap', 'click' } { $xy = $arg -split ','; & adb -e shell input tap $xy[0] $xy[1] | Out-Null }
      'type' { & adb -e shell input text ($arg.Replace(' ', '%s')) | Out-Null }
      { $_ -in 'key', 'press' } { & adb -e shell input keyevent $arg | Out-Null }
      'sleep' { Start-Sleep -Milliseconds ([int]$arg) }
      default { Log "unknown step for android: $s" }
    }
  }
  if ($o.steps.Count -gt 0) { Start-Sleep -Milliseconds 600 }
  # Pull through the device rather than exec-out: PowerShell would re-encode
  # binary stdout.
  & adb -e shell screencap -p /sdcard/agentbench.png | Out-Null
  & adb -e pull /sdcard/agentbench.png $o.shot 2>&1 | To-Err
  Release-All
  Shot-Done $o "emulator: $Avd"
}

function Cmd-Stop {
  if (Have adb) { & adb -e emu kill 2>&1 | Out-Null }
  Out-Json @{ ok = $true }
}

function Cmd-Clean([string]$slug) {
  $p = Project-Dir $slug
  Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue
  Out-Json @{ ok = $true }
}

# ------------------------------------------------------------------ main

foreach ($d in 'bin', 'projects', 'toolchains\locks') { New-Item -ItemType Directory -Force -Path "$B\$d" | Out-Null }
$sub = ''
$rest = @()
if ($args.Count -gt 0) { $sub = $args[0] }
if ($args.Count -gt 1) { $rest = [string[]]@($args | Select-Object -Skip 1) }
try {
  switch ($sub) {
    'probe' { Cmd-Probe }
    'provision' { Cmd-Provision $rest }
    'manifest' { Cmd-Manifest $rest[0] }
    'prepare' { Cmd-Prepare $rest[0] }
    'put-manifest' { Cmd-PutManifest $rest[0] }
    'prune' { Cmd-Prune $rest[0] }
    'pack-list' { Cmd-PackList $rest[0] ([string[]]@($rest | Select-Object -Skip 1)) }
    'run' { Cmd-Run $rest }
    'shot-web' { Cmd-ShotWeb $rest }
    'shot-app' { Cmd-ShotApp $rest }
    'shot-android' { Cmd-ShotAndroid $rest }
    { $_ -in 'shot-ios', 'shot-mac' } { Fail 'this capture needs a macOS host' }
    'stop' { Cmd-Stop }
    'clean' { Cmd-Clean $rest[0] }
    default { Fail 'usage: abkit.ps1 probe|provision|run|shot-web|shot-app|shot-android|stop|clean' }
  }
} finally {
  Release-All
}
exit 0
