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
import type { EchoSettings } from "../types";

@action({ UUID: "com.slashpaf.audioforge.echo" })
export class EchoAction extends SingletonAction<EchoSettings> {
  private _lastLibraryUuid: string | null = null;
  private stateListener = (state: { libraryUuid?: string }) => {
    if (state.libraryUuid && state.libraryUuid !== this._lastLibraryUuid) {
      this._lastLibraryUuid = state.libraryUuid;
      this.pushCategoriesToOpenPI();
    }
  };
  private catalogListener = () => {
    this.iconCache.clear();
    this.updateAllButtons();
    this.pushCategoriesToOpenPI();
  };
  private connListener = (connected: boolean) => {
    this.updateAllButtons();
    if (connected) this.pushCategoriesToOpenPI();
  };
  private attached = false;

  private attach() {
    if (this.attached) return;
    this.attached = true;
    audioForge.onState(this.stateListener as any);
    audioForge.onCatalog(this.catalogListener);
    audioForge.onConnection(this.connListener);
  }

  private detach() {
    this.attached = false;
    audioForge.offState(this.stateListener as any);
    audioForge.offCatalog(this.catalogListener);
    audioForge.offConnection(this.connListener);
  }

  override async onWillAppear(ev: WillAppearEvent<EchoSettings>): Promise<void> {
    this.attach();
    await this.updateButton(ev.action, ev.payload.settings);
  }

  override async onWillDisappear(_ev: WillDisappearEvent<EchoSettings>): Promise<void> {
    let count = 0;
    for (const _ of this.actions) count++;
    if (count === 0) this.detach();
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<EchoSettings>): Promise<void> {
    let settings = ev.payload.settings;
    const resolved = this.resolveName(settings);
    if (resolved && resolved !== settings.categoryName && resolved !== "Echo") {
      settings = { ...settings, categoryName: resolved };
      await ev.action.setSettings(settings);
    }
    await this.updateButton(ev.action, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<EchoSettings>): Promise<void> {
    audioForge.launchIfOffline();
    const { categoryUuid } = ev.payload.settings;
    if (!categoryUuid) return;
    audioForge.send({ command: "playEcho", section: "Ambiance", categoryUuid });
    // Brief visual feedback
    if (ev.action.isKey()) {
      await ev.action.showOk();
    }
  }

  override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, EchoSettings>): Promise<void> {
    const payload = ev.payload as Record<string, JsonValue>;
    if (payload.event !== "getCategories") return;

    const catalog = audioForge.catalog;
    if (!catalog || !catalog.libraries) {
      await streamDeck.ui.sendToPropertyInspector({
        event: "getCategories",
        items: [{ label: "Audio Forge not connected", value: "" }],
      });
      return;
    }

    const activeLibUuid = audioForge.state?.libraryUuid || catalog.activeLibraryUuid;
    const lib = catalog.libraries.find((l) => l.uuid === activeLibUuid) || catalog.libraries[0];
    // Echo = ambiance categories with oneShot enabled
    const echoes = (lib?.ambiance || []).filter((c) => c.oneShot);
    const items = echoes.map((c) => ({ label: c.name, value: c.uuid }));
    await streamDeck.ui.sendToPropertyInspector({
      event: "getCategories",
      items: items.length > 0 ? items : [{ label: "No echo categories found", value: "" }],
    });
  }

  private async pushCategoriesToOpenPI(): Promise<void> {
    if (!streamDeck.ui.action) return;
    if (streamDeck.ui.action.manifestId !== "com.slashpaf.audioforge.echo") return;
    const catalog = audioForge.catalog;
    if (!catalog || !catalog.libraries) return;

    try {
      const activeLibUuid = audioForge.state?.libraryUuid || catalog.activeLibraryUuid;
      const lib = catalog.libraries.find((l) => l.uuid === activeLibUuid) || catalog.libraries[0];
      const echoes = (lib?.ambiance || []).filter((c) => c.oneShot);
      const items = echoes.map((c) => ({ label: c.name, value: c.uuid }));
      await streamDeck.ui.sendToPropertyInspector({
        event: "getCategories",
        items: items.length > 0 ? items : [{ label: "No echo categories found", value: "" }],
      });
    } catch (e) {
      streamDeck.logger.error(`Echo pushCategoriesToOpenPI failed: ${e}`);
    }
  }

  private async updateAllButtons() {
    for (const action of this.actions) {
      const settings = (await action.getSettings()) as EchoSettings;
      await this.updateButton(action, settings);
    }
  }

  private async updateButton(act: any, settings: EchoSettings) {
    const name = this.resolveName(settings);
    if (!audioForge.isConnected) {
      await act.setTitle(`${name}\n(offline)`);
      if (act.isKey()) await act.setState(0);
      if (settings.iconData) await act.setImage(settings.iconData);
      return;
    }
    await act.setTitle(name);
    if (settings.categoryUuid) {
      await this.loadIcon(act, settings, settings.categoryUuid);
    }
  }

  private resolveName(settings: EchoSettings): string {
    if (settings.categoryUuid) {
      const catalog = audioForge.catalog;
      if (catalog?.libraries) {
        for (const lib of catalog.libraries) {
          const found = (lib.ambiance || []).find((c) => c.uuid === settings.categoryUuid);
          if (found) return found.name;
        }
      }
    }
    return settings.categoryName || "Echo";
  }

  private iconCache = new Map<string, string>();

  private async loadIcon(act: any, settings: EchoSettings, uuid: string) {
    let dataUrl = this.iconCache.get(uuid);
    if (dataUrl) {
      await act.setImage(dataUrl);
      if (settings.iconData !== dataUrl) {
        await act.setSettings({ ...settings, iconData: dataUrl });
      }
      return;
    }
    try {
      const url = `${audioForge.httpBaseUrl}/api/icon/${uuid}?size=144${audioForge.httpAuthQuery}`;
      const resp = await fetch(url);
      if (!resp.ok) return;
      const contentType = resp.headers.get("content-type") || "image/png";
      const buffer = await resp.arrayBuffer();
      const base64 = Buffer.from(buffer).toString("base64");
      dataUrl = `data:${contentType};base64,${base64}`;
      this.iconCache.set(uuid, dataUrl);
      await act.setImage(dataUrl);
      if (settings.iconData !== dataUrl) {
        await act.setSettings({ ...settings, iconData: dataUrl });
      }
    } catch (e) {
      streamDeck.logger.error(`Icon fetch failed for ${uuid}: ${e}`);
    }
  }
}
