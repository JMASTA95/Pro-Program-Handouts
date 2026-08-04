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

const { renderHandout } = require("./render");
const { storePdf, R2_ENABLED } = require("./storage");
const { lookupByEmail, SHEET_ENABLED } = require("./sheets");
const { deliver, AC_ENABLED } = require("./activecampaign");
const exceptions = require("./exceptions");
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
async function resolveReferral({ email, referral_link, discount_code }) {
  if (referral_link && discount_code) {
    return { referral_link, discount_code, source: "payload" };
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
  const code = discount_code || row.discount_code;
  const missing = [];
  if (!link) missing.push("referral link");
  if (!code) missing.push("discount code");
  if (missing.length) {
    throw new HandoutError(
      "SHEET_INCOMPLETE",
      `${email} is in the tracking sheet but has no ${missing.join(" and ")}. Fill that in and ` +
        "retry — a handout is never generated with a blank link or code."
    );
  }
  return { referral_link: link, discount_code: code, source: "sheet" };
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

  const referral = await resolveReferral({
    email,
    referral_link: input.referral_link,
    discount_code: input.discount_code,
  });

  // Guard rails before any rendering: a dead link or an over-long code should
  // never reach a printed page.
  const discountCode = assertDiscountCode(referral.discount_code);
  const referralLink = assertReferralLink(referral.referral_link);
  const linkCheck = await assertLinkReachable(referralLink);

  const mergeData = {
    company_name: companyName,
    brand_color: input.brand_color || "#1a6b8a",
    referral_link: referralLink,
    discount_code: discountCode,
    logo_data_uri: input.logo_data_uri || null,
  };

  const doctorKey = email.replace(/[^a-z0-9]/g, "_");
  const outDir = path.join(outDirRoot, doctorKey);
  fs.mkdirSync(outDir, { recursive: true });

  const files = [];
  for (const templateName of selected) {
    const pdfPath = await renderHandout(templateName, mergeData, outDir);
    const url = await storePdf(pdfPath, doctorKey);
    files.push({ template: templateName, url });
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

  const ms = Date.now() - started;
  console.log(
    `[generate] ${email} → ${files.length} handout(s) in ${ms}ms ` +
      `(referral from ${referral.source}, storage ${R2_ENABLED ? "R2" : "local"}, ` +
      `delivery ${delivery.attempted ? "AC" : "none"}) [${source}]`
  );

  return {
    ok: true,
    files,
    company_name: companyName,
    referral: { source: referral.source, link_check: linkCheck },
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
