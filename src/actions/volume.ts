import streamDeck, {
  action,
  DialRotateEvent,
  DialDownEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  SendToPluginEvent,
  SingletonAction,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { audioForge } from "../audioforge-client";
import type { AudioForgeState, CategoryInfo, VolumeSettings } from "../types";

// Datasource value for "no specific category" (controls the whole section).
const WHOLE_SECTION = "__section__";

interface VolumeTarget {
  section: string;
  categoryUuid?: string;
  categoryName?: string;
  // Key for the local dial bookkeeping maps.
  key: string;
  label: string;
}

// Shared logic for both Volume (Key) and Volume (Dial) actions.
// Subclasses below carry only the @action decorator with their UUID.
class VolumeBase extends SingletonAction<VolumeSettings> {
  private listener = (state: AudioForgeState) => this.updateAllButtons(state);
  // Only re-render on disconnect (to show offline). On connect, the incoming
  // state message triggers the listener below, which avoids a race between
  // updateAllButtons(null) and updateAllButtons(state).
  private connListener = (connected: boolean) => {
    if (!connected) this.updateAllButtons(audioForge.state);
  };
  private attached = false;

  // Local volume target per section (or per category) (display scale 0-1 = 0-100%).
  // Updated immediately on every dial tick so rapid rotations accumulate
  // correctly without waiting for the remote state round-trip.
  private localVol: Record<string, number> = {};
  private lastDialMs: Record<string, number> = {};
  private readonly DIAL_IDLE_MS = 1500;
  private preMuteVolume: Record<string, number> = {};

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

  override async onWillAppear(ev: WillAppearEvent<VolumeSettings>): Promise<void> {
    this.attach();
    const settings = ev.payload.settings;
    if (!settings.section) {
      await ev.action.setSettings({ section: "Music", value: 100, step: 5 });
    }
    await this.updateButton(ev.action, settings, audioForge.state);
  }

  override async onWillDisappear(_ev: WillDisappearEvent<VolumeSettings>): Promise<void> {
    let count = 0;
    for (const _ of this.actions) count++;
    if (count === 0) this.detach();
  }

  // Resolves what a button controls: one category (Music/Ambiance only) or the whole section.
  private target(settings: VolumeSettings): VolumeTarget {
    const section = settings.section || "Music";
    const uuid = settings.categoryUuid;
    if (section !== "Echoes" && uuid && uuid !== WHOLE_SECTION) {
      const name = this.findCategory(section, uuid)?.name || settings.categoryName || section;
      return { section, categoryUuid: uuid, categoryName: name, key: `${section}:${uuid}`, label: name };
    }
    return { section, key: section, label: section };
  }

  private sectionCategories(section: string): CategoryInfo[] {
    const catalog = audioForge.catalog;
    if (!catalog?.libraries) return [];
    const activeLibUuid = audioForge.state?.libraryUuid || catalog.activeLibraryUuid;
    const lib = catalog.libraries.find((l) => l.uuid === activeLibUuid) || catalog.libraries[0];
    return (section === "Ambiance" ? lib?.ambiance : lib?.music) || [];
  }

  private findCategory(section: string, uuid: string): CategoryInfo | undefined {
    return this.sectionCategories(section).find((c) => c.uuid === uuid);
  }

  private volumeCommand(t: VolumeTarget, value: number) {
    return {
      command: "setVolume",
      section: t.section,
      value,
      ...(t.categoryUuid ? { categoryUuid: t.categoryUuid } : {}),
    };
  }

  // Returns volume from remote state as a display value in [0, 1].
  private remoteToDisplay(t: VolumeTarget, state: AudioForgeState | null): number {
    const section = t.section;
    if (t.categoryUuid) return state?.categoryVolume?.[t.categoryUuid] ?? 0.5;
    if (!state) return section === "Echoes" ? 1 : 0.5;
    if (section === "Music") return state.musicVolume ?? 0.5;
    if (section === "Ambiance") return state.ambianceVolume ?? 0.5;
    if (section === "Echoes") return state.echoesVolume ?? 1;
    return 0.5;
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<VolumeSettings>): Promise<void> {
    let settings = ev.payload.settings;
    const section = settings.section || "Music";
    const uuid = settings.categoryUuid;
    const hasCatalog = this.sectionCategories(section).length > 0;
    if (uuid && uuid !== WHOLE_SECTION) {
      const cat = this.findCategory(section, uuid);
      if (section === "Echoes" || (hasCatalog && !cat)) {
        // Section changed to one that does not contain this category.
        settings = { ...settings, categoryUuid: WHOLE_SECTION, categoryName: "" };
        await ev.action.setSettings(settings);
      } else if (cat && cat.name !== settings.categoryName) {
        settings = { ...settings, categoryName: cat.name };
        await ev.action.setSettings(settings);
      }
    }
    await this.updateButton(ev.action, settings, audioForge.state);
    if (section !== this.lastSection) {
      this.lastSection = section;
      await this.pushCategoriesToOpenPI();
    }
  }

  private lastSection: string | null = null;

  // The PI asks for the category list of the configured section.
  override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, VolumeSettings>): Promise<void> {
    const payload = ev.payload as Record<string, JsonValue>;
    if (payload.event !== "getCategories") return;
    const settings = (await ev.action.getSettings()) as VolumeSettings;
    await this.sendCategories(settings.section || "Music");
  }

  private async pushCategoriesToOpenPI(): Promise<void> {
    const id = streamDeck.ui.action?.manifestId;
    if (id !== "com.slashpaf.audioforge.volume-key" && id !== "com.slashpaf.audioforge.volume-dial") return;
    try {
      const settings = (await streamDeck.ui.action!.getSettings()) as VolumeSettings;
      await this.sendCategories(settings.section || "Music");
    } catch (e) {
      streamDeck.logger.error(`pushCategoriesToOpenPI failed: ${e}`);
    }
  }

  private async sendCategories(section: string): Promise<void> {
    const items = [{ label: "Whole section", value: WHOLE_SECTION }];
    if (section !== "Echoes") {
      for (const c of this.sectionCategories(section)) {
        if (c.enabledInForge === false) continue;
        if (c.trackCount !== undefined && c.trackCount <= 0) continue;
        items.push({ label: c.name, value: c.uuid });
      }
    }
    await streamDeck.ui.sendToPropertyInspector({ event: "getCategories", items });
  }

  // Keypad: jump to preset value (0-100 display).
  override async onKeyDown(ev: KeyDownEvent<VolumeSettings>): Promise<void> {
    audioForge.launchIfOffline();
    const t = this.target(ev.payload.settings);
    const displayVal = (ev.payload.settings.value ?? 100) / 100;
    this.localVol[t.key] = displayVal;
    audioForge.send(this.volumeCommand(t, displayVal));
  }

  // Dial rotate: adjust volume
  override async onDialRotate(ev: DialRotateEvent<VolumeSettings>): Promise<void> {
    audioForge.launchIfOffline();
    const t = this.target(ev.payload.settings);
    const step = (ev.payload.settings.step || 5) / 100;
    const now = Date.now();

    const idle = now - (this.lastDialMs[t.key] ?? 0) > this.DIAL_IDLE_MS;
    if (idle || this.localVol[t.key] === undefined) {
      this.localVol[t.key] = this.remoteToDisplay(t, audioForge.state);
    }

    const newVal = Math.max(0, Math.min(1, this.localVol[t.key] + step * ev.payload.ticks));
    this.localVol[t.key] = newVal;
    this.lastDialMs[t.key] = now;

    await this.setDialFeedback(ev.action, newVal);
    audioForge.send(this.volumeCommand(t, Math.round(newVal * 100) / 100));
  }

  // Dial press: mute / unmute
  override async onDialDown(ev: DialDownEvent<VolumeSettings>): Promise<void> {
    audioForge.launchIfOffline();
    const t = this.target(ev.payload.settings);
    const idle = Date.now() - (this.lastDialMs[t.key] ?? 0) > this.DIAL_IDLE_MS;
    const current = (!idle && this.localVol[t.key] !== undefined)
      ? this.localVol[t.key]
      : this.remoteToDisplay(t, audioForge.state);

    if (current > 0) {
      this.preMuteVolume[t.key] = current;
      this.localVol[t.key] = 0;
      audioForge.send(this.volumeCommand(t, 0));
    } else {
      const restore = this.preMuteVolume[t.key] ?? 0.5;
      this.localVol[t.key] = restore;
      audioForge.send(this.volumeCommand(t, restore));
    }
    this.lastDialMs[t.key] = Date.now();
  }

  private async updateAllButtons(state: AudioForgeState | null) {
    for (const act of this.actions) {
      const settings = (await act.getSettings()) as VolumeSettings;
      await this.updateButton(act, settings, state);
    }
  }

  private async updateButton(act: any, settings: VolumeSettings, state: AudioForgeState | null) {
    const t = this.target(settings);
    if (!state || !audioForge.isConnected) {
      await act.setTitle(`${t.label}\n(offline)`);
      if (act.isDial?.()) {
        await act.setFeedback({ title: `${t.label} (offline)`, value: "--", indicator: { value: 0 } });
      }
      return;
    }

    const remoteDisplay = this.remoteToDisplay(t, state);

    const idle = Date.now() - (this.lastDialMs[t.key] ?? 0) > this.DIAL_IDLE_MS;
    const vol = (!idle && this.localVol[t.key] !== undefined)
      ? this.localVol[t.key]
      : remoteDisplay;

    if (idle) this.localVol[t.key] = remoteDisplay;

    const pct = Math.round(vol * 100);
    await act.setTitle(`${t.label}\n${pct}%`);
    if (act.isDial?.()) {
      await act.setFeedback({ title: t.label, value: pct, indicator: { value: pct } });
    }
  }

  private async setDialFeedback(act: any, vol: number) {
    const pct = Math.round(vol * 100);
    if (act.isDial?.()) {
      await act.setFeedback({ value: pct, indicator: { value: pct } });
    }
  }
}

@action({ UUID: "com.slashpaf.audioforge.volume-key" })
export class VolumeKeyAction extends VolumeBase {}

@action({ UUID: "com.slashpaf.audioforge.volume-dial" })
export class VolumeDialAction extends VolumeBase {}
