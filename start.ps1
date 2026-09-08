param(
  [switch]$Build
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if ($Build) {
  npm run build
}

node .\scripts\start-standalone.cjs
