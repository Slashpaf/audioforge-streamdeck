import streamDeck from "@elgato/streamdeck";
import { hexToRgb, iconContrastOverride } from "./color-utils";

/** Amber background shown on all persistently-playing category buttons. */
export const ACTIVE_BG = "#ffb300";

/** Darker amber that Audio Forge uses for an echo category that is enabled as a background ambiance. */
export const ENABLED_BG = "#71520b";

/**
 * Compose an icon onto the amber active background.
 *
 * - SVG icons: background rect + optional glyph color override are injected
 *   directly into the decoded SVG source to avoid SVG-in-SVG rendering issues.
 * - PNG/JPEG: wrapped in a plain outer SVG with an amber rect behind the image.
 */
export function makeActiveImage(
  iconDataUrl: string,
  categoryColor: string | null,
  background: string = ACTIVE_BG,
): string {
  if (iconDataUrl.startsWith("data:image/svg+xml")) {
    const override = categoryColor
      ? iconContrastOverride(categoryColor, background)
      : null;
    return activateSvgIcon(iconDataUrl, background, override);
  }

  // PNG / JPEG — outer SVG wrapper
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="144" height="144">` +
    `<rect width="144" height="144" fill="${background}"/>` +
    `<image href="${iconDataUrl}" width="144" height="144"/>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/**
 * Decode an SVG data URL and inject:
 *   1. A full-bleed background rect (drawn first, icon renders on top).
 *   2. An optional <style> block recoloring icon glyphs for contrast.
 *
 * Both are inserted as the first children of the root <svg> element so they
 * respect the SVG's own viewBox and coordinate system.
 */
/**
 * Directly rewrite every fill value in an SVG string to `color`, preserving
 * "none" and "transparent" (hollow / cutout areas).
 *
 * CSS <style> injection is NOT used because Stream Deck's SVG rasterizer
 * processes presentation attributes but ignores <style> blocks entirely.
 */
export function recolorSvgFills(svg: string, color: string): string {
  // Presentation attributes
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

  // Add fill to root <svg> if absent (covers inherited / currentColor fills)
  if (!/<svg\b[^>]*\bfill=/i.test(svg)) {
    svg = svg.replace(/(<svg\b)/i, `$1 fill="${color}"`);
  }

  return svg;
}

function activateSvgIcon(
  svgDataUrl: string,
  bgColor: string,
  colorOverride: "black" | "white" | null,
): string {
  try {
    const base64 = svgDataUrl.split(",")[1];
    if (!base64) throw new Error("missing base64 payload");

    let svg = Buffer.from(base64, "base64").toString("utf8");

    if (colorOverride) {
      svg = recolorSvgFills(svg, colorOverride);
    }

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

/** A translucent bar that grows from the left of the key as an echo plays. */
export interface KeyFill {
  /** 0 to 1: where the bar's right edge is */
  progress: number;
  /** 0 to 1: where its left edge is. The bar is wiped out from the left once the echo has played (0 while it fills). */
  from?: number;
  /** Category color, as #rrggbb. */
  color: string;
}

/**
 * Compose a key like an echo tile in Audio Forge: a background, one bar per running echo in the
 * category's color (50% blended into the background) growing from the left, and the icon on top.
 */
export function makeFilledImage(iconDataUrl: string, background: string, fills: KeyFill[]): string {
  const clamp = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
  // Audio Forge paints each bar at 50% opacity over whatever is below it, so overlapping echoes get
  // brighter where they stack. The key background is solid, so the stacking is computed here and the
  // result drawn as opaque rects; Stream Deck's SVG renderer is not guaranteed to honor fill-opacity.
  type Rgb = [number, number, number];
  const parse = (color: string, fallback: Rgb): Rgb => {
    const rgb = hexToRgb(color);
    return rgb.every(Number.isFinite) ? rgb : fallback;
  };
  const hex = (rgb: Rgb) => `#${rgb.map((n) => Math.round(n).toString(16).padStart(2, "0")).join("")}`;
  const bars = (x: number, y: number, w: number, h: number) => {
    const base = parse(background, [0, 0, 0]);
    const layers = fills
      .map((f) => ({ lo: clamp(f.from ?? 0), hi: clamp(f.progress), rgb: parse(f.color, [255, 179, 0]) }))
      .filter((l) => l.hi > l.lo);
    // Between two neighbouring edges, the layers covering that stretch are the ones that span all of it.
    const cuts = [...new Set(layers.flatMap((l) => [l.lo, l.hi]))].sort((a, b) => a - b);
    let rects = "";
    for (let i = 1; i < cuts.length; i++) {
      const from = cuts[i - 1];
      const cut = cuts[i];
      const covering = layers.filter((l) => l.lo <= from && l.hi >= cut);
      if (covering.length === 0) continue;
      let rgb: Rgb = base;
      for (const layer of covering) rgb = rgb.map((v, k) => (v + layer.rgb[k]) / 2) as Rgb;
      rects += `<rect x="${(x + from * w).toFixed(2)}" y="${y}" width="${((cut - from) * w).toFixed(2)}" height="${h}" fill="${hex(rgb)}"/>`;
    }
    return rects;
  };

  if (iconDataUrl.startsWith("data:image/svg+xml")) {
    try {
      const base64 = iconDataUrl.split(",")[1];
      if (!base64) throw new Error("missing base64 payload");
      let svg = Buffer.from(base64, "base64").toString("utf8");
      const root = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? "";
      const vb = /viewBox="([^"]+)"/i.exec(root)?.[1]?.trim().split(/[\s,]+/).map(Number);
      const [vx, vy, vw, vh] = vb && vb.length === 4 && vb.every(Number.isFinite) ? vb : [0, 0, 144, 144];
      const underlay =
        `<rect x="-9999" y="-9999" width="19998" height="19998" fill="${background}"/>` + bars(vx, vy, vw, vh);
      svg = svg.replace(/(<svg\b[^>]*>)/i, `$1${underlay}`);
      return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
    } catch (e) {
      streamDeck.logger.error(`makeFilledImage failed for an SVG icon: ${e}`);
    }
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="144" height="144">` +
    `<rect width="144" height="144" fill="${background}"/>` +
    bars(0, 0, 144, 144) +
    `<image href="${iconDataUrl}" width="144" height="144"/>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}
