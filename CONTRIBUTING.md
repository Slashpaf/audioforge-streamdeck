# Contributing

Thanks for helping improve Audio Forge for Stream Deck. See [ASSET_LICENSE.md](ASSET_LICENSE.md) for the source and asset licensing status.

## Development setup

- Node.js 20.5.1 or newer and npm.
- Audio Forge with the Local API enabled for runtime checks.
- Stream Deck or OpenDeck for device-level checks.

```sh
npm ci
npm run typecheck
npm run build
node scripts/verify-manifest.mjs
```

To make a local Linux/OpenDeck archive, run `scripts/package-plugin.sh`. On Windows, run `build.bat`, which packages with PowerShell. The root MIT `LICENSE` covers plugin code and documentation; `ASSET_LICENSE.md` separates Audio Forge product and media assets from that grant.

## Releasing

The workflow in `.github/workflows/build-release.yml` builds and checks the plugin on every push, and on a `vX.Y.Z` tag it creates a **draft** GitHub Release containing the unencrypted `.streamDeckPlugin` installer and its checksum.

1. Run `./set-version.sh` (or `set-version.bat` on Windows) to update `package.json`, `package-lock.json` and `manifest.json` together (`1.2.3` in the package files, `1.2.3.0` in the manifest).
2. Add a section for the new version to `CHANGELOG.md`, then commit and push.
3. Push the matching tag, such as `v1.2.3`.
4. Review the draft release, then publish it.

## Pull requests

- Explain the user-visible change and any compatibility impact.
- Keep manifest, `package.json`, and `package-lock.json` versions in sync using the existing version updater when preparing a release.
- Do not commit API keys, local configuration, or generated `bin/` output.
- If artwork, screenshots, or recordings change, identify their source and redistribution terms.
- Include the checks you ran and note if hardware or OpenDeck validation was not available.
