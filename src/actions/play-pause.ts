import {
  action,
  KeyDownEvent,
  SingletonAction,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import { audioForge } from "../audioforge-client";
import type { AudioForgeState, PlayPauseSettings } from "../types";

@action({ UUID: "com.slashpaf.audioforge.play-pause" })
export class PlayPauseAction extends SingletonAction<PlayPauseSettings> {
  private listener = (state: AudioForgeState) => this.updateAllButtons(state);
  private connListener = (_connected: boolean) => this.updateAllButtons(audioForge.state);
  private attached = false;

  private attach() {
    if (this.attached) return;
    this.attached = true;
    audioForge.onState(this.listener);
    audioForge.onConnection(this.connListener);
  }

  private detach() {
    this.attached = false;
    audioForge.offState(this.listener);
    audioForge.offConnection(this.connListener);
  }

  override async onWillAppear(ev: WillAppearEvent<PlayPauseSettings>): Promise<void> {
    this.attach();
    const settings = ev.payload.settings;
    if (!settings.section) {
      await ev.action.setSettings({ section: "Music" });
    }
    await this.updateButton(ev.action, settings, audioForge.state);
  }

  override async onWillDisappear(_ev: WillDisappearEvent<PlayPauseSettings>): Promise<void> {
    // Detach listeners when no actions remain visible
    let count = 0;
    for (const _ of this.actions) count++;
    if (count === 0) this.detach();
  }

  override async onKeyDown(ev: KeyDownEvent<PlayPauseSettings>): Promise<void> {
    audioForge.launchIfOffline();
    const section = ev.payload.settings.section || "Music";
    const state = audioForge.state;
    const isPlaying = section === "Music" ? state?.musicPlaying : state?.ambiancePlaying;
    audioForge.send({ command: isPlaying ? "pause" : "play", section });
  }

  private async updateAllButtons(state: AudioForgeState | null) {
    for (const a of this.actions) {
      const settings = (await a.getSettings()) as PlayPauseSettings;
      await this.updateButton(a, settings, state);
    }
  }

  private async updateButton(
    act: any,
    settings: PlayPauseSettings,
    state: AudioForgeState | null,
  ) {
    const section = settings.section || "Music";
    if (!audioForge.isConnected || !state) {
      await act.setTitle(`${section}\n(offline)`);
      if (act.isKey()) await act.setState(0);
      return;
    }
    const isPlaying = section === "Music" ? state.musicPlaying : state.ambiancePlaying;
    if (act.isKey()) await act.setState(isPlaying ? 1 : 0);
    await act.setTitle(section);
  }
}
