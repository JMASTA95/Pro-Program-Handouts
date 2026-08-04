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

const MODULES = path.join(__dirname, "..", "node_modules", "@fontsource");
const WEIGHTS = [400, 500, 600, 700];

// Greek and Greek Extended. Figtree ships only latin and latin-ext, so the
// clinical marker names — TGF-β1, TNF-α, NF-κB — had no glyph and fell through
// to whatever the host machine happened to have: Helvetica Neue on macOS,
// Liberation Sans in the Railway container. Same code, different printed page.
// Inter covers Greek and is close enough in weight and width to sit inside a
// word without reading as a substitution.
const GREEK_RANGE = "U+0370-03FF, U+1F00-1FFF";

let cached = null;

function readFontFile(family, subset, weight) {
  const file = path.join(MODULES, family, "files", `${family}-${subset}-${weight}-normal.woff2`);
  if (!fs.existsSync(file)) {
    // Better a readable failure at startup than a silent font substitution
    // discovered on a printed handout.
    throw new Error(
      `${family} ${subset} ${weight} is missing at ${file}. Run npm install — the ` +
        `font is embedded in the PDF, so the render cannot proceed without it.`
    );
  }
  return fs.readFileSync(file).toString("base64");
}

/**
 * @returns {string} @font-face rules with the woff2 payloads inlined.
 */
function fontFaceCss() {
  if (cached) return cached;

  const faces = [];
  for (const weight of WEIGHTS) {
    faces.push(
      `@font-face{font-family:'Figtree';font-style:normal;font-weight:${weight};` +
        `font-display:block;src:url(data:font/woff2;base64,${readFontFile("figtree", "latin", weight)}) format('woff2');}`
    );
    // Declared under the same family name and restricted by unicode-range, so
    // Greek characters resolve here and everything else still comes from
    // Figtree. Nothing in the templates or CSS has to know.
    faces.push(
      `@font-face{font-family:'Figtree';font-style:normal;font-weight:${weight};` +
        `font-display:block;unicode-range:${GREEK_RANGE};` +
        `src:url(data:font/woff2;base64,${readFontFile("inter", "greek", weight)}) format('woff2');}`
    );
  }

  cached = faces.join("\n");
  return cached;
}

module.exports = { fontFaceCss };
