#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

plugin_dir="com.slashpaf.audioforge.sdPlugin"
output_dir="${1:-dist/elgato}"
if [[ "$output_dir" != /* ]]; then output_dir="$repo_root/$output_dir"; fi
cli="$repo_root/node_modules/.bin/streamdeck"

if [[ ! -s LICENSE ]]; then
  echo "A root LICENSE file is required to package a distributable plugin." >&2
  exit 1
fi
if [[ ! -x "$cli" ]]; then
  echo "Elgato's pinned CLI is missing. Run npm ci, then retry." >&2
  exit 1
fi

node scripts/verify-manifest.mjs
stage_dir="$(mktemp -d)"
trap 'rm -rf "$stage_dir"' EXIT
cp -R "$plugin_dir" "$stage_dir/"
staged_plugin="$stage_dir/$plugin_dir"

# Stage a clean package so local runtime data and development files cannot ship.
find "$staged_plugin" -type d \
  \( -iname logs -o -iname node_modules -o -iname .git -o -iname .cache -o -iname coverage -o -iname tmp -o -iname temp \) \
  -prune -exec rm -rf {} +
find "$staged_plugin" -type f \
  \( -iname '*.map' -o -iname '*.log' -o -iname '*.pem' -o -iname '*.key' -o -iname '*.p12' -o -iname '*.pfx' \
     -o -iname '*.tsbuildinfo' -o -iname '.env' -o -iname '.env.*' -o -iname '.ds_store' -o -iname 'thumbs.db' \) \
  -delete
cp LICENSE "$staged_plugin/LICENSE"
if [[ -s ASSET_LICENSE.md ]]; then cp ASSET_LICENSE.md "$staged_plugin/ASSET_LICENSE.md"; fi

mkdir -p "$output_dir"
"$cli" pack "$staged_plugin" --force --output "$output_dir" --no-update-check --no-file-list
archive="$output_dir/com.slashpaf.audioforge.streamDeckPlugin"
if [[ ! -s "$archive" ]]; then
  echo "Elgato CLI did not create the expected package: $archive" >&2
  exit 1
fi
archive_name="$(basename "$archive")"
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$output_dir" && sha256sum "$archive_name" > "${archive_name}.sha256")
elif command -v shasum >/dev/null 2>&1; then
  (cd "$output_dir" && shasum -a 256 "$archive_name" > "${archive_name}.sha256")
else
  echo "A SHA-256 utility (sha256sum or shasum) is required." >&2
  exit 1
fi
echo "Created $archive"
echo "SHA-256: ${archive}.sha256"
