# GIRAFE node kit launcher for Windows. Started by "Start GIRAFE kit.cmd".
# Uses Node 22+ if this computer has it; otherwise downloads a private copy of Node
# into this folder (.runtime), checks it against nodejs.org's published checksum, and
# uses that. Nothing is installed on the computer; delete the folder to remove everything.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Host.UI.RawUI.WindowTitle = 'GIRAFE node kit'
$Kit = Split-Path -Parent $PSScriptRoot
$Version = '22.22.0'
$Mirror = if ($env:GIRAFE_NODE_MIRROR) { $env:GIRAFE_NODE_MIRROR } else { 'https://nodejs.org/dist' }
$Arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$Name = "node-v$Version-win-$Arch"
$Runtime = Join-Path $Kit '.runtime'
$Local = Join-Path $Runtime "$Name\node.exe"

function Say($t) { Write-Host "  $t" }

try {
  $node = $null
  $sys = Get-Command node -ErrorAction SilentlyContinue
  if ($sys) {
    $v = (& $sys.Source -v) -replace '^v', ''
    if ([int]($v.Split('.')[0]) -ge 22) { $node = $sys.Source }
  }
  if (-not $node -and (Test-Path $Local)) { $node = $Local }
  if (-not $node) {
    Write-Host ''
    Say 'First start: getting Node.js (about 30 MB, once). Please wait...'
    New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
    $zip = Join-Path $Runtime "$Name.zip"
    Invoke-WebRequest -UseBasicParsing -Uri "$Mirror/v$Version/$Name.zip" -OutFile $zip
    $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$Mirror/v$Version/SHASUMS256.txt").Content
    if ($sums -is [byte[]]) { $sums = [Text.Encoding]::ASCII.GetString($sums) }
    $line = ($sums -split "`n") | Where-Object { $_ -match "\s$Name\.zip\s*$" } | Select-Object -First 1
    if (-not $line) { throw "No checksum published for $Name.zip" }
    $want = ($line -split '\s+')[0].ToLower()
    $got = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
    if ($want -ne $got) { Remove-Item $zip -Force; throw 'The download does not match nodejs.org''s checksum; it was deleted. Try again later.' }
    Say 'Checksum OK. Unpacking...'
    Expand-Archive -Force -Path $zip -DestinationPath $Runtime
    Remove-Item $zip -Force
    $node = $Local
  }
  # One home for the kit (kit/install.js): unzipped in Downloads or on the Desktop, it copies
  # itself to %USERPROFILE%\GIRAFE kit, puts a shortcut on the desktop, and runs from the copy -
  # so there is one place to start it from, on every computer. A git clone is left where it is.
  # Your work is never in the kit's folder (it lives in "GIRAFE kit workspace"), so nothing of
  # yours moves. Its notes go to the console; the folder to run from is the one line of output.
  try {
    # Everything it prints is shown; its last line is the folder to run from.
    $out = @(& $node (Join-Path $Kit 'kit\install.js') '--prepare' 2>&1 | ForEach-Object { "$_" })
    if ($out.Count -gt 1) { $out[0..($out.Count - 2)] | ForEach-Object { Write-Host $_ } }
    $home_kit = if ($out.Count) { $out[-1].Trim() } else { '' }
    if ($home_kit -and (Test-Path (Join-Path $home_kit 'kit.js'))) { $Kit = $home_kit }
  } catch { Say "Could not move the kit to its home folder: $($_.Exception.Message)" }
  Write-Host ''
  Say 'Starting... your browser will open. Keep this window open while you use the kit;'
  Say 'close it to stop.'
  & $node (Join-Path $Kit 'kit.js') @args
} catch {
  Write-Host ''
  Write-Host "  Could not start: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host ''
  Read-Host '  Press Enter to close'
}
