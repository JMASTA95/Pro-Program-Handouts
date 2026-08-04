/**
 * render.js — merges branding into an HTML template and renders it to PDF.
 *
 * Per handout it: derives the color palette from the doctor's brand hex,
 * builds a QR code from their referral link, injects the shared design
 * system CSS, merges all {{variables}}, then prints to PDF with a
 * repeating page footer.
 */

const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");

const { derivePalette } = require("./color");
const { fontFaceCss } = require("./fonts");

const TEMPLATE_DIR = path.join(__dirname, "..", "templates");
const BASE_CSS_PATH = path.join(TEMPLATE_DIR, "_base.css");

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      // Docker installs system Chromium and sets this; unset locally.
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });
  }
  return browserPromise;
}

/**
 * Lists available handouts. Files starting with "_" are partials, not
 * handouts. The display label comes from a <!-- label: ... --> comment
 * at the top of each template, so titles read properly on the form.
 */
function listTemplates() {
  return fs
    .readdirSync(TEMPLATE_DIR)
    .filter((f) => f.endsWith(".html") && !f.startsWith("_"))
    .map((f) => {
      const id = f.replace(/\.html$/, "");
      const src = fs.readFileSync(path.join(TEMPLATE_DIR, f), "utf8");
      const m = src.match(/<!--\s*label:\s*(.+?)\s*-->/i);
      return {
        id,
        label: m ? m[1] : id.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Replaces {{variable}} tokens. Unknown tokens become empty strings. */
function mergeTemplate(str, data) {
  return str.replace(/\{\{\s*([\w]+)\s*\}\}/g, (_, key) =>
    data[key] != null ? data[key] : ""
  );
}

/** Escapes text destined for HTML attributes or body copy. */
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Repeating page footer: clinic name, disclaimer, page numbers.
 *
 * Puppeteer renders footerTemplate as its own document, so it never sees
 * _base.css — which is why this carries its own copy of the @font-face rule.
 * Without it the footer prints in Helvetica while the body is Figtree.
 */
function buildFooter(companyName, brandHex) {
  return `
    <style>${fontFaceCss()}</style>
    <div style="width:100%; margin:0 0.5in; font-family:'Figtree',Helvetica,Arial,sans-serif;
                font-size:6.6pt; color:#8b959e; border-top:1px solid ${brandHex}33;
                padding-top:5px; display:flex; justify-content:space-between;">
      <span>${esc(companyName)} &nbsp;|&nbsp; Education only — not medical advice.
        Use at-home ozone therapy under the direction of your clinician.</span>
      <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
    </div>`;
}

/**
 * Renders one handout to PDF.
 * @param {string} templateName filename without .html
 * @param {object} input company_name, brand_color, referral_link, discount_code, logo_data_uri
 * @param {string} outDir directory to write into
 * @returns {Promise<string>} path to the generated PDF
 */
async function renderHandout(templateName, input, outDir) {
  const templatePath = path.join(TEMPLATE_DIR, `${templateName}.html`);
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template not found: ${templateName}`);
  }

  const palette = derivePalette(input.brand_color);

  // QR code encodes the doctor's referral link so patients can scan
  // straight to their storefront. Skipped when there is no link.
  let qrDataUri = "";
  if (input.referral_link) {
    qrDataUri = await QRCode.toDataURL(input.referral_link, {
      margin: 0,
      width: 300,
      color: { dark: palette.brand, light: "#ffffff" },
    });
  }

  const data = {
    company_name: esc(input.company_name),
    brand_color: palette.brand,
    brand_tint: palette.tint,
    brand_line: palette.line,
    referral_link: esc(input.referral_link || ""),
    discount_code: esc(input.discount_code || ""),
    logo_data_uri: input.logo_data_uri || "",
    qr_data_uri: qrDataUri,
    // Visibility switches so blocks collapse cleanly when data is absent
    logo_display: input.logo_data_uri ? "block" : "none",
    referral_display: input.referral_link ? "block" : "none",
    discount_display: input.discount_code ? "inline-block" : "none",
    qr_display: qrDataUri ? "block" : "none",
  };

  // Inject shared CSS first (it contains its own {{variables}}),
  // then merge everything in one pass over the assembled document.
  const baseCss = fs.readFileSync(BASE_CSS_PATH, "utf8").replace("{{font_css}}", fontFaceCss());
  const rawHtml = fs.readFileSync(templatePath, "utf8");
  const html = mergeTemplate(rawHtml.replace("{{base_css}}", baseCss), data);

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "load" });

    // The font is embedded, so this resolves off the data URI with no network
    // involved. The race stays as a guard against a pathological Chromium hang.
    await Promise.race([
      page.evaluate(() => document.fonts.ready),
      new Promise((r) => setTimeout(r, 3000)),
    ]);

    const pdfPath = path.join(outDir, `${templateName}.pdf`);
    await page.pdf({
      path: pdfPath,
      format: "Letter",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: buildFooter(input.company_name, palette.brand),
      margin: { top: "0.5in", bottom: "0.62in", left: "0.5in", right: "0.5in" },
    });
    return pdfPath;
  } finally {
    await page.close();
  }
}

module.exports = { renderHandout, listTemplates };
