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
import { ENABLED_BG, makeActiveImage, makeFilledImage } from "../image-utils";
import type { ActiveEcho, AudioForgeState, EchoSettings } from "../types";

/** Audio Forge fills a tile for at least this long, even when it does not know the echo's length. */
const MIN_FILL_MS = 400;
/** How often the fill is redrawn on the key. */
const TICK_MS = 150;
/** After a long press stops the echoes, pushes that were already in flight are ignored for this long. */
const STOP_QUIET_MS = 800;
/** Idle key background behind the translucent fill. */
const IDLE_BG = "#000000";
/** Holding the key this long stops the category, or enables it in the background when idle. */
const LONG_PRESS_MS = 500;

@action({ UUID: "com.slashpaf.audioforge.echo" })
export class EchoAction extends SingletonAction<EchoSettings> {
  private _lastLibraryUuid: string | null = null;
  private _lastAmbianceSignature = "";
  private stateListener = (state: AudioForgeState) => {
    if (state.libraryUuid && state.libraryUuid !== this._lastLibraryUuid) {
      this._lastLibraryUuid = state.libraryUuid;
      this.pushCategoriesToOpenPI();
    }
    // Keys show whether their category runs as a background ambiance, so redraw when that changes.
    const signature = `${state.ambiancePlaying}|${(state.ambianceCategories ?? []).map((c) => c.uuid).sort().join(",")}`;
    if (signature !== this._lastAmbianceSignature) {
      this._lastAmbianceSignature = signature;
      void this.updateAllButtons();
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
  /** Echo keys currently on a deck, so a push can be matched to them without asking Stream Deck. */
  private keys = new Map<string, { act: any; settings: EchoSettings }>();
  private stoppedAt = new Map<string, number>();
  private echoesListener = (echoes: ActiveEcho[]) => {
    void this.applyEchoes(echoes);
  };

  private attach() {
    if (this.attached) return;
    this.attached = true;
    audioForge.onState(this.stateListener as any);
    audioForge.onCatalog(this.catalogListener);
    audioForge.onConnection(this.connListener);
    audioForge.onEchoes(this.echoesListener);
  }

  private detach() {
    this.attached = false;
    audioForge.offState(this.stateListener as any);
    audioForge.offCatalog(this.catalogListener);
    audioForge.offConnection(this.connListener);
    audioForge.offEchoes(this.echoesListener);
  }

  override async onWillAppear(ev: WillAppearEvent<EchoSettings>): Promise<void> {
    this.attach();
    this.keys.set(ev.action.id, { act: ev.action, settings: ev.payload.settings });
    await this.updateButton(ev.action, ev.payload.settings);
    await this.applyEchoes(audioForge.echoes, ev.action.id);
  }

  override async onWillDisappear(ev: WillDisappearEvent<EchoSettings>): Promise<void> {
    this.keys.delete(ev.action.id);
    this.stoppedAt.delete(ev.action.id);
    this.clearFills(ev.action.id);
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
    this.keys.set(ev.action.id, { act: ev.action, settings });
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
    await this.playEcho(ev.action, ev.payload.settings);
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

  private pressTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Echoes playing from each key. Each one draws a bar that grows over the echo's length. */
  private fills = new Map<string, Map<string, { start: number; duration: number; color: string }>>();
  private tickers = new Map<string, ReturnType<typeof setInterval>>();

  private activeFills(id: string) {
    const now = Date.now();
    const byEcho = this.fills.get(id);
    if (!byEcho) return [];
    for (const [playbackId, f] of byEcho) {
      if (now - f.start >= f.duration) byEcho.delete(playbackId);
    }
    if (byEcho.size === 0) this.fills.delete(id);
    return [...byEcho.values()];
  }

  /** True while an echo started from this key is still playing. */
  private isLit(id: string): boolean {
    return this.activeFills(id).length > 0;
  }

  private clearFills(id: string) {
    this.fills.delete(id);
    clearInterval(this.tickers.get(id));
    this.tickers.delete(id);
  }

  /** True while the category runs as a normal (background) ambiance. */
  private isAmbianceActive(uuid: string): boolean {
    const state = audioForge.state;
    return !!state?.ambiancePlaying && (state.ambianceCategories ?? []).some((c) => c.uuid === uuid);
  }

  /**
   * Draw the key: running echoes as growing bars in the category's color, on the darker amber when the
   * category also runs as an ambiance, otherwise the plain icon. `active` overrides the ambiance state.
   */
  private async settleImage(
    act: any,
    settings: EchoSettings,
    active: boolean = this.isAmbianceActive(settings.categoryUuid),
  ) {
    if (!act.isKey()) return;
    const icon = this.iconCache.get(settings.categoryUuid) ?? settings.iconData;
    if (!icon) return;
    const now = Date.now();
    const fills = this.activeFills(act.id).map((f) => ({ progress: (now - f.start) / f.duration, color: f.color }));
    const color = this.categoryColor(settings.categoryUuid);
    let image = icon;
    if (fills.length > 0) image = makeFilledImage(icon, active ? ENABLED_BG : IDLE_BG, fills);
    else if (active) image = makeActiveImage(icon, color, ENABLED_BG);
    await act.setImage(image).catch(() => {});
  }

  private startTicker(act: any, settings: EchoSettings) {
    if (this.tickers.has(act.id)) return;
    const ticker = setInterval(() => {
      void this.settleImage(act, settings);
      if (!this.isLit(act.id)) this.clearFills(act.id);
    }, TICK_MS);
    ticker.unref();
    this.tickers.set(act.id, ticker);
  }

  private async onLongPress(act: any, settings: EchoSettings) {
    const uuid = settings.categoryUuid;
    const echoPlaying = this.isLit(act.id);
    const ambianceActive = this.isAmbianceActive(uuid);
    this.clearFills(act.id);
    this.stoppedAt.set(act.id, Date.now());
    // What the key should show once the command succeeds; the state broadcast that follows lags by ~250 ms.
    const enabling = !(echoPlaying || ambianceActive);
    let ok = true;
    try {
      if (!enabling) {
        await audioForge.request({ command: "stopEcho", categoryUuid: uuid });
        if (ambianceActive) {
          await audioForge.request({ command: "setCategoryEnabled", section: "Ambiance", categoryUuid: uuid, enabled: false });
        }
      } else {
        await audioForge.request({ command: "setCategoryEnabled", section: "Ambiance", categoryUuid: uuid, enabled: true });
      }
    } catch (e) {
      ok = false;
      streamDeck.logger.warn(`Echo long press failed: ${e instanceof Error ? e.message : e}`);
    }
    await this.settleImage(act, settings, ok ? enabling : ambianceActive);
  }

  /**
   * Show the echoes Audio Forge says are playing, including ones started inside the app, on the keys of
   * their category. Audio Forge pushes the list when an echo starts or stops, so there is no polling; versions
   * that do not push it simply never call this, and keys then only show echoes they started themselves.
   * `onlyKey` limits the update to one key (used when a key appears).
   */
  private async applyEchoes(echoes: ActiveEcho[], onlyKey?: string) {
    const received = Date.now();
    for (const [id, { act, settings }] of this.keys) {
      if (onlyKey && id !== onlyKey) continue;
      if (!act.isKey() || !settings.categoryUuid) continue;
      if (received - (this.stoppedAt.get(id) ?? 0) < STOP_QUIET_MS) continue;
      const wanted = echoes.filter(
        (e) => e.categoryUuid === settings.categoryUuid && !(typeof e.remainingMs === "number" && e.remainingMs <= 0),
      );
      const byEcho = this.fills.get(id) ?? new Map();
      const color = this.categoryColor(settings.categoryUuid) ?? "#ffb300";
      let changed = false;
      for (const e of wanted) {
        if (byEcho.has(e.playbackId)) continue;
        // The message is sent when the echo registers, so its position says how far along it already is.
        byEcho.set(e.playbackId, {
          start: received - (e.positionMs ?? 0),
          duration: Math.max(MIN_FILL_MS, e.durationMs ?? 0),
          color,
        });
        changed = true;
      }
      // Anything missing from the list has stopped, wherever it was stopped.
      const ids = new Set(wanted.map((e) => e.playbackId));
      for (const playbackId of [...byEcho.keys()]) {
        if (!ids.has(playbackId)) {
          byEcho.delete(playbackId);
          changed = true;
        }
      }
      if (byEcho.size > 0) this.fills.set(id, byEcho);
      else this.fills.delete(id);
      if (!changed) continue;
      if (byEcho.size > 0) this.startTicker(act, settings);
      else this.clearFills(id);
      await this.settleImage(act, settings);
    }
  }

  /**
   * Play the echo and fill the key from the left over the echo's length, like Audio Forge's own tile.
   * The reply to playEcho carries durationMs.
   */
  private async playEcho(act: any, settings: EchoSettings) {
    try {
      const reply = await audioForge.request(
        { command: "playEcho", section: "Ambiance", categoryUuid: settings.categoryUuid },
        12_000,
      );
      if (!act.isKey()) return;
      const length = typeof reply.durationMs === "number" ? reply.durationMs : 0;
      // Newer Audio Forge versions also push this echo in an `echoes` message, with the same playbackId.
      const playbackId = typeof reply.playbackId === "string" ? reply.playbackId : `local-${Date.now()}`;
      const byEcho = this.fills.get(act.id) ?? new Map();
      if (!byEcho.has(playbackId)) {
        byEcho.set(playbackId, {
          start: Date.now(),
          duration: Math.max(MIN_FILL_MS, length),
          color: this.categoryColor(settings.categoryUuid) ?? "#ffb300",
        });
      }
      this.fills.set(act.id, byEcho);
      this.startTicker(act, settings);
      await this.settleImage(act, settings);
    } catch (e) {
      streamDeck.logger.warn(`Echo did not start: ${e instanceof Error ? e.message : e}`);
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
    if (this.isLit(act.id)) return; // Keep the fill running while the echo plays.
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
