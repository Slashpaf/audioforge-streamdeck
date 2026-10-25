import streamDeck from "@elgato/streamdeck";
import { iconContrastOverride } from "./color-utils";

/** Amber background shown on all persistently-playing category buttons. */
export const ACTIVE_BG = "#ffb300";

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
): string {
  if (iconDataUrl.startsWith("data:image/svg+xml")) {
    const override = categoryColor
      ? iconContrastOverride(categoryColor, ACTIVE_BG)
      : null;
    return activateSvgIcon(iconDataUrl, ACTIVE_BG, override);
  }

  // PNG / JPEG — outer SVG wrapper
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="144" height="144">` +
    `<rect width="144" height="144" fill="${ACTIVE_BG}"/>` +
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
