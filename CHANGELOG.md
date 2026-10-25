# Changelog

All notable changes to this plugin. Versions follow `package.json`; each release has a matching `vX.Y.Z` tag.

## 1.0.4

First public release.

- Actions: Play / Pause, Stop, Next Track, Category, Echo, Volume (keypad preset and Stream Deck+ dial), Library and Restore Saved State.
- Echo keys fill like Audio Forge's echo tiles while an echo plays, in the category's color, and stack when several play. A tap plays the echo; a long press stops the category's echoes, or enables the category as a background ambiance when nothing is playing. Echoes started inside Audio Forge also show on the keys with Audio Forge versions that push the `echoes` message.
- Connects to Audio Forge's Local API over WebSocket, follows its live state, and reconnects when Audio Forge restarts.
- Works with Elgato Stream Deck 6.9 or newer on Windows and macOS, and with OpenDeck on Linux.
