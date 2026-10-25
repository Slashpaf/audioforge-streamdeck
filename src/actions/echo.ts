import streamDeck, {
  action,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  KeyUpEvent,
  SendToPluginEvent,
  SingletonAction,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { audioForge } from "../audioforge-client";
import { makeActiveImage } from "../image-utils";
import type { EchoSettings } from "../types";

/** The key stays amber for the echo's length, within these bounds. */
const MIN_FLASH_MS = 350;
const MAX_FLASH_MS = 30_000;
/** Holding the key this long while its echo plays stops the echo. */
const LONG_PRESS_MS = 500;

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

  // Like the Echo screen in Audio Forge: a tap (decided on release) plays the echo, and a long press
  // stops everything of this category, or, when nothing is playing, enables it as a background ambiance.
  override async onKeyDown(ev: KeyDownEvent<EchoSettings>): Promise<void> {
    audioForge.launchIfOffline();
    const settings = ev.payload.settings;
    if (!settings.categoryUuid) return;
    const id = ev.action.id;
    clearTimeout(this.pressTimers.get(id));
    const timer = setTimeout(() => {
      this.pressTimers.delete(id);
      void this.onLongPress(ev.action, settings);
    }, LONG_PRESS_MS);
    timer.unref();
    this.pressTimers.set(id, timer);
  }

  override async onKeyUp(ev: KeyUpEvent<EchoSettings>): Promise<void> {
    const id = ev.action.id;
    const timer = this.pressTimers.get(id);
    if (!timer) return; // The long press already fired.
    clearTimeout(timer);
    this.pressTimers.delete(id);
    await this.playAndFlash(ev.action, ev.payload.settings);
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

  private flashTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** When each key stops being amber, i.e. when its echo is expected to end. */
  private litUntil = new Map<string, number>();
  private pressTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private isLit(id: string): boolean {
    return (this.litUntil.get(id) ?? 0) > Date.now();
  }

  /** True while the category runs as a normal (background) ambiance. */
  private isAmbianceActive(uuid: string): boolean {
    const state = audioForge.state;
    return !!state?.ambiancePlaying && (state.ambianceCategories ?? []).some((c) => c.uuid === uuid);
  }

  /** Show the idle icon, or the amber one while the category runs as an ambiance. */
  private async settleImage(act: any, settings: EchoSettings) {
    if (!act.isKey()) return;
    const icon = this.iconCache.get(settings.categoryUuid) ?? settings.iconData;
    if (!icon) return;
    const image = this.isAmbianceActive(settings.categoryUuid)
      ? makeActiveImage(icon, this.categoryColor(settings.categoryUuid))
      : icon;
    await act.setImage(image).catch(() => {});
  }

  private async onLongPress(act: any, settings: EchoSettings) {
    const uuid = settings.categoryUuid;
    const echoPlaying = this.isLit(act.id);
    const ambianceActive = this.isAmbianceActive(uuid);
    clearTimeout(this.flashTimers.get(act.id));
    this.flashTimers.delete(act.id);
    this.litUntil.delete(act.id);
    try {
      if (echoPlaying || ambianceActive) {
        await audioForge.request({ command: "stopEcho", categoryUuid: uuid });
        if (ambianceActive) {
          await audioForge.request({ command: "setCategoryEnabled", section: "Ambiance", categoryUuid: uuid, enabled: false });
        }
      } else {
        await audioForge.request({ command: "setCategoryEnabled", section: "Ambiance", categoryUuid: uuid, enabled: true });
      }
    } catch (e) {
      streamDeck.logger.warn(`Echo long press failed: ${e instanceof Error ? e.message : e}`);
    }
    await this.settleImage(act, settings);
  }

  /**
   * Play the echo and keep the key amber, like an active category, until it finishes.
   * Audio Forge's reply carries durationMs; without it the key flashes briefly.
   */
  private async playAndFlash(act: any, settings: EchoSettings) {
    const started = Date.now();
    const icon = act.isKey() ? this.iconCache.get(settings.categoryUuid) ?? settings.iconData : "";
    const restore = (afterMs: number) => {
      clearTimeout(this.flashTimers.get(act.id));
      this.litUntil.set(act.id, Date.now() + afterMs);
      const timer = setTimeout(() => {
        this.flashTimers.delete(act.id);
        this.litUntil.delete(act.id);
        void this.settleImage(act, settings);
      }, afterMs);
      timer.unref();
      this.flashTimers.set(act.id, timer);
    };

    if (icon) {
      await act.setImage(makeActiveImage(icon, this.categoryColor(settings.categoryUuid)));
      restore(MAX_FLASH_MS); // safety net until the reply says how long the echo is
    }
    try {
      const reply = await audioForge.request({
        command: "playEcho",
        section: "Ambiance",
        categoryUuid: settings.categoryUuid,
      });
      const duration = typeof reply.durationMs === "number" ? reply.durationMs : 0;
      if (icon) {
        const remaining = duration - (Date.now() - started);
        restore(Math.min(MAX_FLASH_MS, Math.max(MIN_FLASH_MS, remaining)));
      }
    } catch (e) {
      streamDeck.logger.warn(`Echo did not start: ${e instanceof Error ? e.message : e}`);
      if (icon) restore(MIN_FLASH_MS);
    }
  }

  private categoryColor(uuid: string): string | null {
    for (const lib of audioForge.catalog?.libraries ?? []) {
      const found = (lib.ambiance || []).find((c) => c.uuid === uuid);
      if (found) return found.color ?? null;
    }
    return null;
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
    if (this.isLit(act.id)) return; // Keep the amber flash running while the echo plays.
    if (settings.categoryUuid) {
      await this.loadIcon(act, settings, settings.categoryUuid);
      await this.settleImage(act, settings);
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
