#!/usr/bin/env bash
set -euo pipefail

echo "Installing locked dependencies..."
npm ci

echo "Building Audio Forge for Stream Deck..."
npm run typecheck
npm run build
node scripts/verify-manifest.mjs

echo "Build complete: com.slashpaf.audioforge.sdPlugin/bin/plugin.js"
scripts/package-plugin.sh
scripts/package-elgato.sh
