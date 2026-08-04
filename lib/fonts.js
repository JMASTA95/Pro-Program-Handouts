/**
 * fonts.js — inlines Figtree into the handout CSS as base64 @font-face rules.
 *
 * Templates are rendered with page.setContent(), so the document has no origin
 * and a relative font URL cannot resolve. _base.css previously pulled Figtree
 * from Google Fonts over the network, which meant a slow or blocked fetch
 * silently produced a PDF in the fallback stack — different from the proof the
 * doctor approved, with nothing in the logs to say so.
 *
 * Embedding removes the network from the render path entirely. Print output has
 * to be byte-reproducible; a webfont request is the one thing in here that could
 * fail without failing loudly.
 */

const fs = require("fs");
const path = require("path");

const FILES = path.join(__dirname, "..", "node_modules", "@fontsource", "figtree", "files");
const WEIGHTS = [400, 500, 600, 700];

let cached = null;

/**
 * @returns {string} @font-face rules with the woff2 payloads inlined.
 */
function fontFaceCss() {
  if (cached) return cached;

  const faces = [];
  for (const weight of WEIGHTS) {
    const file = path.join(FILES, `figtree-latin-${weight}-normal.woff2`);
    if (!fs.existsSync(file)) {
      // Better a readable failure at startup than a silent font substitution
      // discovered on a printed handout.
      throw new Error(
        `Figtree ${weight} is missing at ${file}. Run npm install — the font is ` +
          `embedded in the PDF, so the render cannot proceed without it.`
      );
    }
    const b64 = fs.readFileSync(file).toString("base64");
    faces.push(
      `@font-face{font-family:'Figtree';font-style:normal;font-weight:${weight};` +
        `font-display:block;src:url(data:font/woff2;base64,${b64}) format('woff2');}`
    );
  }

  cached = faces.join("\n");
  return cached;
}

module.exports = { fontFaceCss };
