#!/usr/bin/env bash
# Installe Agent Browser Control (clone + dépendances).
#   curl -fsSL https://raw.githubusercontent.com/salmund/agent-browser-control/main/install.sh | bash
set -euo pipefail
DIR="${1:-$HOME/agent-browser-control}"

command -v git >/dev/null || { echo "Git introuvable."; exit 1; }
command -v node >/dev/null || { echo "Node.js 22.18+ introuvable."; exit 1; }

if [ -d "$DIR/.git" ]; then
  echo "Dépôt existant : mise à jour..."
  git -C "$DIR" pull --ff-only
elif [ -e "$DIR" ]; then
  echo "Le dossier $DIR existe sans être le dépôt."
  exit 1
else
  echo "Clonage dans $DIR..."
  git clone https://github.com/salmund/agent-browser-control.git "$DIR"
fi

echo "Dépendances..."
npm --prefix "$DIR" install --no-audit --no-fund

echo ""
echo "Terminé. Reste deux gestes manuels :"
echo "1. Chargez l'extension : chrome://extensions, mode développeur, charger $DIR/extension"
echo "2. Déclarez le serveur MCP de votre agent :"
echo ""
echo "{ \"mcpServers\": { \"agent-browser-control\": { \"command\": \"node\", \"args\": [\"$DIR/server/mcp.ts\"] } } }"
echo ""
echo "Mises à jour ensuite : npm run update (dans $DIR)"
