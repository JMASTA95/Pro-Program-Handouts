# Handout Generator

Generates branded clinic handout PDFs from HTML templates. Doctors submit a
form with their clinic name, logo, and brand color; the service merges those
into the MediSkill at-home ozone therapy handouts and renders print-ready,
two-page PDFs.

Eight handouts are built and verified:

    Autoimmune Conditions
    Chronic Fatigue
    CIRS & Mold Illness
    Dental & Gum Infections
    Joint Pain & Arthritis
    Performance, Recovery & Healthy Aging
    SIBO & Gut Dysbiosis
    Supportive Cancer Care

## Run locally

    npm install        # first run downloads Puppeteer's Chrome (a few minutes)
    npm start          # http://localhost:3000

PDFs land in /output and download links appear on the form page.

## Two ways in

    POST /generate            The doctor-facing form at /. Multi-select; the
                              download links come back to the page. Optionally
                              gated by ACCESS_KEY on the URL.

    POST /handout/generate    The webhook the public request form posts to.
                              Requires the shared secret in the
                              x-handout-secret header. Delivered by
                              ActiveCampaign, or by Zapier reading handout_url
                              out of the response (see ZAPIER.md).

    POST /handout/retry/:id   Replays a queued failure with its stored payload.
                              Body fields override it, so an operator can fix
                              the bad value as part of the retry.

Both go through lib/generate.js, so validation and the sheet lookup cannot
drift apart between them.

The request form needs four fields, and the names matter:

    email            matched against the tracking sheet
    practice_name    printed on the handout
    use_case         the handout id (see GET /api/templates)
    logo             file upload, optional

## Where the referral link and code come from

The doctor supplies their email; the referral link and discount code are looked
up from the tracking sheet. Both are created by hand per practitioner, so the
sheet is where that decision lives — no API can derive them.

    npm run check:sheet                     headers, row count, completeness
    npm run check:sheet -- doc@clinic.com   resolve one practitioner
    npm run check:sheet -- --links          confirm every link resolves

Typed values still win, so an operator can override during a retry.

## Guard rails

A printed handout is permanent, so each of these refuses the request rather
than degrading quietly:

    blank or missing code      refused; never printed blank
    code over 20 characters    refused; it breaks the badge layout
    scheme-less referral link  upgraded to https (the sheet records them
                               scheme-less), then checked
    link that does not resolve refused; never print a QR to a dead link
    429 / 5xx from the shop    backed off and retried once before refusing

Every refusal is appended to logs/exceptions.jsonl with its payload, so it can
be retried without re-keying anything. Monday and email notices are optional
on top of that.

## Delivery

    npm run check:ac      proves the two AC custom fields exist

On success the service writes the handout URL and the use case to the
contact's custom fields, then applies the handout-ready tag. An AC automation
triggered on that tag sends the email, so marketing can change the wording
without touching this repo.

Set the automation to run MULTIPLE TIMES. AC's "tag is added" trigger only
fires on a genuine transition, so the service removes the tag before
re-applying it — otherwise a doctor's second handout would never be emailed.

A multi-handout request from the form is delivered by the links on the page
instead: AC holds one URL per contact, and emailing one of the five they asked
for would be worse than emailing none.

## What gets customized

    Clinic name      masthead eyebrow + page footer on every page
    Logo             top right of page 1, normalized to a consistent box
    Brand color      ALL accent color: rules, section headings, card titles,
                     card fills, table headers, step markers, discount badge,
                     QR code, footer rule
    Referral link    the "how to get started" step + the QR code
    Discount code    the highlighted badge in the call-to-action

Only one color is requested from the doctor. lib/color.js mixes it with white
to produce the light card fill and the hairline rule tone, so any brand hex
yields a coherent palette instead of asking for three colors.

