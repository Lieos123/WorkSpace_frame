# Fetch an AOCI-CODE Windows release into D:\WorkSpace\Tools\aoci and verify its SHA256.
# To upgrade: change $Tag to the new release tag (e.g. 'v0.1.0-rc21') and re-run.
# Run:  pwsh -NoProfile -ExecutionPolicy Bypass -File D:\WorkSpace\Tools\_setup\aoci-fetch.ps1
$ErrorActionPreference = 'Stop'
$Tag = 'v0.1.0-rc20'
$File = "aoci_$($Tag.TrimStart('v'))_windows_amd64.zip"
$Base = "https://github.com/aoci-spec/aoci-code/releases/download/$Tag"
$VerDir = 'D:\WorkSpace\Tools\aoci\_versions'
New-Item -ItemType Directory -Force -Path $VerDir | Out-Null
$Zip = Join-Path $VerDir $File

Write-Host "Downloading $File ..."
Invoke-WebRequest "$Base/$File" -OutFile $Zip
Invoke-WebRequest "$Base/SHA256SUMS" -OutFile (Join-Path $VerDir 'SHA256SUMS')

$want = ((Get-Content (Join-Path $VerDir 'SHA256SUMS') | Where-Object { $_ -match ([regex]::Escape($File) + '$') }) -split '\s+')[0]
$got = (Get-FileHash $Zip -Algorithm SHA256).Hash.ToLower()
if (-not $want -or $want.ToLower() -ne $got) { throw "SHA256 mismatch: want '$want' got '$got'" }
Write-Host "SHA256 OK: $got"

$stage = Join-Path $VerDir 'stage'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
Expand-Archive -Path $Zip -DestinationPath $stage
Copy-Item (Join-Path $stage 'aoci.exe') 'D:\WorkSpace\Tools\aoci\aoci.exe' -Force
Remove-Item $stage -Recurse -Force
& 'D:\WorkSpace\Tools\aoci\aoci.exe' --version
