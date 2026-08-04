/**
 * check-sheet.js — pre-flight for the practitioner tracking sheet.
 *
 *   npm run check:sheet                       headers, row count, completeness
 *   npm run check:sheet -- doc@clinic.com     also resolve one practitioner
 *   npm run check:sheet -- --links            also confirm every link resolves
 *
 * A row that would be refused at request time is far better found here than by
 * a doctor filling in the form.
 */

const { readSheet, mapHeaders, parsePercent, COLUMNS, SHEET_ENABLED } = require("../lib/sheets");
const { assertReferralLink, assertDiscountCode, assertLinkReachable } = require("../lib/validate");

const args = process.argv.slice(2);
const email = args.find((a) => a.includes("@"));
const probeLinks = args.includes("--links");
const strict = args.includes("--strict");

(async () => {
  // "Not set up yet" and "set up wrong" need different answers, so say which.
  if (!SHEET_ENABLED) {
    const mode = process.env.SHEETS_MODE || "service_account";
    console.error("The tracking sheet is not configured yet.\n");
    if (mode === "csv_url") {
      console.error("SHEETS_MODE=csv_url, so set SHEETS_CSV_URL to a published-CSV URL or a local file.");
    } else {
      const have = (k) => (process.env[k] ? "set" : "MISSING");
      console.error(`  SHEETS_SPREADSHEET_ID   ${have("SHEETS_SPREADSHEET_ID")}`);
      console.error(`  SHEETS_SA_EMAIL         ${have("SHEETS_SA_EMAIL")}`);
      console.error(`  SHEETS_SA_PRIVATE_KEY   ${have("SHEETS_SA_PRIVATE_KEY")}`);
    }
    console.error("\nWalkthrough: CONNECT.md. Locally these are read from .env.");
    process.exit(1);
  }

  let rows;
  try {
    rows = await readSheet();
  } catch (err) {
    console.error(`Could not read the sheet: ${err.message}\n`);
    console.error("Most likely the sheet is not shared with the service account, or SHEETS_RANGE");
    console.error("points at the wrong tab. See CONNECT.md.");
    process.exit(1);
  }

  if (rows.length < 2) {
    console.error(`The sheet has ${rows.length} row(s); expected a header row plus data.`);
    process.exit(1);
  }

  const cols = mapHeaders(rows[0]);
  console.log(`\nRead ${rows.length - 1} practitioner row(s).\n`);
  console.log("Column mapping:");
  for (const key of Object.keys(COLUMNS)) {
    const i = cols[key];
    console.log(`  ${key.padEnd(14)} ${i === -1 ? "NOT FOUND" : `col ${String(i + 1).padStart(2)}  "${rows[0][i]}"`}`);
  }

  const missing = Object.keys(COLUMNS).filter((k) => cols[k] === -1);
  if (missing.length) {
    console.error(`\nMissing required column(s): ${missing.join(", ")}`);
    console.error(`Headers found: ${rows[0].join(" | ")}`);
    console.error("Rename the sheet headers, or set SHEETS_COL_* to match what you use.");
    process.exit(1);
  }

  const at = (r, i) => (i === -1 ? "" : String(r[i] == null ? "" : r[i]).trim());
  const data = rows.slice(1).filter((r) => at(r, cols.email));

  const refused = [];
  const cosmetic = [];
  const noDiscount = [];
  const byPercent = new Map();
  for (const r of data) {
    const addr = at(r, cols.email);
    const percent = parsePercent(at(r, cols.discountPercent));
    byPercent.set(percent, (byPercent.get(percent) || 0) + 1);
    let link = null;
    try {
      link = assertReferralLink(at(r, cols.referralLink));
    } catch (err) {
      refused.push({ addr, code: err.code, detail: err.message });
    }
    // A 0% affiliate group means no discount code by design, so requiring one
    // would flag a correct row as broken.
    if (percent === 0) {
      noDiscount.push({ addr, group: at(r, cols.discountPercent) });
    } else {
      try {
        assertDiscountCode(at(r, cols.discountCode));
      } catch (err) {
        refused.push({ addr, code: err.code, detail: err.message });
      }
    }
    if (link && /([^:])\/\//.test(link)) {
      cosmetic.push({ addr, detail: `${link} contains a double slash` });
    }
    if (link && probeLinks) {
      try {
        await assertLinkReachable(link);
      } catch (err) {
        refused.push({ addr, code: err.code, detail: err.message });
      }
      // Unhurried on purpose: a burst of requests trips the shop's rate limiter,
      // which then looks exactly like a broken link.
      await new Promise((r2) => setTimeout(r2, 250));
    }
  }

  console.log("\nDiscount spread (from the affiliate group column):");
  for (const [pct, n] of [...byPercent.entries()].sort((a, b) => (b[1] || 0) - (a[1] || 0))) {
    const label = pct == null ? "no percentage found" : pct === 0 ? "0% — no discount code" : `${pct}%`;
    console.log(`  ${String(n).padStart(3)}  ${label}`);
  }

  console.log(`\n${data.length - refused.length}/${data.length} row(s) would generate cleanly.`);
  if (noDiscount.length) {
    console.log(`\n${noDiscount.length} row(s) are on a 0% group, so their handouts print no code:\n`);
    for (const d of noDiscount) console.log(`  ${d.addr}\n      ${d.group}`);
  }
  if (refused.length) {
    console.log(`\n${refused.length} row(s) WOULD BE REFUSED at request time:\n`);
    for (const p of refused) console.log(`  ${p.code.padEnd(26)} ${p.addr}\n      ${p.detail}`);
  }
  if (cosmetic.length) {
    console.log(`\n${cosmetic.length} row(s) work but are worth tidying:\n`);
    for (const c of cosmetic) console.log(`  ${c.addr}\n      ${c.detail}`);
  }
  if (!probeLinks) console.log("\nAdd --links to also check that every referral link resolves.");

  let askedResolved = null;
  if (email) {
    const { lookupByEmail } = require("../lib/sheets");
    console.log(`\nResolving ${email} ...`);
    const row = await lookupByEmail(email);
    if (!row) {
      console.log("  not in the sheet — a request would be refused as NO_SHEET_MATCH");
      askedResolved = false;
    } else {
      const zero = row.discount_percent === 0;
      console.log(`  affiliate group : ${row.affiliate_group || "(blank)"}`);
      console.log(`  discount        : ${zero ? "none — 0% group, no code printed" : row.discount_percent == null ? "percentage unknown; code printed without a figure" : `${row.discount_percent}%`}`);
      console.log(`  referral link   : ${row.referral_link || "(blank)"}`);
      console.log(`  discount code   : ${row.discount_code || (zero ? "(none, by design)" : "(blank)")}`);
      // A 0% practitioner is complete without a code.
      askedResolved = Boolean(row.referral_link) && (zero || Boolean(row.discount_code));
    }
  }

  // A few incomplete rows out of a hundred is a sheet to tidy, not a broken
  // connection — so don't exit non-zero and make it look like the check failed.
  // --strict is there for CI, where any refusable row should fail the build.
  console.log("");
  if (askedResolved === false) {
    console.log(`VERDICT: the sheet reads fine, but ${email} would be refused. Fix that row.`);
    process.exitCode = 1;
  } else if (refused.length && strict) {
    console.log(`VERDICT: sheet connected; ${refused.length} row(s) need fixing (--strict, so exiting 1).`);
    process.exitCode = 1;
  } else if (refused.length) {
    console.log(
      `VERDICT: sheet connected and working. ${refused.length} row(s) above need fixing in the ` +
        `sheet before those practitioners can request a handout; everyone else is fine.`
    );
  } else {
    console.log("VERDICT: sheet connected, every row usable.");
  }
})();
