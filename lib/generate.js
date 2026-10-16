/**
 * generate.js — the one path from a submission to delivered handouts.
 *
 * Both entry points use this: the doctor-facing form (multi-select, links shown
 * on the page) and the webhook the request form posts to. Keeping them on one
 * function means the validation and the sheet lookup cannot drift apart.
 *
 * Order matters. Everything that can refuse the request does so before Chromium
 * is started, so a bad payload costs nothing.
 */

const fs = require("fs");
const path = require("path");

const { renderHandout, listTemplates } = require("./render");
const { storePdf, R2_ENABLED } = require("./storage");
const { lookupByEmail, SHEET_ENABLED } = require("./sheets");
const { deliver, AC_ENABLED } = require("./activecampaign");
const exceptions = require("./exceptions");
/**
 * Public origin of this service, used to turn a stored path into a link that
 * survives leaving the process. An automation puts this straight into an email,
 * where "/output/x.pdf" is useless. R2 URLs are already absolute and untouched.
 */
const PUBLIC_BASE = (process.env.SERVICE_BASE_URL || "").replace(/\/+$/, "");
function absoluteUrl(url) {
  if (!url || /^https?:/i.test(url) || !PUBLIC_BASE) return url;
  return `${PUBLIC_BASE}${url.startsWith("/") ? "" : "/"}${url}`;
}

const {
  HandoutError,
  assertEmail,
  assertCompanyName,
  assertDiscountCode,
  assertReferralLink,
  assertLinkReachable,
} = require("./validate");

/**
 * Works out the referral link and discount code.
 *
 * Typed values win, so an operator can override during a retry. Otherwise the
 * tracking sheet is consulted by email — the sheet is the source of truth
 * because both values are created by hand per practitioner.
 */
async function resolveReferral({ email, referral_link, discount_code, discount_percent }) {
  if (referral_link && discount_code) {
    return {
      referral_link,
      discount_code,
      // May be absent or blank; the phrasing then degrades to "to save" rather
      // than printing an empty percentage.
      discount_percent: overridePercent(discount_percent),
      source: "payload",
    };
  }
  if (!SHEET_ENABLED) {
    // Without a sheet there is nowhere to look, so say that rather than
    // rendering a handout with a blank code.
    throw new HandoutError(
      "SHEET_UNAVAILABLE",
      "No referral link or discount code was supplied and the tracking sheet is not configured " +
        "(set SHEETS_* — see CONNECT.md)."
    );
  }

  const row = await lookupByEmail(email);
  if (!row) {
    throw new HandoutError(
      "NO_SHEET_MATCH",
      `${email} is not in the practitioner tracking sheet. Add their row with a referral link ` +
        "and discount code, then retry. No handout was generated."
    );
  }

  const link = referral_link || row.referral_link;
  const override = overridePercent(discount_percent);
  const percent = override == null ? row.discount_percent : override;

  // A 0% affiliate group means this practitioner has no discount to offer, so
  // no code is printed and none is required. Distinct from an unknown
  // percentage, where an existing code is still printed without a figure.
  const noDiscount = percent === 0;
  const code = noDiscount ? "" : discount_code || row.discount_code;

  const missing = [];
  if (!link) missing.push("referral link");
  if (!code && !noDiscount) missing.push("discount code");
  if (missing.length) {
    throw new HandoutError(
      "SHEET_INCOMPLETE",
      `${email} is in the tracking sheet but has no ${missing.join(" and ")}. Fill that in and ` +
        "retry — a handout is never generated with a blank link or code. (Affiliate group: " +
        `${row.affiliate_group || "not set"}.)`
    );
  }
  return {
    referral_link: link,
    discount_code: code,
    discount_percent: percent,
    affiliate_group: row.affiliate_group,
    // The sheet's own code, kept so a suppressed one can be reported rather
    // than vanishing: printing nothing when the sheet has a code is the kind
    // of wrong that looks like success.
    sheet_discount_code: row.discount_code || "",
    source: "sheet",
  };
}

