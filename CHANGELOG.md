# Changelog

All notable changes to this plugin. Versions follow `package.json`; each release has a matching `vX.Y.Z` tag.

## 1.0.4

Everything since 1.0.2, the last version before the public release. This is also the first release published here.

### New

- **Next Track** action: skips to the next track in the active Music or Ambiance categories.
- **Volume** keys and dials can control a single category instead of the whole section. The Category setting is optional; leave it empty for the whole section, as before.
- **Echo keys** now work like the Echo tiles in Audio Forge:
  - While an echo plays, the key fills from the left in the category's color over the echo's length. Several echoes of the same category stack and get brighter where they overlap.
  - A tap plays the echo, on release.
  - A long press stops the category's echoes. When nothing is playing, a long press enables the category as a background ambiance, and the key shows the same darker amber as in the app until it is switched off.
  - Echoes started inside Audio Forge are drawn on the matching keys too. This needs an Audio Forge version that sends the new `echoes` message; with older versions, keys show the echoes they started themselves.
- **OpenDeck:** the release now includes an unencrypted `.streamDeckPlugin` installer and a SHA-256 checksum that OpenDeck accepts through Install from file.

### Changed

- The Echo key no longer flashes briefly after a press; the fill shows that the echo is playing.
- Category lists in the key settings skip categories that are disabled or have no tracks.
- The settings pages no longer load scripts from a CDN. The `sdpi-components` library is bundled.
- Your API key is kept out of the plugin's logs.
- Built on Elgato SDK 3.0.3. Stream Deck 6.9 or newer on Windows and macOS, and OpenDeck on Linux, are still supported, and so is Node.js 20.5.1 or newer.
- Updated dependencies, including `ws` 8.22.0.
