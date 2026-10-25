import {
  action,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  SingletonAction,
  WillAppearEvent,
} from "@elgato/streamdeck";
import { audioForge } from "../audioforge-client";
import type { StopSettings } from "../types";

@action({ UUID: "com.slashpaf.audioforge.stop" })
export class StopAction extends SingletonAction<StopSettings> {
  override async onWillAppear(ev: WillAppearEvent<StopSettings>): Promise<void> {
    const settings = ev.payload.settings;
    if (!settings.section) {
      await ev.action.setSettings({ section: "All" });
    }
    if (ev.action.isKey()) await ev.action.setTitle(settings.section || "All");
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<StopSettings>): Promise<void> {
    if (ev.action.isKey()) await ev.action.setTitle(ev.payload.settings.section || "All");
  }

  override async onKeyDown(ev: KeyDownEvent<StopSettings>): Promise<void> {
    audioForge.launchIfOffline();
    const section = ev.payload.settings.section || "All";
    audioForge.send({ command: "stop", section });
  }
}
