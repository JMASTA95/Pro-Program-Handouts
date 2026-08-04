/**
 * sheets.js — reads the practitioner tracking sheet.
 *
 * The sheet is the source of truth for referral links and discount codes. Both
 * are created by hand per practitioner (a shortened company name, for example),
 * so no API can derive them — the sheet is where the human decision is recorded.
 * The doctor supplies only their email; this maps it to their link and code.
 *
 * Auth is a service-account JWT signed locally, so no Google client library.
 */

const crypto = require("crypto");
const fs = require("fs");

const TIMEOUT_MS = Number(process.env.SHEETS_TIMEOUT_MS || 15000);
const CACHE_TTL_MS = Number(process.env.SHEETS_CACHE_TTL_MS || 60000);

/** Column headings to look for, most specific first. Matching is by name, not position. */
const COLUMNS = {
  email: (process.env.SHEETS_COL_EMAIL || "email,practitioner email,contact email").split(","),
  referralLink: (
    process.env.SHEETS_COL_REFERRAL ||
    "shopify_link,shopify link,referral link,referral url,affiliate link,affiliate url"
  ).split(","),
  discountCode: (
    process.env.SHEETS_COL_CODE || "affiliate_code,affiliate code,discount code,coupon code,coupon,code"
  ).split(","),
  // The affiliate group carries the discount size, e.g. "Pro Program - Share (10%)".
  // A 0% group means that practitioner has no discount code at all.
  discountPercent: (
    process.env.SHEETS_COL_PERCENT ||
    "affiliate_group (%=discount),affiliate_group,affiliate group,discount percent,discount %"
  ).split(","),
};

/**
 * Pulls the discount size out of an affiliate-group label.
 *
 * Returns a number (0 included, which is meaningful) or null when the cell
 * holds no percentage at all — null and 0 must stay distinguishable, because
 * one means "we do not know" and the other means "no discount".
 */
function parsePercent(value) {
  const m = String(value == null ? "" : value).match(/(\d+(?:\.\d+)?)\s*%/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

const MODE = process.env.SHEETS_MODE || "service_account";
const SPREADSHEET_ID = process.env.SHEETS_SPREADSHEET_ID || "";
const RANGE = process.env.SHEETS_RANGE || "Sheet1!A:Z";
const CSV_SOURCE = process.env.SHEETS_CSV_URL || "";
const SA_EMAIL = process.env.SHEETS_SA_EMAIL || "";
const SA_KEY = (process.env.SHEETS_SA_PRIVATE_KEY || "").replace(/\\n/g, "\n");

const SHEET_ENABLED = MODE === "csv_url" ? Boolean(CSV_SOURCE) : Boolean(SPREADSHEET_ID && SA_EMAIL && SA_KEY);

class SheetError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** Mints a short-lived read-only Sheets access token from the service-account key. */
async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: SA_EMAIL,
      scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })
  );
  const signature = crypto.createSign("RSA-SHA256").update(`${header}.${claims}`).sign(SA_KEY);
  const assertion = `${header}.${claims}.${base64url(signature)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || !body.access_token) {
    throw new Error(`Google token exchange returned HTTP ${res.status}`);
  }
  return body.access_token;
}

/** Minimal RFC-4180 CSV parser: quoted fields, embedded commas and newlines. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

const normalise = (s) => String(s == null ? "" : s).toLowerCase().replace(/[\s_-]+/g, " ").trim();

/**
 * Maps the header row onto the fields needed. Found by heading name so that
 * inserting or reordering a column in the sheet cannot silently break lookups.
 */
function mapHeaders(headerRow) {
  const headers = headerRow.map(normalise);
  const find = (candidates) => {
    for (const c of candidates.map(normalise)) {
      const exact = headers.indexOf(c);
      if (exact !== -1) return exact;
    }
    // Fall back to a contains match so "Referral Link (live)" still resolves.
    for (const c of candidates.map(normalise)) {
      const partial = headers.findIndex((h) => h.includes(c));
      if (partial !== -1) return partial;
    }
    return -1;
  };
  return {
    email: find(COLUMNS.email),
    referralLink: find(COLUMNS.referralLink),
    discountCode: find(COLUMNS.discountCode),
    discountPercent: find(COLUMNS.discountPercent),
  };
}

let cache = null;

async function fetchRows({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows;

  let rows;
  if (MODE === "csv_url") {
    // A local path is accepted too, which is what makes offline testing possible.
    if (!/^https?:/i.test(CSV_SOURCE)) {
      rows = parseCsv(fs.readFileSync(CSV_SOURCE, "utf8"));
    } else {
      const res = await fetch(CSV_SOURCE, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`Sheet CSV returned HTTP ${res.status}`);
      rows = parseCsv(await res.text());
    }
  } else {
    const token = await getAccessToken();
    const url =
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}` +
      `/values/${encodeURIComponent(RANGE)}?majorDimension=ROWS`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = body && body.error ? JSON.stringify(body.error).slice(0, 200) : "";
      throw new Error(`Sheets API returned HTTP ${res.status} ${detail}`);
    }
    rows = ((body && body.values) || []).filter((r) => r.some((c) => String(c).trim() !== ""));
  }

  cache = { at: Date.now(), rows };
  return rows;
}

/** Raw rows, cache bypassed. Used by the pre-flight check. */
async function readSheet() {
  return fetchRows({ force: true });
}

/**
 * Finds a practitioner's row by email.
 *
 * Returns null when the sheet simply has no such practitioner. Throws
 * SHEET_UNAVAILABLE when the sheet itself cannot be read — those are different
 * problems and only one of them is the practitioner's fault.
 */
async function lookupByEmail(email) {
  let rows;
  try {
    rows = await fetchRows();
  } catch (err) {
    throw new SheetError("SHEET_UNAVAILABLE", `Could not read the tracking sheet: ${err.message}`);
  }
  if (rows.length < 2) {
    throw new SheetError("SHEET_UNAVAILABLE", "The tracking sheet has no data rows.");
  }

  const cols = mapHeaders(rows[0]);
  const missing = ["email", "referralLink", "discountCode", "discountPercent"].filter(
    (k) => cols[k] === -1
  );
  if (missing.length) {
    throw new SheetError(
      "SHEET_UNAVAILABLE",
      `The tracking sheet has no column for ${missing.join(", ")}. Headers found: ${rows[0].join(" | ")}`
    );
  }

  const target = normalise(email);
  const at = (row, i) => (i === -1 ? "" : String(row[i] == null ? "" : row[i]).trim());
  // Last match wins, so a corrected duplicate further down the sheet takes precedence.
  let found = null;
  for (const row of rows.slice(1)) {
    if (normalise(at(row, cols.email)) === target) found = row;
  }
  if (!found) return null;

  const groupLabel = at(found, cols.discountPercent);
  return {
    email: at(found, cols.email),
    referral_link: at(found, cols.referralLink),
    discount_code: at(found, cols.discountCode),
    // null when the sheet says nothing; 0 is a real answer meaning "no discount".
    discount_percent: parsePercent(groupLabel),
    affiliate_group: groupLabel,
  };
}

module.exports = {
  lookupByEmail,
  readSheet,
  mapHeaders,
  parseCsv,
  parsePercent,
  SHEET_ENABLED,
  SheetError,
  COLUMNS,
};
