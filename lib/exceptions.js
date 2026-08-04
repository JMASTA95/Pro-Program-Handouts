/**
 * exceptions.js — where failures go so a human can act on them.
 *
 * Every failure is appended to logs/exceptions.jsonl first and unconditionally,
 * with the full payload. Monday and email are best-effort on top of that, so an
 * outage in either degrades the queue without losing anything.
 *
 * The stored payload is what makes a retry possible without re-keying anything.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const LOG_DIR = path.join(__dirname, "..", "logs");
const LOG_FILE = process.env.EXCEPTION_LOCAL_FILE || path.join(LOG_DIR, "exceptions.jsonl");
const PAYLOAD_DIR = path.join(path.dirname(LOG_FILE), "payloads");

const MONDAY_KEY = process.env.MONDAY_API_KEY || "";
const MONDAY_BOARD = process.env.MONDAY_EXCEPTION_BOARD_ID || "";
const MONDAY_GROUP = process.env.MONDAY_EXCEPTION_GROUP_ID || "";
const MONDAY_COLS = {
  reason: process.env.MONDAY_COL_REASON || "text_reason",
  email: process.env.MONDAY_COL_EMAIL || "text_email",
  slug: process.env.MONDAY_COL_SLUG || "text_slug",
  payload: process.env.MONDAY_COL_PAYLOAD || "long_text_payload",
  retry: process.env.MONDAY_COL_RETRY || "long_text_retry",
  source: process.env.MONDAY_COL_SOURCE || "text_source",
};

const NOTIFY_EMAIL = process.env.EXCEPTION_NOTIFY_EMAIL || "";
const FROM_EMAIL = process.env.EXCEPTION_FROM_EMAIL || "no-reply@localhost";
const SMTP_HOST = process.env.SMTP_HOST || "";
const SERVICE_BASE_URL = (process.env.SERVICE_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const SECRET_HEADER = (process.env.WEBHOOK_SECRET_HEADER || "x-handout-secret").toLowerCase();

async function pushToMonday(record, fetchImpl = fetch) {
  if (!MONDAY_KEY || !MONDAY_BOARD) return { pushed: false, skipped: "monday not configured" };

  const columnValues = {
    [MONDAY_COLS.reason]: `${record.code}: ${record.reason}`.slice(0, 2000),
    [MONDAY_COLS.email]: record.email || "",
    [MONDAY_COLS.slug]: record.use_case || "",
    [MONDAY_COLS.source]: record.source || "",
    [MONDAY_COLS.payload]: { text: JSON.stringify(record.payload).slice(0, 1900) },
    [MONDAY_COLS.retry]: { text: `${record.retry.link}\n\n${record.retry.command}`.slice(0, 1900) },
  };
  const query = `
    mutation ($boardId: ID!, $groupId: String, $name: String!, $vals: JSON!) {
      create_item(board_id: $boardId, group_id: $groupId, item_name: $name, column_values: $vals) { id }
    }`;
  const res = await fetchImpl("https://api.monday.com/v2", {
    method: "POST",
    headers: { authorization: MONDAY_KEY, "content-type": "application/json", "api-version": "2023-10" },
    body: JSON.stringify({
      query,
      variables: {
        boardId: String(MONDAY_BOARD),
        groupId: MONDAY_GROUP || null,
        name: `Handout failed — ${record.email || "unknown"} (${record.use_case || "no slug"})`,
        vals: JSON.stringify(columnValues),
      },
    }),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || (json && json.errors)) {
    throw new Error(`Monday returned HTTP ${res.status} ${JSON.stringify((json && json.errors) || json).slice(0, 300)}`);
  }
  return { pushed: true, itemId: (json && json.data && json.data.create_item && json.data.create_item.id) || null };
}

async function sendEmail(record, mailer) {
  if (!mailer && (!SMTP_HOST || !NOTIFY_EMAIL)) {
    return { sent: false, skipped: "smtp or notify address not configured" };
  }
  let transport = mailer;
  if (!transport) {
    // Optional dependency: only required when SMTP is actually configured.
    const nodemailer = require("nodemailer");
    transport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || "false").toLowerCase() === "true",
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }
  const lines = [
    "A handout generation failed and needs a human.",
    "",
    `Exception ID : ${record.exception_id}`,
    `Reason code  : ${record.code}`,
    `Reason       : ${record.reason}`,
    `Practitioner : ${record.email || "(none)"}`,
    `Handout      : ${record.use_case || "(none)"}`,
    `Source       : ${record.source}`,
    `When         : ${record.ts}`,
    "",
    "Retry (needs the webhook secret):",
    record.retry.command,
    "",
    "Payload:",
    JSON.stringify(record.payload, null, 2),
  ];
  await transport.sendMail({
    from: FROM_EMAIL,
    to: NOTIFY_EMAIL,
    subject: `[Handout exception] ${record.code} — ${record.email || "unknown"}`,
    text: lines.join("\n"),
  });
  return { sent: true };
}

/**
 * Records an exception. Never throws: the caller is already on a failure path and
 * the original reason has to survive to the HTTP response.
 */
async function record({ payload = {}, code, reason, source = "unknown", fetchImpl, mailer } = {}) {
  const exceptionId = crypto.randomUUID();
  const retryLink = `${SERVICE_BASE_URL}/handout/retry/${exceptionId}`;
  const entry = {
    exception_id: exceptionId,
    ts: new Date().toISOString(),
    code,
    reason,
    source,
    email: payload.email || "",
    use_case: payload.use_case || (Array.isArray(payload.handouts) ? payload.handouts.join(",") : ""),
    payload,
    retry: {
      link: retryLink,
      command: `curl -X POST ${retryLink} -H "${SECRET_HEADER}: $WEBHOOK_SECRET"`,
    },
  };

  const outcome = { exception_id: exceptionId, local: false, monday: null, email: null };
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`);
    fs.mkdirSync(PAYLOAD_DIR, { recursive: true });
    fs.writeFileSync(path.join(PAYLOAD_DIR, `${exceptionId}.json`), JSON.stringify(entry, null, 2));
    outcome.local = true;
  } catch (err) {
    console.error("[exception] could not write the local record:", err.message);
  }
  try {
    outcome.monday = await pushToMonday(entry, fetchImpl);
  } catch (err) {
    outcome.monday = { pushed: false, error: err.message };
    console.error("[exception] Monday push failed:", err.message);
  }
  try {
    outcome.email = await sendEmail(entry, mailer);
  } catch (err) {
    outcome.email = { sent: false, error: err.message };
    console.error("[exception] notification email failed:", err.message);
  }

  console.error(`[exception] ${code} ${entry.email} ${entry.use_case} → ${exceptionId}`);
  return outcome;
}

/** Loads a queued payload back so a failure can be retried without re-keying. */
function loadPayload(exceptionId) {
  const file = path.join(PAYLOAD_DIR, `${String(exceptionId).replace(/[^a-f0-9-]/gi, "")}.json`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

module.exports = { record, loadPayload };
