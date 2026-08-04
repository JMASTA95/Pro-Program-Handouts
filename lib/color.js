/**
 * color.js — derives a small palette from the doctor's single brand hex.
 *
 * The templates need more than one color: a very light fill for the card
 * grids and a soft hairline for rules and borders. Rather than ask the
 * doctor for three colors, we mix their brand color with white.
 *
 * Done in JS rather than CSS color-mix() so output is identical
 * regardless of the Chromium version on the render host.
 */

function parseHex(hex) {
  let h = String(hex || "").trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function toHex([r, g, b]) {
  return (
    "#" +
    [r, g, b]
      .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0"))
      .join("")
  );
}

/** Mixes a color with white. ratio 0 = white, 1 = the color itself. */
function mixWithWhite(rgb, ratio) {
  return toHex(rgb.map((v) => 255 + (v - 255) * ratio));
}

/**
 * @param {string} brandHex e.g. "#16457e"
 * @returns {{brand:string, tint:string, line:string}}
 */
function derivePalette(brandHex) {
  const rgb = parseHex(brandHex) || parseHex("#16457e");
  return {
    brand: toHex(rgb),
    tint: mixWithWhite(rgb, 0.06), // card fills
    line: mixWithWhite(rgb, 0.22), // hairlines and borders
  };
}

module.exports = { derivePalette };
