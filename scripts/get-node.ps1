# Downloads a portable Node.js (latest v24 LTS) into runtime\node, for start.bat.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $root 'runtime'
New-Item -ItemType Directory -Force $runtime | Out-Null
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win-arm64' } else { 'win-x64' }
$sums = (Invoke-WebRequest -UseBasicParsing 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt').Content -split "`n"
$line = $sums | Where-Object { $_ -match "$arch\.zip$" } | Select-Object -First 1
$parts = $line -split '\s+'
$hash = $parts[0]; $file = $parts[-1]
$zip = Join-Path $runtime 'node.zip'
Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/latest-v24.x/$file" -OutFile $zip
if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $hash.ToLower()) { throw 'Node.js download checksum mismatch' }
Expand-Archive $zip $runtime -Force
Remove-Item $zip
$dir = Join-Path $runtime ($file -replace '\.zip$', '')
if (Test-Path (Join-Path $runtime 'node')) { Remove-Item -Recurse -Force (Join-Path $runtime 'node') }
Rename-Item $dir 'node'
