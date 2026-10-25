#!/usr/bin/env bash
echo "=== Audio Forge Stream Deck Plugin - Version Updater ==="
echo ""
echo "Enter the version  (e.g. 1.2.3 or 1.2.3.45)"
echo "  - package.json and package-lock.json: 1.2.3"
echo "  - manifest.json will be set to:      1.2.3.0  (or 1.2.3.45 if build specified)"
echo ""
read -rp "New version: " VERSION

if [[ -z "$VERSION" ]]; then
    echo "No version entered. Aborting."
    exit 1
fi

node set-version.cjs "$VERSION"
