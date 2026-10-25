import streamDeck, {
  action,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  SendToPluginEvent,
  SingletonAction,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { audioForge } from "../audioforge-client";
import type { SavedStateSettings } from "../types";

@action({ UUID: "com.slashpaf.audioforge.saved-state" })
export class SavedStateAction extends SingletonAction<SavedStateSettings> {
  private savedStatesListener = () => {
    this.iconCache.clear();
    this.updateAllButtons();
    this.pushStatesToOpenPI();
  };
  private connListener = (connected: boolean) => {
    this.updateAllButtons();
    if (connected) this.pushStatesToOpenPI();
  };
  private attached = false;

  private attach() {
    if (this.attached) return;
    this.attached = true;
    audioForge.onSavedStates(this.savedStatesListener);
    audioForge.onConnection(this.connListener);
  }

  private detach() {
    this.attached = false;
    audioForge.offSavedStates(this.savedStatesListener);
    audioForge.offConnection(this.connListener);
    this.iconCache.clear();
  }

  override async onWillAppear(ev: WillAppearEvent<SavedStateSettings>) {
    this.attach();
    // Always fetch a fresh icon when the button becomes visible (page navigation)
    if (ev.payload.settings.stateId) this.iconCache.delete(ev.payload.settings.stateId);
    await this.updateButton(ev.action, ev.payload.settings);
  }

  override async onWillDisappear(_ev: WillDisappearEvent<SavedStateSettings>) {
    let count = 0;
    for (const _ of this.actions) count++;
    if (count === 0) this.detach();
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SavedStateSettings>) {
    let settings = ev.payload.settings;
    const resolved = this.resolveStateName(settings);
    if (resolved && resolved !== settings.stateName) {
      settings = { ...settings, stateName: resolved };
      await ev.action.setSettings(settings);
    }
    // Invalidate cached icon when stateId changes
    this.iconCache.delete(settings.stateId);
    await this.updateButton(ev.action, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<SavedStateSettings>) {
    audioForge.launchIfOffline();
    const { stateId } = ev.payload.settings;
    if (!stateId) return;
    audioForge.send({ command: "restoreStateById", id: stateId });
  }

  override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, SavedStateSettings>) {
    const payload = ev.payload as Record<string, JsonValue>;
    if (payload.event !== "getSavedStates") return;
    await this.sendStatesToPI();
  }

  private async pushStatesToOpenPI() {
    if (!streamDeck.ui.action) return;
    if (streamDeck.ui.action.manifestId !== "com.slashpaf.audioforge.saved-state") return;
    await this.sendStatesToPI();
  }

  private async sendStatesToPI() {
    const states = audioForge.savedStates;
    if (!audioForge.isConnected || states.length === 0) {
      await streamDeck.ui.sendToPropertyInspector({
        event: "getSavedStates",
        items: [{ label: audioForge.isConnected ? "No saved states" : "Audio Forge not connected", value: "" }],
      });
      return;
    }
    const items = states.map((s) => ({
      label: s.group ? `${s.group} / ${s.name}` : s.name,
      value: s.id,
    }));
    await streamDeck.ui.sendToPropertyInspector({ event: "getSavedStates", items });
  }

  private async updateAllButtons() {
    for (const act of this.actions) {
      const settings = (await act.getSettings()) as SavedStateSettings;
      await this.updateButton(act, settings);
    }
  }

  private async updateButton(act: any, settings: SavedStateSettings) {
    const name = this.resolveStateName(settings) || "State";
    if (!audioForge.isConnected) {
      await act.setTitle(`${name}\n(offline)`);
      if (settings.iconData) await act.setImage(settings.iconData);
      return;
    }
    await act.setTitle(name);
    if (settings.stateId) {
      const icon = await this.loadIcon(act, settings);
      if (icon) await act.setImage(icon);
    }
  }

  private resolveStateName(settings: SavedStateSettings): string {
    if (settings.stateId) {
      const found = audioForge.savedStates.find((s) => s.id === settings.stateId);
      if (found) return found.name;
    }
    return settings.stateName || "";
  }

  private iconCache = new Map<string, string>();

  private async loadIcon(act: any, settings: SavedStateSettings): Promise<string | null> {
    const { stateId } = settings;
    if (!stateId) return null;
    const cached = this.iconCache.get(stateId);
    if (cached) {
      if (settings.iconData !== cached) await act.setSettings({ ...settings, iconData: cached });
      return cached;
    }
    try {
      const qs = `?size=144${audioForge.httpAuthQuery}`;
      const url = `${audioForge.httpBaseUrl}/api/saved_states/icon/${stateId}${qs}`;
      const resp = await fetch(url);
      if (!resp.ok) return settings.iconData || null;
      const buf = await resp.arrayBuffer();
      const dataUrl = `data:image/png;base64,${Buffer.from(buf).toString("base64")}`;
      this.iconCache.set(stateId, dataUrl);
      await act.setSettings({ ...settings, iconData: dataUrl });
      return dataUrl;
    } catch {
      return settings.iconData || null;
    }
  }
}
