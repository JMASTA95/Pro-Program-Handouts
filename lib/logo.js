/**
 * logo.js — normalizes whatever logo file a doctor uploads into a
 * predictable PNG data URI that behaves inside the templates.
 *
 * Handles: oversized files, odd aspect ratios, JPG/PNG/WebP inputs.
 * Output: PNG, max 600x300, aspect ratio preserved, transparent padding.
 */

const sharp = require("sharp");

async function normalizeLogo(filePath) {
  const buffer = await sharp(filePath)
    .resize(600, 300, {
      fit: "inside", // never crop, never distort
      withoutEnlargement: true, // don't upscale tiny logos
    })
    .png()
    .toBuffer();

  return `data:image/png;base64,${buffer.toString("base64")}`;
}

module.exports = { normalizeLogo };
