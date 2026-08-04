# Delivering handouts with Zapier (no ActiveCampaign)

ActiveCampaign is optional. Leave `AC_*` unset and `/handout/generate` returns
the finished handout link in its own response, which is what a Zap consumes.

    Form submission  →  Zapier  →  POST /handout/generate  →  email step
                                   (returns handout_url)

Nothing in the service changes between the two approaches. `/health` will report
`activecampaign: "not configured"`, which is correct rather than a warning.

---

## What the service needs

Two variables, on Railway:

```
WEBHOOK_SECRET=<openssl rand -hex 32>
SERVICE_BASE_URL=https://your-app.up.railway.app
```

`SERVICE_BASE_URL` matters here. Without it the response carries a relative path
(`/output/…`), which is useless inside an email. With it you get a full URL.

---

## The Zap

### Step 1 — Trigger: your form

Any form Zapier supports. The submission needs to carry:

| Field | Required | Notes |
|---|---|---|
| email | yes | must match the tracking sheet |
| practice name | yes | prints on the handout |
| handout | yes | the template slug — see `/api/templates` |
| logo | yes | a file upload |
| brand colour | no | defaults to the house blue |

### Step 2 — Action: Webhooks by Zapier → Custom Request

- **Method** `POST`
- **URL** `https://your-app.up.railway.app/handout/generate`
- **Data Pass-Through?** `no`
- **Headers**

      x-handout-secret: <the same value as WEBHOOK_SECRET>
      content-type: application/json

- **Data**

      {
        "email": "{{email from step 1}}",
        "practice_name": "{{practice name from step 1}}",
        "use_case": "cirs-mold-illness",
        "logo_url": "{{logo file URL from step 1}}"
      }

Two things to get right:

**Map the logo's URL, not the file.** Zapier exposes an uploaded file as a
hosted link; that is what `logo_url` wants. The service downloads it, normalizes
it to a 600×300 PNG and embeds it. (A direct multipart upload still works too,
which is what the built-in form at `/` uses.)

**`use_case` is a slug, not a label.** `GET /api/templates` lists them:

    autoimmune-conditions            chronic-fatigue
    cirs-mold-illness                dental-gum-infections
    joint-pain-arthritis             performance-recovery-healthy-aging
    sibo-gut-dysbiosis               supportive-cancer-care

If the form asks the doctor to pick a condition in plain language, map the label
to the slug in the form's own option values, or add a Formatter step.

### Step 3 — Action: send the email

Gmail, Outlook, ActiveCampaign, whatever you already use. The fields from step 2
are available:

| Field | Example |
|---|---|
| `handout_url` | `https://…/output/drmulders_gmail_com/cirs-mold-illness.pdf` |
| `company_name` | `Mulders Integrative Health` |
| `referral__discount_code` | `doctormulders` |
| `referral__discount_percent` | `10` |
| `handout_count` | `1` |

**Attach the file if your email step allows it.** Gmail's *Attachments* field
accepts a URL, so pass `handout_url` there and the practitioner receives the PDF
itself. That is worth doing: PDFs are stored on Railway's disk, which is wiped on
every redeploy, so a link opened a week later can 404. An attachment cannot.

---

## Response shape

Success, HTTP 200:

```json
{
  "ok": true,
  "handout_url": "https://…/cirs-mold-illness.pdf",
  "handout_urls": "https://…/cirs-mold-illness.pdf",
  "handout_count": 1,
  "company_name": "Mulders Integrative Health",
  "referral": {
    "source": "sheet",
    "link_check": { "checked": true, "status": 301 },
    "discount_percent": 10,
    "discount_code": "doctormulders"
  },
  "delivery": { "attempted": false, "reason": "ActiveCampaign not configured" },
  "files": [{ "template": "cirs-mold-illness", "url": "https://…" }]
}
```

`delivery.attempted: false` is expected — Zapier is doing the delivering.

Failure, HTTP 4xx, with a code you can branch on:

| HTTP | code | Means |
|---|---|---|
| 401 | — | secret missing or wrong |
| 400 | `BAD_PAYLOAD` | no handout selected, bad email |
| 400 | `UNKNOWN_TEMPLATE` | `use_case` is not a real slug |
| 400 | `BAD_LOGO` | logo URL unreachable, too big, or not an image |
| 422 | `NO_SHEET_MATCH` | that email is not in the tracking sheet |
| 422 | `SHEET_INCOMPLETE` | row exists but has no referral link or code |
| 422 | `LINK_UNREACHABLE` | the referral link does not resolve |

Zapier treats any 4xx or 5xx as a step failure and stops the Zap, so a broken
submission never sends a half-finished email. Every 422 also lands in the
exception queue (`logs/exceptions.jsonl`) with a retry link.

Worth a Zap of its own: watch for failures and post them somewhere you'll see.

---

## Requesting several handouts at once

Send `handouts` as an array instead of `use_case`:

```json
{ "email": "…", "practice_name": "…", "handouts": ["cirs-mold-illness", "sibo-gut-dysbiosis"] }
```

`handout_urls` then holds a comma-separated list and `handout_url` is `null` —
one link cannot represent five files. Use `handout_urls` in the email, or fan out
over `files`.

---

## Testing before the form exists

```bash
curl -X POST https://your-app.up.railway.app/handout/generate \
  -H "content-type: application/json" \
  -H "x-handout-secret: $WEBHOOK_SECRET" \
  -d '{
    "email": "a-real-address-from-the-sheet@example.com",
    "practice_name": "Test Clinic",
    "use_case": "cirs-mold-illness",
    "logo_url": "https://placehold.co/600x300/png"
  }'
```

The email must exist in the tracking sheet — the referral link and discount code
come from there, and the service refuses to invent them.

---

## Why the secret is a header, not a URL parameter

The webhook writes files and reads the tracking sheet, so it is not public. A
secret in a query string ends up in server logs, browser history and referrer
headers; a header does not. Zapier stores headers per action and does not display
them in run history.

Never put `WEBHOOK_SECRET` in anything a browser loads. The built-in form at `/`
is separate and uses `ACCESS_KEY` for that reason.
