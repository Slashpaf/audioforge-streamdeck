import streamDeck from "@elgato/streamdeck";
import WebSocket from "ws";

import { audioForge } from "./audioforge-client";
import type { GlobalSettings } from "./types";

import { PlayPauseAction } from "./actions/play-pause";
import { StopAction } from "./actions/stop";
import { NextTrackAction } from "./actions/next-track";
import { CategoryAction } from "./actions/category";
import { EchoAction } from "./actions/echo";
import { VolumeKeyAction, VolumeDialAction } from "./actions/volume";
import { LibraryAction } from "./actions/library";
import { SavedStateAction } from "./actions/saved-state";

// Ensure the plugin process exits cleanly when Stream Deck stops it
// (e.g. during uninstall). Without this, open WebSocket connections or
// timers can keep the Node.js event loop alive indefinitely.
const exitGracefully = () => {
  audioForge.shutdown();
  process.exit(0);
};
process.on("SIGTERM", exitGracefully);
process.on("SIGINT",  exitGracefully);
// SIGBREAK is the Windows equivalent of SIGTERM, sent by
// GenerateConsoleCtrlEvent / Ctrl+Break.
process.on("SIGBREAK" as NodeJS.Signals, exitGracefully);

// Detect when Stream Deck closes its WebSocket connection to the plugin
// (e.g. during uninstall or a soft restart). The SDK never handles this
// close event itself, so the process would stay alive indefinitely.
//
// The SDK always connects to ws://127.0.0.1:<port> — never "localhost" —
// which lets us identify its socket uniquely. We patch the WebSocket
// prototype once before streamDeck.connect() creates the socket, intercept
// the first 127.0.0.1 open, add a close handler, then restore the prototype.
const _origEmit = (WebSocket as any).prototype.emit;
(WebSocket as any).prototype.emit = function (this: any, event: string, ...args: any[]) {
  if (event === "open" && (this._url as string | undefined)?.startsWith("ws://127.0.0.1:")) {
    (WebSocket as any).prototype.emit = _origEmit; // restore immediately
    this.on("close", exitGracefully);
  }
  return _origEmit.call(this, event, ...args);
};

// Keep release logs concise; temporarily use "debug" during local diagnosis.
streamDeck.logger.setLevel("info");

// SDK v3 defaults to the new onDidReceiveSettings behavior, which needs Stream Deck 7.1.
// The actions here were written for the legacy behavior and the manifest supports 6.9.
streamDeck.settings.useLegacySettingsBehavior = true;

// Register all actions
streamDeck.actions.registerAction(new PlayPauseAction());
streamDeck.actions.registerAction(new StopAction());
streamDeck.actions.registerAction(new NextTrackAction());
streamDeck.actions.registerAction(new CategoryAction());
streamDeck.actions.registerAction(new EchoAction());
streamDeck.actions.registerAction(new VolumeKeyAction());
streamDeck.actions.registerAction(new VolumeDialAction());
streamDeck.actions.registerAction(new LibraryAction());
streamDeck.actions.registerAction(new SavedStateAction());

// When global settings change (port/API key), update the client
streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => {
  audioForge.updateSettings(ev.settings);
});

// Connect to the Stream Deck, then start the AudioForge client.
// getGlobalSettings() is called AFTER connect() so the SDK's once-listener
// is registered before the response arrives (avoids a race condition where
// the response fires before the listener is set up).
streamDeck.connect().then(async () => {
  const settings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
  audioForge.startWithSettings(settings);
});
