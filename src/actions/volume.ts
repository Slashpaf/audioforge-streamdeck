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

// Step sizes (%) offered in the Property Inspector.
const STEP_OPTIONS = [1, 2, 5, 10, 25];

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
    let settings = ev.payload.settings;
    if (!settings.section) {
      await ev.action.setSettings({ section: "Music", value: 100, step: 5 });
    } else if (settings.step !== undefined && !STEP_OPTIONS.includes(Number(settings.step))) {
      // Older dials could store any 1-20; snap to the nearest option the dropdown offers.
      const old = Number(settings.step) || 5;
      const step = STEP_OPTIONS.reduce((a, b) => (Math.abs(b - old) < Math.abs(a - old) ? b : a));
      settings = { ...settings, step };
      await ev.action.setSettings(settings);
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

  // Current volume as the user last saw it: local value while recently touched, else remote.
  private currentVolume(t: VolumeTarget): number {
    const idle = Date.now() - (this.lastDialMs[t.key] ?? 0) > this.DIAL_IDLE_MS;
    return (!idle && this.localVol[t.key] !== undefined)
      ? this.localVol[t.key]
      : this.remoteToDisplay(t, audioForge.state);
  }

  // Applies a volume change and remembers it locally so rapid presses accumulate.
  private applyVolume(t: VolumeTarget, vol: number) {
    this.localVol[t.key] = vol;
    this.lastDialMs[t.key] = Date.now();
    audioForge.send(this.volumeCommand(t, Math.round(vol * 100) / 100));
  }

  // Mute if audible, otherwise restore the volume from before the mute.
  private toggleMute(t: VolumeTarget) {
    const current = this.currentVolume(t);
    if (current > 0) {
      this.preMuteVolume[t.key] = current;
      this.applyVolume(t, 0);
    } else {
      this.applyVolume(t, this.preMuteVolume[t.key] ?? 0.5);
    }
  }

  private stepOf(settings: VolumeSettings): number {
    return (Number(settings.step) || 5) / 100;
  }

  // Keypad: depends on the key mode (preset by default).
  override async onKeyDown(ev: KeyDownEvent<VolumeSettings>): Promise<void> {
    audioForge.launchIfOffline();
    const settings = ev.payload.settings;
    const t = this.target(settings);
    switch (settings.keyMode) {
      case "up":
      case "down": {
        const delta = (settings.keyMode === "up" ? 1 : -1) * this.stepOf(settings);
        const newVal = Math.max(0, Math.min(1, this.currentVolume(t) + delta));
        this.applyVolume(t, newVal);
        await this.updateButton(ev.action, settings, audioForge.state);
        break;
      }
      case "mute":
        this.toggleMute(t);
        await this.updateButton(ev.action, settings, audioForge.state);
        break;
      default:
        this.applyVolume(t, (Number(settings.value ?? 100)) / 100);
    }
  }

  // Dial rotate: adjust volume
  override async onDialRotate(ev: DialRotateEvent<VolumeSettings>): Promise<void> {
    audioForge.launchIfOffline();
    const t = this.target(ev.payload.settings);
    const step = this.stepOf(ev.payload.settings);
    const newVal = Math.max(0, Math.min(1, this.currentVolume(t) + step * ev.payload.ticks));
    this.applyVolume(t, newVal);
    await this.setDialFeedback(ev.action, newVal);
  }

  // Dial press: mute / unmute
  override async onDialDown(ev: DialDownEvent<VolumeSettings>): Promise<void> {
    audioForge.launchIfOffline();
    this.toggleMute(this.target(ev.payload.settings));
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
    const mode = act.isDial?.() ? undefined : settings.keyMode;
    const prefix = mode === "up" ? "▲ " : mode === "down" ? "▼ " : "";
    await act.setTitle(mode === "mute" && pct === 0 ? `${t.label}\nMuted` : `${t.label}\n${prefix}${pct}%`);
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
