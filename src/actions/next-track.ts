import {
  action,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  SingletonAction,
  WillAppearEvent,
} from "@elgato/streamdeck";
import { audioForge } from "../audioforge-client";
import type { NextTrackSettings } from "../types";

@action({ UUID: "com.slashpaf.audioforge.next-track" })
export class NextTrackAction extends SingletonAction<NextTrackSettings> {
  override async onWillAppear(ev: WillAppearEvent<NextTrackSettings>): Promise<void> {
    const settings = ev.payload.settings;
    if (!settings.section) {
      await ev.action.setSettings({ section: "Music" });
    }
    if (ev.action.isKey()) await ev.action.setTitle(settings.section || "Music");
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<NextTrackSettings>): Promise<void> {
    if (ev.action.isKey()) await ev.action.setTitle(ev.payload.settings.section || "Music");
  }

  override async onKeyDown(ev: KeyDownEvent<NextTrackSettings>): Promise<void> {
    const section = ev.payload.settings.section || "Music";
    const state = audioForge.state;
    if (!state) return;
    // The app skips one category at a time, so skip every active category of the section.
    const playing = section === "Music" ? state.musicCategories : state.ambianceCategories;
    for (const cat of playing ?? []) {
      audioForge.send({ command: "nextTrack", section, categoryUuid: cat.uuid });
    }
  }
}
