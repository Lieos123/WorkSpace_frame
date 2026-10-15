# CodeGraph -> D:\WorkSpace\Tools\codegraph (stable library path)
# Re-run this file to upgrade in place.
$ErrorActionPreference = 'Stop'
$env:CODEGRAPH_INSTALL_DIR = 'D:\WorkSpace\Tools\codegraph'
# Pinned so the installer skips its GitHub API call (rate-limited on this network).
$env:CODEGRAPH_VERSION = 'v1.6.2'
irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex
Write-Host ''
Write-Host 'D:\WorkSpace\Tools\codegraph:'
Get-ChildItem 'D:\WorkSpace\Tools\codegraph' | Select-Object -ExpandProperty Name
Write-Host 'current\bin:'
Get-ChildItem 'D:\WorkSpace\Tools\codegraph\current\bin' | Select-Object -ExpandProperty Name