## How the templates work

    templates/_base.css     The entire design system. ONE place to change the
                            look of all handouts. Injected at render time.
                            Figtree is embedded as base64 by lib/fonts.js —
                            it used to be a Google Fonts @import, which meant
                            a blocked fetch silently produced a PDF in the
                            fallback face.
    templates/*.html        Content only. No styling.

Every color in _base.css derives from var(--brand). Nothing is hardcoded.

To add another handout:

1. Copy an existing template as a starting point.
2. Change the `<!-- label: ... -->` comment on line 1. That label is what
    doctors see on the form; the filename becomes the PDF name.
3. Replace the content blocks. Available components: `.head` section headings,
    `.cards` three-up grids (add `.evidence` for small-caps titles), `.note`
    footnote callouts, `.two` two-column blocks, `table.routes`, `ol.steps`.
4. Keep the `<div class="pb"></div>` marker where page 1 should end.
5. Run `npm run verify` before shipping it.

The form picks up new templates automatically. No code changes needed.

## Verify page fit

    npm run verify

Content length is what breaks these handouts. Adding two sentences can push
the call-to-action onto a third page, and nobody notices until a doctor
prints it. This measures each page against the usable page box and reports
the slack left. Current headroom is 0.2-0.9in on page 2, so edits have room
but not unlimited room.

## Deploy to Railway

1. Push this folder to a GitHub repo (private is fine).
2. Railway -> New Project -> Deploy from GitHub repo.
    Railway detects the Dockerfile and builds with system Chromium.
3. Settings -> Networking -> Generate Domain.
4. (Recommended) Variables -> add ACCESS_KEY=some-long-random-string.
    The form is then only reachable at
    https://your-app.up.railway.app/?key=some-long-random-string

## Connect Cloudflare R2 (required for production)

Railway wipes its disk on every redeploy, so deployed PDFs must go to R2.
Without R2 vars the app falls back to local storage (dev mode).

1. Cloudflare -> R2 -> Create bucket (e.g. simplyo3-handouts).
2. Bucket -> Settings -> Public access: enable the r2.dev subdomain, or
    connect a custom domain like files.simplyo3.com.
3. R2 -> Manage API Tokens -> create a token with Object Read & Write on
    that bucket.
4. Railway -> Variables:

       R2_ACCOUNT_ID=your_cloudflare_account_id
       R2_ACCESS_KEY_ID=xxxx
       R2_SECRET_ACCESS_KEY=xxxx
       R2_BUCKET=simplyo3-handouts
       R2_PUBLIC_URL=https://files.simplyo3.com

5. Redeploy, then check /health -> should report "storage": "r2".

## Environment variables

    PORT                    set by Railway automatically
    ACCESS_KEY              optional; gates the form behind ?key=...
    R2_ACCOUNT_ID           R2 mode activates when all five R2 vars are set
    R2_ACCESS_KEY_ID
    R2_SECRET_ACCESS_KEY
    R2_BUCKET
    R2_PUBLIC_URL
    PUPPETEER_EXECUTABLE_PATH   set by the Dockerfile; leave unset locally

## Next phase - GHL integration

Replace the built-in form with a GHL form + webhook: add a /webhook route
that accepts GHL's JSON payload, fetch the logo from the GHL file URL, look
up referral link and discount code by email, and write the finished R2 links
back to GHL custom fields so an automation can email the doctor.

## Delivery: ActiveCampaign or Zapier

Either, and the code is the same. With `AC_*` set, the service writes two custom
fields on the contact and applies the `handout-ready` tag for an automation to
act on. With `AC_*` unset, `/handout/generate` returns `handout_url` in its
response and whatever called it does the sending — see ZAPIER.md for that route,
which needs no ActiveCampaign account at all.

Set `SERVICE_BASE_URL` either way. Without it the returned URL is a relative
path, which is useless in an email.

Logos arrive one of two ways: a multipart upload (the built-in form) or a hosted
file URL via `logo_url` (what Zapier and the form builders hand over). URL
fetches refuse private and link-local addresses, cap the download, and re-check
every redirect hop, because that URL is untrusted input the server is about to
request.

## Notes on typography

Every glyph in a handout comes from a font embedded in the PDF. Nothing is
fetched at render time and nothing is taken from the host machine, so the file
a doctor receives is the file that was approved — on your laptop and in the
container alike.

`lib/fonts.js` inlines two faces as base64 `@font-face` rules:

    Figtree   latin, weights 400/500/600/700
    Inter     greek only, same weights, pinned by unicode-range

Inter is there because Figtree ships no Greek subset, and the marker names are
full of it — TGF-β1, TNF-α, NF-κB. Those three characters used to fall through
to Helvetica Neue on macOS and Liberation Sans in the container: the same code
producing visibly different clinical terms depending on where it ran. Declaring
Inter under the same family name with `unicode-range` confines it to Greek, so
templates and CSS need no knowledge of it.

For the same reason the marker grid uses `›` rather than `→`. U+2192 has no
glyph in either face and was the last character reaching for a host font.

If you add copy with an unusual character, check it before shipping — a
fallback is silent. Render a handout and look at what the PDF embedded:

```bash
strings output/<doctor>/<handout>.pdf | grep -oE "/BaseFont */[A-Za-z0-9+#-]+" | sort -u
```

Only `Figtree*` and `Inter*` should appear. Anything else is a character with no
glyph, and it will render differently in production than it does for you.

## Project structure

    server.js               Express: access gate, /generate, /health
    lib/render.js           Puppeteer HTML -> PDF, merging, QR, page footers
    lib/color.js            Derives the palette from one brand hex
    lib/logo.js             Logo normalization (sharp)
    lib/storage.js          R2 upload with local fallback
    templates/_base.css     Shared design system
    templates/*.html        Seven handouts, content only
    tools/verify-pages.js   Two-page fit checker (npm run verify)
    public/index.html       Doctor-facing form
    Dockerfile              Railway build with system Chromium
