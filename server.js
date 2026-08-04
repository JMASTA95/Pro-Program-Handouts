/**
 * Handout Generator
 *
 * Local dev:   npm start → http://localhost:3000 → PDFs in /output
 * Production:  Railway + Cloudflare R2 (set R2_* env vars)
 *
 * Two ways in, one code path behind them (lib/generate.js):
 *
 *   POST /generate            the doctor-facing form. Multi-select; the download
 *                             links come back to the page. Optionally gated by
 *                             ACCESS_KEY on the URL.
 *   POST /handout/generate    the webhook the public request form posts to.
 *                             Requires the shared secret in a header, looks the
 *                             referral link and code up from the tracking sheet,
 *                             and hands off to ActiveCampaign for the email.
 *
 * POST /handout/retry/:id replays a queued failure with its stored payload.
 */

const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const { normalizeLogo } = require("./lib/logo");
const { listTemplates } = require("./lib/render");
const { R2_ENABLED } = require("./lib/storage");
const { generateOrQueue } = require("./lib/generate");
const { SHEET_ENABLED } = require("./lib/sheets");
const { AC_ENABLED } = require("./lib/activecampaign");
const exceptions = require("./lib/exceptions");

const app = express();
const PORT = process.env.PORT || 3000;

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const SECRET_HEADER = (process.env.WEBHOOK_SECRET_HEADER || "x-handout-secret").toLowerCase();

const upload = multer({
  dest: path.join(__dirname, "uploads"),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ---- Optional gate: if ACCESS_KEY is set, require ?key= on page load ----
app.use((req, res, next) => {
  if (!process.env.ACCESS_KEY) return next();
  if (req.path === "/health") return next();
  // The webhook carries its own shared secret, so the browser key does not apply.
  if (req.path.startsWith("/handout/")) return next();
  const gated = req.path === "/" || req.path === "/generate";
  if (gated && req.query.key !== process.env.ACCESS_KEY) {
    return res.status(403).send("Access denied. Check your link.");
  }
  next();
});

app.use(express.static(path.join(__dirname, "public")));
app.use("/output", express.static(path.join(__dirname, "output")));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    storage: R2_ENABLED ? "r2" : "local",
    sheet: SHEET_ENABLED ? "configured" : "not configured",
    activecampaign: AC_ENABLED ? "configured" : "not configured",
    handouts: listTemplates().length,
  });
});

app.get("/api/templates", (req, res) => {
  res.json(listTemplates());
});

/** Constant-time comparison so the secret cannot be probed by timing. */
function secretMatches(provided) {
  if (!WEBHOOK_SECRET) return false;
  const a = Buffer.from(String(provided == null ? "" : provided), "utf8");
  const b = Buffer.from(WEBHOOK_SECRET, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireSecret(req, res, next) {
  const header = req.get(SECRET_HEADER);
  const bearer = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!secretMatches(header || bearer)) {
    console.warn(`[auth] rejected ${req.method} ${req.path} from ${req.ip}`);
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  return next();
}

/** Turns a thrown HandoutError into the right status and body. */
function failureResponse(res, err) {
  const status = err.code === "BAD_PAYLOAD" || err.code === "UNKNOWN_TEMPLATE" ? 400 : 422;
  return res.status(status).json({
    ok: false,
    code: err.code || "RENDER_FAILED",
    error: err.message,
    queued: Boolean(err.queued),
    exception_id: err.exceptionId || null,
  });
}

/** Reads the uploaded logo (if any) into a normalized data URI, then discards the file. */
async function logoFromRequest(req) {
  if (!req.file) return null;
  try {
    return await normalizeLogo(req.file.path);
  } finally {
    fs.unlink(req.file.path, () => {});
  }
}

// ---------------------------------------------------------------------------
// The doctor-facing form. Multi-select; links come back to the page.
// ---------------------------------------------------------------------------
app.post("/generate", upload.single("logo"), async (req, res) => {
  try {
    const result = await generateOrQueue(
      {
        email: req.body.email,
        company_name: req.body.company_name,
        brand_color: req.body.brand_color,
        handouts: req.body.handouts,
        referral_link: req.body.referral_link,
        discount_code: req.body.discount_code,
        logo_data_uri: await logoFromRequest(req),
      },
      { source: "form" }
    );
    res.json(result);
  } catch (err) {
    if (err.code) return failureResponse(res, err);
    console.error("[generate] failed:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// The webhook. One handout, secret-protected, delivered via ActiveCampaign.
// ---------------------------------------------------------------------------
app.post("/handout/generate", requireSecret, upload.single("logo"), async (req, res) => {
  try {
    // Accepts either use_case (one handout) or handouts[] for symmetry with the form.
    const handouts = req.body.use_case ? [req.body.use_case] : req.body.handouts;
    const result = await generateOrQueue(
      {
        email: req.body.email,
        company_name: req.body.company_name || req.body.practice_name,
        brand_color: req.body.brand_color,
        handouts,
        referral_link: req.body.referral_link,
        discount_code: req.body.discount_code,
        logo_data_uri: (await logoFromRequest(req)) || null,
      },
      { source: req.get("x-handout-source") || "webhook" }
    );
    res.json(result);
  } catch (err) {
    if (err.code) return failureResponse(res, err);
    console.error("[handout] failed:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Retry a queued failure with the payload that failed. Body fields override it,
// so an operator can correct the bad value as part of the retry.
// ---------------------------------------------------------------------------
app.post("/handout/retry/:exceptionId", requireSecret, async (req, res) => {
  let entry;
  try {
    entry = exceptions.loadPayload(req.params.exceptionId);
  } catch {
    return res.status(404).json({ ok: false, error: `No queued exception ${req.params.exceptionId}` });
  }
  try {
    const merged = { ...entry.payload, ...(req.body || {}) };
    // The original logo was not retained, so a retry needs one supplied or none.
    if (merged.logo === "(uploaded)") delete merged.logo;
    const result = await generateOrQueue(merged, { source: `retry:${entry.code}` });
    res.json(result);
  } catch (err) {
    if (err.code) return failureResponse(res, err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Handout generator running on port ${PORT}`);
  console.log(`  storage         ${R2_ENABLED ? "Cloudflare R2" : "local /output"}`);
  console.log(`  tracking sheet  ${SHEET_ENABLED ? "configured" : "NOT configured"}`);
  console.log(`  activecampaign  ${AC_ENABLED ? "configured" : "NOT configured"}`);
  console.log(`  webhook secret  ${WEBHOOK_SECRET ? "set" : "NOT set — /handout/* will reject everything"}`);
});
