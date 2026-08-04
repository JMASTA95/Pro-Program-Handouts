/**
 * validate.js — the guard rails between a form submission and a printed handout.
 *
 * A handout is permanent once printed. A QR code pointing at a dead link, or a
 * discount code that does not work at checkout, is worse than no handout at all,
 * so each of these fails the request rather than degrading quietly.
 */

const MAX_CODE_LENGTH = Number(process.env.DISCOUNT_CODE_MAX_LENGTH || 20);
const LINK_TIMEOUT_MS = Number(process.env.REFERRAL_LINK_TIMEOUT_MS || 8000);
const LINK_RETRY_DELAY_MS = Number(process.env.REFERRAL_LINK_RETRY_DELAY_MS || 2000);
const LINK_CHECK = String(process.env.REFERRAL_LINK_CHECK || "true").toLowerCase() !== "false";
const OK_STATUSES = (process.env.REFERRAL_LINK_OK_STATUSES || "200,301,302,307,308")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter(Number.isFinite);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

class HandoutError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function assertEmail(email) {
  const value = String(email || "").trim().toLowerCase();
  if (!value) throw new HandoutError("BAD_PAYLOAD", "An email address is required.");
  if (!EMAIL_RE.test(value)) throw new HandoutError("BAD_PAYLOAD", `"${value}" is not a valid email address.`);
  return value;
}

function assertCompanyName(name) {
  const value = String(name || "").trim();
  if (!value) throw new HandoutError("BAD_PAYLOAD", "A practice name is required.");
  return value;
}

function assertDiscountCode(code) {
  const value = String(code || "").trim();
  if (!value) {
    throw new HandoutError("SHEET_INCOMPLETE", "No discount code available; refusing to print a blank code.");
  }
  if (value.length > MAX_CODE_LENGTH) {
    throw new HandoutError(
      "DISCOUNT_CODE_TOO_LONG",
      `Discount code "${value}" is ${value.length} characters; the layout is only safe up to ` +
        `${MAX_CODE_LENGTH}. Shorten it in the tracking sheet and retry.`
    );
  }
  return value;
}

/**
 * Checks shape and returns the canonical URL that gets printed and encoded.
 *
 * Links are recorded by hand and are almost always written scheme-less
 * ("www.simplyo3.com/x"), which is unambiguous to a person but not a URL. Those
 * are upgraded to https rather than refused; the reachability check immediately
 * after is what actually protects the patient.
 */
function assertReferralLink(link) {
  let value = String(link || "").trim();
  if (!value) {
    throw new HandoutError("SHEET_INCOMPLETE", "No referral link available; refusing to print a blank link.");
  }
  // Only add a scheme to something already shaped like a bare host.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value) && /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$|\?)/i.test(value)) {
    value = `https://${value}`;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new HandoutError("REFERRAL_LINK_INVALID", `Referral link "${value}" is not a valid URL.`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new HandoutError("REFERRAL_LINK_INVALID", `Referral link "${value}" must be http or https.`);
  }
  if (!parsed.hostname.includes(".")) {
    throw new HandoutError("REFERRAL_LINK_INVALID", `Referral link "${value}" has no valid hostname.`);
  }
  return parsed.toString();
}

/**
 * Confirms the link actually resolves. Never print a QR for a dead link.
 *
 * 429 and 5xx mean the shop is busy, not that the link is broken, so those get
 * one backoff and the second answer is believed.
 */
async function assertLinkReachable(link, { fetchImpl = fetch } = {}) {
  if (!LINK_CHECK) return { checked: false, status: null };

  const attempt = async (method) => {
    const res = await fetchImpl(link, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(LINK_TIMEOUT_MS),
      headers: { "user-agent": "HandoutGenerator/1.0 (+link-check)" },
    });
    return res.status;
  };

  let status;
  try {
    status = await attempt("HEAD");
    // Plenty of storefronts do not implement HEAD; fall back before judging.
    if (status === 405 || status === 501 || status === 403) status = await attempt("GET");
    if (status === 429 || status >= 500) {
      await new Promise((r) => setTimeout(r, LINK_RETRY_DELAY_MS));
      status = await attempt("GET");
    }
  } catch (err) {
    throw new HandoutError(
      "REFERRAL_LINK_UNREACHABLE",
      `Referral link ${link} could not be reached (${err.name === "TimeoutError" ? "timed out" : err.message}).`
    );
  }

  if (!OK_STATUSES.includes(status)) {
    throw new HandoutError(
      "REFERRAL_LINK_UNREACHABLE",
      `Referral link ${link} returned HTTP ${status}; expected one of ${OK_STATUSES.join("/")}.`
    );
  }
  return { checked: true, status };
}

module.exports = {
  HandoutError,
  assertEmail,
  assertCompanyName,
  assertDiscountCode,
  assertReferralLink,
  assertLinkReachable,
  MAX_CODE_LENGTH,
};
