/**
 * Perceptual color utilities — a direct port of AudioForge's ColorUtils.dart.
 *
 * Uses CIE L*a*b* color space with CIE76 ΔE (Euclidean distance in Lab),
 * which is what the Dart implementation calls "deltaE2000" despite being the
 * simpler CIE76 formula.
 */

type Lab = [number, number, number];

/** Parse a hex color string (#rrggbb) into [r, g, b] in 0-255 range. */
export function hexToRgb(hex: string): [number, number, number] {
  const c = hex.replace("#", "");
  if (c.length === 3 || c.length === 4) {
    // Short form #rgb / #rgba → expand each nibble
    return [
      parseInt(c[0] + c[0], 16),
      parseInt(c[1] + c[1], 16),
      parseInt(c[2] + c[2], 16),
    ];
  }
  return [
    parseInt(c.substring(0, 2), 16),
    parseInt(c.substring(2, 4), 16),
    parseInt(c.substring(4, 6), 16),
  ];
}

/** Convert RGB (0-255) to CIE L*a*b*. Mirrors ColorUtils.rgbToLab(). */
export function rgbToLab(r: number, g: number, b: number): Lab {
  let rr = r / 255;
  let gg = g / 255;
  let bb = b / 255;

  rr = rr > 0.04045 ? Math.pow((rr + 0.055) / 1.055, 2.4) : rr / 12.92;
  gg = gg > 0.04045 ? Math.pow((gg + 0.055) / 1.055, 2.4) : gg / 12.92;
  bb = bb > 0.04045 ? Math.pow((bb + 0.055) / 1.055, 2.4) : bb / 12.92;

  let x = rr * 0.4124 + gg * 0.3576 + bb * 0.1805;
  let y = rr * 0.2126 + gg * 0.7152 + bb * 0.0722;
  let z = rr * 0.0193 + gg * 0.1192 + bb * 0.9505;

  x /= 95.047;
  y /= 100.0;
  z /= 108.883;

  x = x > 0.008856 ? Math.cbrt(x) : 7.787 * x + 16 / 116;
  y = y > 0.008856 ? Math.cbrt(y) : 7.787 * y + 16 / 116;
  z = z > 0.008856 ? Math.cbrt(z) : 7.787 * z + 16 / 116;

  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** CIE76 ΔE — Euclidean distance in L*a*b*. Mirrors ColorUtils.deltaE2000(). */
export function deltaE(lab1: Lab, lab2: Lab): number {
  return Math.sqrt(
    Math.pow(lab1[0] - lab2[0], 2) +
      Math.pow(lab1[1] - lab2[1], 2) +
      Math.pow(lab1[2] - lab2[2], 2),
  );
}

/**
 * Given a background hex color, returns which of black or white gives better
 * perceptual contrast. Mirrors ColorUtils.getContrastingColor().
 */
export function getContrastingColor(bgHex: string): "black" | "white" {
  const bgLab = rgbToLab(...hexToRgb(bgHex));
  const deltaDark = deltaE(bgLab, rgbToLab(0, 0, 0));
  const deltaLight = deltaE(bgLab, rgbToLab(255, 255, 255));
  // If the background is perceptually farther from black → it is light → use black text.
  return deltaDark > deltaLight ? "black" : "white";
}

/**
 * Returns the contrasting color to apply to an icon rendered on top of bgHex,
 * or null if the icon color already has sufficient contrast on its own.
 *
 * An override is needed when the icon color is perceptually closer to the
 * background than it is to the ideal contrast color (black or white).
 *
 * Only intended for SVG icons — PNG icons have their color baked in and
 * cannot be recolored without a canvas operation.
 */
export function iconContrastOverride(
  iconColorHex: string,
  bgHex: string,
): "black" | "white" | null {
  const iconLab = rgbToLab(...hexToRgb(iconColorHex));
  const bgLab = rgbToLab(...hexToRgb(bgHex));
  const contrastColor = getContrastingColor(bgHex);
  const contrastLab =
    contrastColor === "black"
      ? rgbToLab(0, 0, 0)
      : rgbToLab(255, 255, 255);

  const distToBackground = deltaE(iconLab, bgLab);
  const distToContrast = deltaE(iconLab, contrastLab);

  // Override only when the icon is visually closer to the background
  // than to the ideal contrast color.
  return distToBackground < distToContrast ? contrastColor : null;
}
