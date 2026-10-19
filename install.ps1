<#.
.SYNOPSIS
  Installe Agent Browser Control (clone + dépendances).
.EXAMPLE
  irm https://raw.githubusercontent.com/salmund/agent-browser-control/main/install.ps1 | iex
  .\install.ps1 -Dir "$env:USERPROFILE\agent-browser-control"
#>
param([string]$Dir = (Join-Path $env:USERPROFILE "agent-browser-control"))

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

function Exige($cmd, $quoi) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "$quoi introuvable : installez $quoi avant de continuer." }
}

Exige "git" "Git"
Exige "node" "Node.js 22.18+"
$node = (node -v).TrimStart("v").Split(".") | ForEach-Object { [int]$_ }
if ($node[0] -lt 22 -or ($node[0] -eq 22 -and $node[1] -lt 18)) { throw "Node.js trop ancien ($(node -v)) : 22.18+ requis." }

if (Test-Path (Join-Path $Dir ".git")) {
  Write-Host "Dépôt existant : mise à jour..."
  git -C $Dir pull --ff-only
} elseif (Test-Path $Dir) {
  throw "Le dossier $Dir existe sans être le dépôt : choisissez -Dir ailleurs."
} else {
  Write-Host "Clonage dans $Dir..."
  git clone https://github.com/salmund/agent-browser-control.git $Dir
}

Write-Host "Dépendances..."
npm --prefix $Dir install --no-audit --no-fund

$mcp = Join-Path $Dir "server\mcp.ts" -replace "\\", "/"
Write-Host ""
Write-Host "Terminé. Reste deux gestes manuels :"
Write-Host "1. Chargez l'extension : chrome://extensions, mode développeur, charger $Dir\extension"
Write-Host "2. Déclarez le serveur MCP de votre agent :"
Write-Host ""
Write-Host "{ `"mcpServers`": { `"agent-browser-control`": { `"command`": `"node`", `"args`": [`"$mcp`"] } } }"
Write-Host ""
Write-Host "Mises à jour ensuite : npm run update (dans $Dir)"
