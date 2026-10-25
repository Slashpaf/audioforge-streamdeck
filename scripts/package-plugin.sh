#!/usr/bin/env bash
set -euo pipefail

output_file=""
require_license=false
for arg in "$@"; do
  case "$arg" in
    --require-license) require_license=true ;;
    *)
      if [[ -n "$output_file" ]]; then
        echo "Usage: $0 [output.zip] [--require-license]" >&2
        exit 2
      fi
      output_file="$arg"
      ;;
  esac
done

version="$(node -p "require('./package.json').version")"
plugin_dir="com.slashpaf.audioforge.sdPlugin"
output_file="${output_file:-dist/opendeck/Audio-Forge-v${version}-opendeck.zip}"
if [[ "$output_file" != /* ]]; then output_file="$(pwd)/$output_file"; fi

if [[ ! -s LICENSE ]]; then
  if [[ "$require_license" == true ]]; then
    echo "A root LICENSE file is required for a distributable release." >&2
    exit 1
  fi
  echo "Warning: packaging without the project license; do not publish this archive." >&2
fi

node scripts/verify-manifest.mjs
stage_dir="$(mktemp -d)"
trap 'rm -rf "$stage_dir"' EXIT
cp -R "$plugin_dir" "$stage_dir/"
staged_plugin="$stage_dir/$plugin_dir"
# Keep local runtime/debug data out of archives, even if it sits inside a copied
# plugin directory. Build output is produced before packaging and remains intact.
find "$staged_plugin" -type d \
  \( -iname logs -o -iname node_modules -o -iname .git -o -iname .cache -o -iname coverage -o -iname tmp -o -iname temp \) \
  -prune -exec rm -rf {} +
find "$staged_plugin" -type f \
  \( -iname '*.map' -o -iname '*.log' -o -iname '*.pem' -o -iname '*.key' -o -iname '*.p12' -o -iname '*.pfx' \
     -o -iname '*.tsbuildinfo' -o -iname '.env' -o -iname '.env.*' -o -iname '.ds_store' -o -iname 'thumbs.db' \) \
  -delete
if [[ -s LICENSE ]]; then cp LICENSE "$stage_dir/$plugin_dir/LICENSE"; fi
if [[ -s ASSET_LICENSE.md ]]; then cp ASSET_LICENSE.md "$stage_dir/$plugin_dir/ASSET_LICENSE.md"; fi

mkdir -p "$(dirname "$output_file")"
rm -f "$output_file" "${output_file}.sha256"
(cd "$stage_dir" && zip -q -r "$output_file" "$plugin_dir")
unzip -t "$output_file" >/dev/null
output_directory="$(dirname "$output_file")"
archive_name="$(basename "$output_file")"
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$output_directory" && sha256sum "$archive_name" > "${archive_name}.sha256")
elif command -v shasum >/dev/null 2>&1; then
  (cd "$output_directory" && shasum -a 256 "$archive_name" > "${archive_name}.sha256")
else
  echo "A SHA-256 utility (sha256sum or shasum) is required." >&2
  exit 1
fi
echo "Created $output_file"
echo "SHA-256: ${output_file}.sha256"
