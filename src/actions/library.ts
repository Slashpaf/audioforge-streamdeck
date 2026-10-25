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
import type { AudioForgeState, LibrarySettings } from "../types";

@action({ UUID: "com.slashpaf.audioforge.library" })
export class LibraryAction extends SingletonAction<LibrarySettings> {
  private listener = (state: AudioForgeState) => this.updateAllButtons(state);
  private connListener = (connected: boolean) => {
    this.updateAllButtons(audioForge.state);
    if (connected) this.pushLibrariesToOpenPI();
  };
  private catalogListener = () => this.pushLibrariesToOpenPI();
  private attached = false;

  private attach() {
    if (this.attached) return;
    this.attached = true;
    audioForge.onState(this.listener);
    audioForge.onConnection(this.connListener);
    audioForge.onCatalog(this.catalogListener);
  }

  private detach() {
    this.attached = false;
    audioForge.offState(this.listener);
    audioForge.offConnection(this.connListener);
    audioForge.offCatalog(this.catalogListener);
  }

  override async onWillAppear(ev: WillAppearEvent<LibrarySettings>): Promise<void> {
    this.attach();
    await this.updateButton(ev.action, ev.payload.settings, audioForge.state);
  }

  override async onWillDisappear(_ev: WillDisappearEvent<LibrarySettings>): Promise<void> {
    let count = 0;
    for (const _ of this.actions) count++;
    if (count === 0) this.detach();
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<LibrarySettings>): Promise<void> {
    let settings = ev.payload.settings;
    const resolved = this.resolveLibraryName(settings);
    if (resolved && resolved !== settings.libraryName && resolved !== settings.libraryUuid && resolved !== "Library") {
      settings = { ...settings, libraryName: resolved };
      await ev.action.setSettings(settings);
    }
    await this.updateButton(ev.action, settings, audioForge.state);
  }

  override async onKeyDown(ev: KeyDownEvent<LibrarySettings>): Promise<void> {
    audioForge.launchIfOffline();
    const { libraryUuid } = ev.payload.settings;
    if (!libraryUuid) return;
    audioForge.send({ command: "setActiveLibrary", libraryUuid });
  }

  override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, LibrarySettings>): Promise<void> {
    const payload = ev.payload as Record<string, JsonValue>;
    if (payload.event !== "getLibraries") return;

    const catalog = audioForge.catalog;
    if (!catalog || !catalog.libraries) {
      await streamDeck.ui.sendToPropertyInspector({
        event: "getLibraries",
        items: [{ label: "Audio Forge not connected", value: "" }],
      });
      return;
    }

    const items = catalog.libraries.map((l) => ({ label: l.name, value: l.uuid }));
    await streamDeck.ui.sendToPropertyInspector({
      event: "getLibraries",
      items: items.length > 0 ? items : [{ label: "No libraries found", value: "" }],
    });
  }

  private async pushLibrariesToOpenPI(): Promise<void> {
    if (!streamDeck.ui.action) return;
    if (streamDeck.ui.action.manifestId !== "com.slashpaf.audioforge.library") return;
    const catalog = audioForge.catalog;
    if (!catalog || !catalog.libraries) return;

    try {
      const items = catalog.libraries.map((l) => ({ label: l.name, value: l.uuid }));
      await streamDeck.ui.sendToPropertyInspector({
        event: "getLibraries",
        items: items.length > 0 ? items : [{ label: "No libraries found", value: "" }],
      });
    } catch (e) {
      streamDeck.logger.error(`Library pushLibrariesToOpenPI failed: ${e}`);
    }
  }

  private async updateAllButtons(state: AudioForgeState | null) {
    for (const action of this.actions) {
      const settings = (await action.getSettings()) as LibrarySettings;
      await this.updateButton(action, settings, state);
    }
  }

  private async updateButton(act: any, settings: LibrarySettings, state: AudioForgeState | null) {
    const name = this.resolveLibraryName(settings) || "Library";
    if (!audioForge.isConnected || !state) {
      await act.setTitle(`${name}\n(offline)`);
      if (act.isKey()) await act.setState(0);
      return;
    }
    const isActive = state.libraryUuid === settings.libraryUuid;
    if (act.isKey()) await act.setState(isActive ? 1 : 0);
    await act.setTitle(name);
  }

  private resolveLibraryName(settings: LibrarySettings): string {
    if (settings.libraryUuid) {
      const catalog = audioForge.catalog;
      if (catalog?.libraries) {
        const found = catalog.libraries.find((l) => l.uuid === settings.libraryUuid);
        if (found) return found.name;
      }
    }
    return settings.libraryName || "";
  }
}
