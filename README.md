# Handout Generator

Generates branded clinic handout PDFs from HTML templates. Doctors submit a
form with their clinic name, logo, and brand color; the service merges those
into the MediSkill at-home ozone therapy handouts and renders print-ready,
two-page PDFs.

Seven handouts are built and verified:

    Autoimmune Conditions
    Chronic Fatigue
    Dental & Gum Infections
    Joint Pain & Arthritis
    Performance, Recovery & Healthy Aging
    SIBO & Gut Dysbiosis
    Supportive Cancer Care

## Run locally

    npm install        # first run downloads Puppeteer's Chrome (a few minutes)
    npm start          # http://localhost:3000

PDFs land in /output and download links appear on the form page.

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
    templates/*.html        Content only. No styling.

Every color in _base.css derives from var(--brand). Nothing is hardcoded.

To add handout #8:

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

## Notes on typography

_base.css pulls Figtree from Google Fonts, with a Helvetica/Arial fallback.
render.js waits up to 3 seconds for the webfont and then renders regardless,
so a blocked or slow font request degrades to the fallback instead of
hanging a batch job. To lock typography down completely, self-host a woff2
and swap the @import for an @font-face rule with a base64 src.

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
