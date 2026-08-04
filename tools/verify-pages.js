/**
 * verify-pages.js — checks that every handout still fits on two pages.
 *
 * Run this after editing any template or _base.css:
 *     npm run verify
 *
 * Content length is the thing most likely to break these handouts. Adding
 * two sentences to a template can silently push the call-to-action onto a
 * third page, which nobody notices until a doctor prints it. This measures
 * each page's content height against the usable page box and reports the
 * slack remaining, so overflow is caught before anything ships.
 */

const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const { derivePalette } = require("../lib/color");
const { fontFaceCss } = require("../lib/fonts");

const DIR = path.join(__dirname, "..", "templates");
// Letter (11in) minus the 0.5in top and 0.62in bottom print margins, at 96dpi
const USABLE_H = 9.88 * 96;

(async () => {
  const pal = derivePalette("#16457e");
  const css = fs.readFileSync(path.join(DIR, "_base.css"), "utf8").replace("{{font_css}}", fontFaceCss());
  const files = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith(".html") && !f.startsWith("_"))
    .sort();

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: Math.round(7.5 * 96), height: Math.round(USABLE_H) });
  await page.emulateMediaType("print");

  // Longest plausible values, so the check reflects a worst case
  const data = {
    brand_color: pal.brand,
    brand_tint: pal.tint,
    brand_line: pal.line,
    company_name: "Northwest Integrative Wellness Center",
    referral_link: "https://simplyo3.com/northwest-integrative",
    discount_code: "NORTHWEST10",
    logo_data_uri: "",
    qr_data_uri: "",
    logo_display: "none",
    referral_display: "block",
    discount_display: "inline-block",
    qr_display: "block",
  };

  let failures = 0;
  for (const f of files) {
    let html = fs.readFileSync(path.join(DIR, f), "utf8").replace("{{base_css}}", css);
    html = html.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (data[k] != null ? data[k] : ""));
    await page.setContent(html, { waitUntil: "load" });

    const m = await page.evaluate((H) => {
      const pb = document.querySelector(".pb");
      if (!pb) return null;
      const last = document.body.lastElementChild;
      return {
        p1: pb.offsetTop - H,
        p2: last.offsetTop + last.offsetHeight - (pb.offsetTop + pb.offsetHeight) - H,
      };
    }, USABLE_H);

    const name = f.replace(".html", "");
    if (!m) {
      console.log(`SKIP      ${name}  (no .pb page-break marker found)`);
      continue;
    }
    const over = m.p1 > 0 || m.p2 > 0;
    if (over) failures++;
    console.log(
      `${(over ? "OVERFLOW" : "ok").padEnd(9)} ${name.padEnd(40)}` +
        ` page 1 ${(m.p1 / 96).toFixed(2).padStart(6)}in   page 2 ${(m.p2 / 96).toFixed(2).padStart(6)}in`
    );
  }

  console.log(
    `\n${files.length} template(s), ${failures} overflowing. ` +
      `Negative numbers are slack remaining on that page.`
  );
  await browser.close();
  process.exit(failures > 0 ? 1 : 0);
})();