/**
 * Reads a caller-supplied discount percentage, distinguishing "not supplied"
 * from a real number.
 *
 * Number("") is 0, and 0 means "no discount code at all" — so a blank field,
 * which is what an automation sends for an unmapped or empty input, used to
 * silently strip a practitioner's valid code and print the no-discount wording.
 * Nothing failed and nothing was queued; the handout was just quietly wrong.
 *
 * Returns null for anything that is not a genuine number, so the sheet stays
 * the source of truth unless the caller really means to override it. An
 * explicit 0 is still honoured.
 */
function overridePercent(value) {
  if (value == null) return null;
  const text = String(value).trim().replace(/%$/, "");
  if (text === "") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/**
 * The sentence fragment that follows the code, e.g. "to save 10%".
 *
 * Built here rather than in the templates so an unknown percentage degrades to
 * the wording the handouts already used, instead of printing "to save %".
 */
function discountPhrase(percent) {
  if (percent == null || !Number.isFinite(percent) || percent <= 0) return "to save";
  // Trims 10.0 to 10 while keeping 12.5 intact.
  const shown = Number.isInteger(percent) ? String(percent) : String(percent);
  return `to save ${shown}%`;
}

/**
 * @param {object} input email, company_name, brand_color, handouts[], logo_data_uri,
 *                       and optionally referral_link / discount_code to override the sheet
 * @param {object} deps  outDirRoot, source label, and injectable collaborators for tests
 */
async function generateHandouts(input, deps = {}) {
  const {
    outDirRoot = path.join(__dirname, "..", "output"),
    source = "unknown",
    skipDelivery = false,
  } = deps;

  const started = Date.now();
  const email = assertEmail(input.email);
  const companyName = assertCompanyName(input.company_name);

  let selected = input.handouts || [];
  if (!Array.isArray(selected)) selected = [selected];
  selected = selected.filter(Boolean);
  if (!selected.length) {
    throw new HandoutError("BAD_PAYLOAD", "Choose at least one handout.");
  }

  // Checked here, before the sheet is read, because a bad slug is the caller
  // being misconfigured — an automation sending a label instead of an id, say.
  // Left to the renderer it surfaced as a generic failure and landed on the
  // exception queue, so one broken Zap would bury the real failures.
  const available = listTemplates().map((t) => t.id);
  const unknown = selected.filter((s) => !available.includes(s));
  if (unknown.length) {
    throw new HandoutError(
      "UNKNOWN_TEMPLATE",
      `No such handout: ${unknown.join(", ")}. Valid ids are ${available.join(", ")} ` +
        "(GET /api/templates)."
    );
  }

  const referral = await resolveReferral({
    email,
    referral_link: input.referral_link,
    discount_code: input.discount_code,
    discount_percent: input.discount_percent,
  });

  // Guard rails before any rendering: a dead link or an over-long code should
  // never reach a printed page. A 0% practitioner has no code by design, so the
  // code check only applies when there is one.
  const discountCode = referral.discount_code ? assertDiscountCode(referral.discount_code) : "";
  const referralLink = assertReferralLink(referral.referral_link);
  const linkCheck = await assertLinkReachable(referralLink);

  const mergeData = {
    company_name: companyName,
    brand_color: input.brand_color || "#1a6b8a",
    referral_link: referralLink,
    discount_code: discountCode,
    discount_percent: referral.discount_percent,
    discount_phrase: discountPhrase(referral.discount_percent),
    logo_data_uri: input.logo_data_uri || null,
  };

  const doctorKey = email.replace(/[^a-z0-9]/g, "_");
  const outDir = path.join(outDirRoot, doctorKey);
  fs.mkdirSync(outDir, { recursive: true });

  const files = [];
  for (const templateName of selected) {
    const pdfPath = await renderHandout(templateName, mergeData, outDir);
    const url = await storePdf(pdfPath, doctorKey);
    files.push({ template: templateName, url: absoluteUrl(url) });
  }

  // ActiveCampaign holds one handout URL per contact, so the tag-triggered email
  // can only carry one link. A multi-handout request is therefore delivered by
  // the links on the form page, not by AC — rather than silently emailing the
  // practitioner one of the five they asked for.
  let delivery = { attempted: false, reason: "" };
  if (skipDelivery) {
    delivery = { attempted: false, reason: "delivery skipped by caller" };
  } else if (!AC_ENABLED) {
    delivery = { attempted: false, reason: "ActiveCampaign not configured" };
  } else if (files.length !== 1) {
    delivery = {
      attempted: false,
      reason: `${files.length} handouts requested; AC carries a single URL, so links were returned to the caller instead`,
    };
  } else {
    const result = await deliver({
      email,
      companyName,
      handoutUrl: files[0].url,
      useCase: files[0].template,
    });
    delivery = { attempted: true, ...result };
  }

  // Spelled out because "no discount code" alone hid a real bug: a blank
  // percentage from a caller was discarding codes the sheet did have.
  let noCodeReason = "no discount code";
  if (!discountCode) {
    if (referral.sheet_discount_code) {
      noCodeReason =
        `NO DISCOUNT CODE PRINTED although the sheet has "${referral.sheet_discount_code}" ` +
        `(resolved percentage ${referral.discount_percent})`;
      console.warn(
        `[generate] ${email}: suppressed the sheet's discount code ` +
          `"${referral.sheet_discount_code}" because the resolved discount is ` +
          `${referral.discount_percent}%. If that is wrong, check what the caller sent as ` +
          `discount_percent — a blank value is not treated as 0, but an explicit 0 is.`
      );
    } else if (referral.discount_percent === 0) {
      noCodeReason = "no discount code (0% affiliate group)";
    }
  }

  const ms = Date.now() - started;
  console.log(
    `[generate] ${email} → ${files.length} handout(s) in ${ms}ms ` +
      `(referral from ${referral.source}, ` +
      `${discountCode ? `${discountPhrase(referral.discount_percent)} with ${discountCode}` : noCodeReason}, ` +
      `storage ${R2_ENABLED ? "R2" : "local"}, delivery ${delivery.attempted ? "AC" : "none"}) [${source}]`
  );

  return {
    ok: true,
    files,
    // Flat fields as well as files[], because Zapier and similar tools map a
    // top-level string far more easily than an array of objects.
    handout_url: files.length === 1 ? files[0].url : null,
    handout_urls: files.map((f) => f.url).join(", "),
    handout_count: files.length,
    company_name: companyName,
    referral: {
      source: referral.source,
      link_check: linkCheck,
      discount_percent: referral.discount_percent,
      discount_code: discountCode || null,
      affiliate_group: referral.affiliate_group || null,
    },
    delivery,
    ms,
  };
}

/**
 * Wraps generateHandouts so any failure a human needs to see lands on the
 * exception queue with its payload, then rethrows for the route to turn into a
 * response. Nothing fails silently.
 */
async function generateOrQueue(input, deps = {}) {
  try {
    return await generateHandouts(input, deps);
  } catch (err) {
    const code = err.code || "RENDER_FAILED";
    // A malformed request is the caller being wrong, not something to queue.
    const queue = code !== "BAD_PAYLOAD" && code !== "UNKNOWN_TEMPLATE";
    if (queue) {
      const outcome = await exceptions.record({
        payload: {
          email: input.email,
          company_name: input.company_name,
          brand_color: input.brand_color,
          handouts: input.handouts,
          referral_link: input.referral_link,
          discount_code: input.discount_code,
          discount_percent: input.discount_percent,
          // The logo is a data URI; record only that there was one.
          logo: input.logo_data_uri ? "(uploaded)" : null,
        },
        code,
        reason: err.message,
        source: deps.source || "unknown",
      });
      err.exceptionId = outcome.exception_id;
      err.queued = true;
    }
    err.code = code;
    throw err;
  }
}

module.exports = { generateHandouts, generateOrQueue, resolveReferral };
