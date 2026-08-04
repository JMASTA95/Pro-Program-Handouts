/**
 * check-ac.js — pre-flight for the ActiveCampaign handoff.
 *
 *   npm run check:ac
 *
 * AC addresses custom fields by numeric id, not by name, so this is the step
 * that proves the delivery handoff will land before anything is deployed.
 */

const ac = require("../lib/activecampaign");

(async () => {
  if (!ac.AC_ENABLED) {
    console.error("AC_BASE_URL and AC_API_KEY must be set.");
    console.error("AC_BASE_URL looks like https://youraccount.api-us1.com (Settings > Developer).");
    process.exit(2);
  }

  let fields;
  try {
    fields = await ac.listFields();
  } catch (err) {
    console.error(`Could not read custom fields: ${err.message}`);
    process.exit(2);
  }

  console.log(`\n${ac.BASE_URL} — ${fields.length} custom field(s) found.\n`);

  const norm = (s) => String(s == null ? "" : s).toLowerCase().replace(/^%|%$/g, "").replace(/[\s_-]+/g, "");
  const wanted = [
    ["handout_url", ac.FIELD_URL],
    ["handout_use_case", ac.FIELD_USE_CASE],
  ];

  const missing = [];
  for (const [label, configured] of wanted) {
    const match = fields.find((f) => norm(f.perstag) === norm(configured) || norm(f.title) === norm(configured));
    if (match) {
      console.log(`  OK      ${label}`);
      console.log(`          AC field id     : ${match.id}`);
      console.log(`          personalisation : %${match.perstag}%`);
      console.log(`          title / type    : ${match.title} (${match.type})\n`);
      if (match.type !== "text" && match.type !== "textarea") {
        console.log(`          NOTE: expected a text field; got "${match.type}". A URL needs text.\n`);
      }
    } else {
      missing.push([label, configured]);
      console.log(`  MISSING ${label} (looked for "${configured}")\n`);
    }
  }

  if (missing.length) {
    console.error("Create these in AC (Contacts > Fields) as single-line text fields:");
    for (const [label, configured] of missing) console.error(`  - ${label}: personalisation tag %${configured}%`);
    console.error("\nOr point AC_FIELD_HANDOUT_URL / AC_FIELD_HANDOUT_USE_CASE at existing fields.");
    console.error("\nExisting text fields:");
    for (const f of fields.filter((x) => x.type === "text")) {
      console.error(`  %${f.perstag}%  ${f.title}  (id=${f.id})`);
    }
    process.exit(1);
  }

  try {
    const tags = await ac.listTags();
    const exists = tags.some((t) => String(t.tag).toLowerCase() === ac.READY_TAG.toLowerCase());
    console.log(
      `Trigger tag "${ac.READY_TAG}": ${exists ? "exists" : "does not exist yet — created on first use"}.`
    );
  } catch {
    console.log(`Could not list tags; "${ac.READY_TAG}" will be created on first use.`);
  }

  console.log("\nBuild the automation with trigger \"Tag is added\" on that tag, set to run");
  console.log(`MULTIPLE TIMES, and put %${ac.FIELD_URL}% in the email as the download link.`);
  console.log("\nAll required fields present.");
})();
