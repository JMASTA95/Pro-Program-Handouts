/**
 * Handout Generator
 *
 * Local dev:   npm start → http://localhost:3000 → PDFs in /output
 * Production:  Railway + Cloudflare R2 (set R2_* env vars)
 *
 * Optional: set ACCESS_KEY to require ?key=... on the form URL so the
 * deployed app isn't open to the whole internet.
 */

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const { normalizeLogo } = require("./lib/logo");
const { renderHandout, listTemplates } = require("./lib/render");
const { storePdf, R2_ENABLED } = require("./lib/storage");

const app = express();
const PORT = process.env.PORT || 3000;

const upload = multer({
  dest: path.join(__dirname, "uploads"),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ---- Optional gate: if ACCESS_KEY is set, require ?key= on page load ----
app.use((req, res, next) => {
  if (!process.env.ACCESS_KEY) return next();
  if (req.path === "/health") return next();
  // Allow static assets once the page itself was loaded with the key;
  // gate only the form page and the generate endpoint.
  const gated = req.path === "/" || req.path === "/generate";
  if (gated && req.query.key !== process.env.ACCESS_KEY) {
    return res.status(403).send("Access denied. Check your link.");
  }
  next();
});

app.use(express.static(path.join(__dirname, "public")));
app.use("/output", express.static(path.join(__dirname, "output")));

app.get("/health", (req, res) => {
  res.json({ ok: true, storage: R2_ENABLED ? "r2" : "local" });
});

app.get("/api/templates", (req, res) => {
  res.json(listTemplates());
});

app.post("/generate", upload.single("logo"), async (req, res) => {
  try {
    const { email, company_name, brand_color, referral_link, discount_code } =
      req.body;

    let selected = req.body.handouts || [];
    if (!Array.isArray(selected)) selected = [selected];

    if (!email || !company_name || selected.length === 0) {
      return res.status(400).json({
        error: "Email, company name, and at least one handout are required.",
      });
    }

    let logoDataUri = null;
    if (req.file) {
      logoDataUri = await normalizeLogo(req.file.path);
      fs.unlinkSync(req.file.path);
    }

    const mergeData = {
      company_name: company_name.trim(),
      brand_color: brand_color || "#1a6b8a",
      referral_link: referral_link || "",
      discount_code: discount_code || "",
      logo_data_uri: logoDataUri,
    };

    const doctorKey = email.trim().toLowerCase().replace(/[^a-z0-9]/g, "_");
    const outDir = path.join(__dirname, "output", doctorKey);
    fs.mkdirSync(outDir, { recursive: true });

    const results = [];
    for (const templateName of selected) {
      const pdfPath = await renderHandout(templateName, mergeData, outDir);
      const url = await storePdf(pdfPath, doctorKey);
      results.push({ template: templateName, url });
    }

    console.log(
      `[generate] ${email} → ${results.length} handout(s) (${R2_ENABLED ? "R2" : "local"})`
    );
    res.json({ ok: true, files: results });
  } catch (err) {
    console.error("[generate] failed:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Handout generator running on port ${PORT}`);
  console.log(`Storage mode: ${R2_ENABLED ? "Cloudflare R2" : "local /output"}`);
});server.js
