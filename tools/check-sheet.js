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

const { readSheet, mapHeaders, COLUMNS } = require("../lib/sheets");
const { assertReferralLink, assertDiscountCode, assertLinkReachable } = require("../lib/validate");

const args = process.argv.slice(2);
const email = args.find((a) => a.includes("@"));
const probeLinks = args.includes("--links");

(async () => {
  let rows;
  try {
    rows = await readSheet();
  } catch (err) {
    console.error(`Could not read the sheet: ${err.message}\n`);
    console.error("Most likely the sheet is not shared with the service account, or SHEETS_RANGE");
    console.error("points at the wrong tab. See CONNECT.md §2.");
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
  for (const r of data) {
    const addr = at(r, cols.email);
    let link = null;
    try {
      link = assertReferralLink(at(r, cols.referralLink));
    } catch (err) {
      refused.push({ addr, code: err.code, detail: err.message });
    }
    try {
      assertDiscountCode(at(r, cols.discountCode));
    } catch (err) {
      refused.push({ addr, code: err.code, detail: err.message });
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

  console.log(`\n${data.length - refused.length}/${data.length} row(s) would generate cleanly.`);
  if (refused.length) {
    console.log(`\n${refused.length} row(s) WOULD BE REFUSED at request time:\n`);
    for (const p of refused) console.log(`  ${p.code.padEnd(26)} ${p.addr}\n      ${p.detail}`);
  }
  if (cosmetic.length) {
    console.log(`\n${cosmetic.length} row(s) work but are worth tidying:\n`);
    for (const c of cosmetic) console.log(`  ${c.addr}\n      ${c.detail}`);
  }
  if (!probeLinks) console.log("\nAdd --links to also check that every referral link resolves.");

  if (email) {
    const { lookupByEmail } = require("../lib/sheets");
    console.log(`\nResolving ${email} ...`);
    const row = await lookupByEmail(email);
    if (!row) {
      console.log("  not in the sheet — a request would be refused as NO_SHEET_MATCH");
      process.exitCode = 1;
    } else {
      console.log(`  referral link : ${row.referral_link || "(blank)"}`);
      console.log(`  discount code : ${row.discount_code || "(blank)"}`);
    }
  }
  if (refused.length) process.exitCode = 1;
})();
