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
import { iconContrastOverride } from "../color-utils";
import type { AudioForgeState, CategoryInfo, CategorySettings } from "../types";

@action({ UUID: "com.slashpaf.audioforge.category" })
export class CategoryAction extends SingletonAction<CategorySettings> {
  private _lastLibraryUuid: string | null = null;
  private listener = (state: AudioForgeState) => {
    this.updateAllButtons(state);
    // Push updated categories to open PI when the active library changes
    if (state.libraryUuid && state.libraryUuid !== this._lastLibraryUuid) {
      this._lastLibraryUuid = state.libraryUuid;
      this.pushCategoriesToOpenPI();
    }
  };
  private connListener = (connected: boolean) => {
    this.updateAllButtons(audioForge.state);
    if (connected) this.pushCategoriesToOpenPI();
  };
  private catalogListener = () => {
    this.iconCache.clear();
    this.updateAllButtons(audioForge.state);
    this.pushCategoriesToOpenPI();
  };
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
    this.iconCache.clear();
  }

  override async onWillAppear(ev: WillAppearEvent<CategorySettings>): Promise<void> {
    this.attach();
    const settings = ev.payload.settings;
    if (!settings.section) {
      await ev.action.setSettings({ ...settings, section: "Music" });
    }
    // Always fetch a fresh icon when the button becomes visible (page navigation)
    if (settings.categoryUuid) this.iconCache.delete(settings.categoryUuid);
    await this.updateButton(ev.action, settings, audioForge.state);
  }

  override async onWillDisappear(_ev: WillDisappearEvent<CategorySettings>): Promise<void> {
    let count = 0;
    for (const _ of this.actions) count++;
    if (count === 0) this.detach();
  }

  private _lastSection: string | null = null;

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<CategorySettings>): Promise<void> {
    let settings = ev.payload.settings;
    const resolved = this.resolveCategoryName(settings);
    if (resolved && resolved !== settings.categoryName && resolved !== settings.categoryUuid && resolved !== "Category") {
      settings = { ...settings, categoryName: resolved };
      await ev.action.setSettings(settings);
    }
    await this.updateButton(ev.action, settings, audioForge.state);
    // When section changes (Music <-> Ambiance), push the matching categories
    // to the open PI so the dropdown refreshes immediately.
    const section = settings.section || "Music";
    if (section !== this._lastSection) {
      this._lastSection = section;
      await this.pushCategoriesToOpenPI();
    }
  }

  override async onKeyDown(ev: KeyDownEvent<CategorySettings>): Promise<void> {
    audioForge.launchIfOffline();
    const { section, categoryUuid } = ev.payload.settings;
    if (!categoryUuid) return;
    audioForge.send({
      command: "toggleCategory",
      section: section || "Music",
      categoryUuid,
    });
  }

  /**
   * Handle datasource requests from the property inspector.
   * The PI sends { event: "getCategories", ... } and we respond
   * with the list of categories for the configured section.
   */
  override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, CategorySettings>): Promise<void> {
    const payload = ev.payload as Record<string, JsonValue>;
    if (payload.event !== "getCategories") return;

    const settings = await ev.action.getSettings() as CategorySettings;
    const section = settings.section || "Music";
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
    const cats = section === "Ambiance" ? lib?.ambiance : lib?.music;

    const items = this.selectableCategories(cats).map((c) => ({
      label: c.name,
      value: c.uuid,
    }));
    await streamDeck.ui.sendToPropertyInspector({
      event: "getCategories",
      items: items.length > 0 ? items : [{ label: "No categories found", value: "" }],
    });
  }

  /**
   * Push categories to the currently visible PI (if any).
   * sdpi-components' hot-reload subscription picks up sendToPropertyInspector
   * messages whose payload.event matches the datasource name, so the dropdown
   * updates automatically without needing a page reload.
   */
  private async pushCategoriesToOpenPI(): Promise<void> {
    if (!streamDeck.ui.action) return; // no PI open
    if (streamDeck.ui.action.manifestId !== "com.slashpaf.audioforge.category") return;
    const catalog = audioForge.catalog;
    if (!catalog || !catalog.libraries) return;

    try {
      const settings = await streamDeck.ui.action.getSettings() as CategorySettings;
      const section = settings.section || "Music";
      const activeLibUuid = audioForge.state?.libraryUuid || catalog.activeLibraryUuid;
      const lib = catalog.libraries.find((l) => l.uuid === activeLibUuid) || catalog.libraries[0];
      const cats = section === "Ambiance" ? lib?.ambiance : lib?.music;
      const items = this.selectableCategories(cats).map((c) => ({
        label: c.name,
        value: c.uuid,
      }));
      await streamDeck.ui.sendToPropertyInspector({
        event: "getCategories",
        items: items.length > 0 ? items : [{ label: "No categories found", value: "" }],
      });
    } catch (e) {
      streamDeck.logger.error(`pushCategoriesToOpenPI failed: ${e}`);
    }
  }

  private async updateAllButtons(state: AudioForgeState | null) {
    for (const action of this.actions) {
      const settings = (await action.getSettings()) as CategorySettings;
      await this.updateButton(action, settings, state);
    }
  }

  private selectableCategories(categories: CategoryInfo[] | undefined): CategoryInfo[] {
    return (categories || []).filter(
      (category) =>
        category.enabledInForge !== false &&
        (category.trackCount === undefined || category.trackCount > 0),
    );
  }

  private async updateButton(
    act: any,
    settings: CategorySettings,
    state: AudioForgeState | null,
  ) {
    const name = this.resolveCategoryName(settings) || "Category";
    if (!audioForge.isConnected || !state) {
      await act.setTitle(`${name}\n(offline)`);
      if (act.isKey()) await act.setState(0);
      // Restore persisted icon if available
      if (settings.iconData) await act.setImage(settings.iconData);
      return;
    }
    const section = settings.section || "Music";
    const cats = section === "Music" ? state.musicCategories : state.ambianceCategories;
    const isActive = (cats ?? []).some((c) => c.uuid === settings.categoryUuid);
    if (act.isKey()) await act.setState(isActive ? 1 : 0);
    await act.setTitle(name);

    if (settings.categoryUuid) {
      const iconDataUrl = await this.loadIcon(act, settings, settings.categoryUuid);
      const categoryColor = this.getCategoryColor(settings.categoryUuid);
      const displayImage = iconDataUrl
        ? (isActive ? this.makeActiveImage(iconDataUrl, categoryColor) : iconDataUrl)
        : (settings.iconData || null);
      if (displayImage) await act.setImage(displayImage);
    }
  }

  /**
   * Compose an icon onto a solid #ffb300 amber background.
   *
   * - SVG icons: the amber background rect and optional CSS color override are
   *   injected directly into the decoded SVG source, then re-encoded. This is
   *   reliable because it avoids SVG-in-SVG rendering quirks in Chromium where
   *   filters / styles on <image> elements that reference SVG data-URIs are
   *   silently ignored.
   * - PNG/JPEG icons: wrapped in a simple outer SVG (no filter needed, color
   *   is baked-in and is intentionally left unchanged).
   */
  private makeActiveImage(iconDataUrl: string, categoryColor: string | null): string {
    const ACTIVE_BG = "#ffb300";

    if (iconDataUrl.startsWith("data:image/svg+xml")) {
      const override =
        this.svgColorOverride(iconDataUrl, ACTIVE_BG) ??
        (categoryColor ? iconContrastOverride(categoryColor, ACTIVE_BG) : null);
      return this.activateSvgIcon(iconDataUrl, ACTIVE_BG, override);
    }

    // PNG / JPEG — icon color is baked into pixels. Apply an SVG feColorMatrix
    // filter directly on the <image> element to recolor the glyph when its
    // category color is too close to the amber background.
    // Note: this works for PNG-in-SVG (raster pixels); it is NOT SVG-in-SVG
    // (which has known Chromium filter issues).
    const override = categoryColor ? iconContrastOverride(categoryColor, ACTIVE_BG) : null;

    // feColorMatrix to black:  R=0 G=0 B=0 A=A
    // feColorMatrix to white:  R=1 G=1 B=1 A=A
    const toBlack = `<filter id="f"><feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0"/></filter>`;
    const toWhite = `<filter id="f"><feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 1 0"/></filter>`;

    const filterDef = override === "black" ? toBlack : override === "white" ? toWhite : "";
    const filterRef = override ? ` filter="url(#f)"` : "";

    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="144" height="144">` +
      (filterDef ? `<defs>${filterDef}</defs>` : "") +
      `<rect width="144" height="144" fill="${ACTIVE_BG}"/>` +
      `<image href="${iconDataUrl}" width="144" height="144"${filterRef}/>` +
      `</svg>`;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  }

  /**
   * Decode an SVG data URL and scan every hex fill value inside it.
   * Returns the contrast override color if any fill is perceptually too
   * close to bgHex, or null if all fills already have sufficient contrast.
   */
  private svgColorOverride(svgDataUrl: string, bgHex: string): "black" | "white" | null {
    try {
      const base64 = svgDataUrl.split(",")[1];
      if (!base64) { streamDeck.logger.info(`[svgOverride] no base64`); return null; }
      const svg = Buffer.from(base64, "base64").toString("utf8");

      const fills = new Set<string>();
      for (const m of svg.matchAll(/\bfill="(#[0-9a-fA-F]{3,8})"/g)) fills.add(m[1]);
      for (const m of svg.matchAll(/\bfill='(#[0-9a-fA-F]{3,8})'/g))  fills.add(m[1]);
      for (const m of svg.matchAll(/\bfill\s*:\s*(#[0-9a-fA-F]{3,8})/g)) fills.add(m[1]);

      streamDeck.logger.info(`[svgOverride] found fills: ${[...fills].join(', ') || '(none)'}`);

      for (const hex of fills) {
        const override = iconContrastOverride(hex, bgHex);
        streamDeck.logger.info(`[svgOverride] ${hex} vs ${bgHex} => ${override}`);
        if (override !== null) return override;
      }
    } catch (e) { streamDeck.logger.info(`[svgOverride] error: ${e}`); }
    return null;
  }

  /**
   * Decode an SVG data URL and inject:
   *   1. A full-bleed background rect (drawn first so the icon renders on top).
   *   2. An optional <style> block that recolors the icon glyphs to black/white
   *      when the category color clashes with the background.
   *
   * Both are inserted as the first children of the root <svg> element so they
   * respect the SVG's own viewBox and coordinate system.
   */
  private activateSvgIcon(
    svgDataUrl: string,
    bgColor: string,
    colorOverride: "black" | "white" | null,
  ): string {
    try {
      const base64 = svgDataUrl.split(",")[1];
      if (!base64) throw new Error("missing base64 payload");

      let svg = Buffer.from(base64, "base64").toString("utf8");

      // Recolor icon fills BEFORE injecting the background so the background
      // rect's own fill attribute is never touched by the recolor pass.
      // CSS <style> injection is NOT used because Stream Deck's SVG rasterizer
      // processes presentation attributes but ignores <style> blocks entirely.
      if (colorOverride) {
        svg = this.recolorSvgFills(svg, colorOverride);
      }

      // Inject the amber background rect as the first child of <svg>.
      // Drawn first so the (recolored) icon renders on top.
      const bgRect = `<rect x="-9999" y="-9999" width="19998" height="19998" fill="${bgColor}"/>`;
      svg = svg.replace(/(<svg\b[^>]*>)/i, `$1${bgRect}`);

      return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
    } catch (e) {
      streamDeck.logger.error(`activateSvgIcon failed: ${e}`);
      const fallback =
        `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="144" height="144">` +
        `<rect width="144" height="144" fill="${bgColor}"/>` +
        `<image href="${svgDataUrl}" width="144" height="144"/>` +
        `</svg>`;
      return `data:image/svg+xml;base64,${Buffer.from(fallback).toString("base64")}`;
    }
  }

  /**
   * Directly rewrite every fill value in an SVG string to `color`, preserving
   * "none" and "transparent" (hollow / cutout areas).
   *
   * Handles:
   *  - presentation attributes  fill="#f90"  fill='rgb(...)'
   *  - inline style attributes  style="fill:#f90;stroke:..."
   *  - missing root fill        adds fill="color" to <svg> so that elements
   *                             relying on inheritance / currentColor are covered
   */
  private recolorSvgFills(svg: string, color: string): string {
    const before = svg;
    // Presentation attributes (double and single quotes)
    svg = svg.replace(/\bfill="(?!none\b|transparent\b)[^"]*"/gi, `fill="${color}"`);
    svg = svg.replace(/\bfill='(?!none\b|transparent\b)[^']*'/gi,  `fill='${color}'`);

    // fill inside style="..." inline attributes
    svg = svg.replace(
      /(style="[^"]*?)\bfill\s*:\s*(?!none[;"\s]|transparent[;"\s])[^;"]+/gi,
      `$1fill:${color}`,
    );
    svg = svg.replace(
      /(style='[^']*?)\bfill\s*:\s*(?!none[;'\s]|transparent[;'\s])[^;']+/gi,
      `$1fill:${color}`,
    );

    // If the root <svg> element carries no fill at all, add one so elements
    // that rely on inherited / currentColor fill also get recolored.
    if (!/<svg\b[^>]*\bfill=/i.test(svg)) {
      svg = svg.replace(/(<svg\b)/i, `$1 fill="${color}"`);
    }

    streamDeck.logger.info(`[recolor] changed=${before !== svg} color=${color}`);
    return svg;
  }

  /** Look up a category's hex color string from the current catalog. */
  private getCategoryColor(uuid: string): string | null {
    const catalog = audioForge.catalog;
    if (!catalog?.libraries) return null;
    for (const lib of catalog.libraries) {
      for (const cat of [...(lib.music ?? []), ...(lib.ambiance ?? [])]) {
        if (cat.uuid === uuid) return cat.color ?? null;
      }
    }
    return null;
  }

  /** Look up category name from catalog when PI only saved the uuid. */
  private resolveCategoryName(settings: CategorySettings): string {
    if (settings.categoryUuid) {
      const catalog = audioForge.catalog;
      if (catalog?.libraries) {
        for (const lib of catalog.libraries) {
          const found = [...(lib.music || []), ...(lib.ambiance || [])].find((c) => c.uuid === settings.categoryUuid);
          if (found) return found.name;
        }
      }
    }
    return settings.categoryName || "";
  }

  private iconCache = new Map<string, string>();

  /**
   * Fetch (or return from cache) the icon for a category UUID.
   * Persists the data URL into the action's settings for offline fallback.
   * Returns the data URL string, or null on failure.
   */
  private async loadIcon(act: any, settings: CategorySettings, uuid: string): Promise<string | null> {
    let dataUrl = this.iconCache.get(uuid);
    if (dataUrl) {
      if (settings.iconData !== dataUrl) {
        await act.setSettings({ ...settings, iconData: dataUrl });
      }
      return dataUrl;
    }

    try {
      const url = `${audioForge.httpBaseUrl}/api/icon/${uuid}?size=144${audioForge.httpAuthQuery}`;
      const resp = await fetch(url);
      if (!resp.ok) return null;

      const contentType = resp.headers.get("content-type") || "image/png";
      const buffer = await resp.arrayBuffer();
      const base64 = Buffer.from(buffer).toString("base64");
      dataUrl = `data:${contentType};base64,${base64}`;

      this.iconCache.set(uuid, dataUrl);
      if (settings.iconData !== dataUrl) {
        await act.setSettings({ ...settings, iconData: dataUrl });
      }
      return dataUrl;
    } catch (e) {
      streamDeck.logger.error(`Icon fetch failed for ${uuid}: ${e}`);
      return null;
    }
  }
}
