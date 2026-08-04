# Connecting the tracking sheet

The sheet is the source of truth for referral links and discount codes. Both are
created by hand per practitioner — a shortened company name, usually — so no API
can derive them. The doctor supplies only their email; this service maps that
email to their link and code.

If the sheet is unreachable or the row is incomplete, **no handout is generated**.
That is deliberate: a blank code or a dead QR code printed for a waiting room
full of patients is worse than a queued exception.

Two ways to connect it. Use a service account.

---

## Service account (recommended)

Keeps the sheet private. Nothing is published, and access can be revoked by
un-sharing one address.

### 1. Enable the API

1. console.cloud.google.com → create a project (or pick an existing one)
2. **APIs & Services → Library** → search *Google Sheets API* → **Enable**

Skipping this gives `HTTP 403 SERVICE_DISABLED` later, which reads like a
permissions problem but isn't.

### 2. Create the service account

1. **IAM & Admin → Service Accounts → Create service account**
2. Any name, e.g. `handout-generator`
3. **Skip the optional roles** — project roles grant nothing here. Access comes
   from sharing the sheet in step 4.
4. Open it → **Keys → Add key → Create new key → JSON** → a file downloads

That JSON is a credential. Keep it out of the repo; `.gitignore` already covers
`.env`.

### 3. Pull the two values out of the JSON

You need `client_email` and `private_key`. Rather than copying the key by hand —
it is ~1700 characters and one stray newline breaks the signature — write it
straight into `.env`:

```bash
node -e 'const j=require(process.argv[1]);require("fs").appendFileSync(".env","\nSHEETS_SA_EMAIL="+j.client_email+"\nSHEETS_SA_PRIVATE_KEY=\""+j.private_key.replace(/\n/g,"\\n")+"\"\n");console.log("wrote credentials for "+j.client_email)' ~/Downloads/your-key-file.json
```

The private key is stored with `\n` escapes on a single line, which is what the
code expects (`sheets.js` converts them back). Real newlines work too, so
pasting the multi-line key into a Railway variable box is also fine.

### 4. Share the sheet — the step everyone misses

Open the tracking sheet → **Share** → paste the `client_email` address
(`something@project.iam.gserviceaccount.com`) → **Viewer** → Send.

Without this the API returns `HTTP 403` even though everything else is correct.
The service account is a separate identity; it cannot see your files just
because you can.

### 5. Sheet ID and tab name

The ID is the long segment in the sheet URL:

```
docs.google.com/spreadsheets/d/1AbC...XyZ/edit#gid=0
                              ^^^^^^^^^^^^
```

```
SHEETS_SPREADSHEET_ID=1AbC...XyZ
SHEETS_RANGE=Sheet1!A:Z
```

**Change `Sheet1` to the actual tab name.** A wrong tab name returns
`HTTP 400 Unable to parse range` — the most common failure after forgetting to
share. If the tab name contains spaces, quote it: `'Pro Program'!A:Z`.

### 6. Verify

```bash
npm run check:sheet
```

It prints the column mapping and how many rows would generate cleanly:

```
Read 98 practitioner row(s).

Column mapping:
  email          col  3  "Email"
  referralLink   col  7  "shopify_link"
  discountCode   col  6  "affiliate_code"

98/98 row(s) would generate cleanly.
```

Then check one practitioner end to end, and optionally every link:

```bash
npm run check:sheet -- doc@clinic.com
npm run check:sheet -- --links
```

`--links` paces itself on purpose: a burst of requests trips Shopify's rate
limiter, which looks exactly like a broken link.

---

## Published CSV (testing only)

Simpler, but **publishing exports every practitioner email to anyone with the
URL**. Do not use it for the real sheet.

File → Share → Publish to web → CSV, then:

```
SHEETS_MODE=csv_url
SHEETS_CSV_URL=https://docs.google.com/.../pub?output=csv
```

A local file path works too, which is what makes offline testing possible:

```
SHEETS_CSV_URL=./local/affiliates.csv
```

---

## Column names

Matched by heading name, not position, so reordering or inserting columns is
safe. Defaults cover the current export:

| Field | Headings tried |
|---|---|
| email | `email`, `practitioner email`, `contact email` |
| referral link | `shopify_link`, `shopify link`, `referral link`, `referral url`, `affiliate link`, `affiliate url` |
| discount code | `affiliate_code`, `affiliate code`, `discount code`, `coupon code`, `coupon`, `code` |
| discount size | `affiliate_group (%=discount)`, `affiliate_group`, `affiliate group`, `discount percent`, `discount %` |

Matching is case- and space-insensitive, exact first, then "contains" — so
`Referral Link (live)` still resolves. Override with `SHEETS_COL_EMAIL`,
`SHEETS_COL_REFERRAL`, `SHEETS_COL_CODE` if your headings differ.

### How the discount is decided

The percentage comes from the affiliate group label, not from a constant:

| Group | Prints |
|---|---|
| `Pro Program - Share (10%)` | "use code `doctormulders` to save 10%" |
| `Pro Program - Give (25%)` | "use code `poppcs` to save 25%" |
| `Pro Program - Earn (0%)` | **no code at all** — "Go to <link> to order the Stratus 3.0 Complete Kit." |

So a 0% practitioner is complete *without* a discount code, and requiring one
would wrongly refuse them. If the group cell holds no percentage at all, an
existing code still prints but without a figure ("to save"), which is the
wording the handouts used before percentages were read from the sheet.

Change a practitioner's group in the sheet and their next handout follows it —
nothing to redeploy.

Three behaviours worth knowing:

- **Last match wins.** A corrected duplicate further down the sheet takes
  precedence over an earlier row.
- **A blank link is always refused.** A blank code is refused *unless* the group
  is 0%. `check:sheet` finds both before a doctor does.
- **0 and "unknown" are different.** 0% means no discount; a missing percentage
  means we could not tell, and the code still prints.

---

## Where these go

**Locally** — a `.env` file in the repo root. `npm start`, `npm run check:sheet`
and `npm run check:ac` load it natively (`--env-file-if-exists`), so no dotenv
dependency. The file is gitignored.

**On Railway** — the **Variables** tab. Railway does not read `.env.example`;
nothing in that file is applied anywhere. Paste each variable in, then redeploy.

Confirm what a running instance actually has:

```bash
curl -s https://your-app.up.railway.app/health
```

```json
{"ok":true,"storage":"local","sheet":"configured",
 "activecampaign":"not configured","handouts":8}
```

`sheet: configured` means the variables are present — `check:sheet` is what
proves the sheet is readable and the rows are usable.

---

## The rest of the setup

- **ActiveCampaign** — API key, two custom fields, and an automation triggered by
  the `handout-ready` tag, set to run **multiple times**. Verify with
  `npm run check:ac`. See the README.
- **Webhook** — set `WEBHOOK_SECRET` (`openssl rand -hex 32`) and send it in the
  `x-handout-secret` header. Until it is set, `/handout/*` rejects everything.
- **Storage** — set `R2_*` for production. Without it PDFs live on local disk,
  and Railway wipes that on every redeploy, breaking links already sent out.
