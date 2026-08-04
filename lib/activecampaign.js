/**
 * activecampaign.js — the delivery handoff.
 *
 * This service writes two custom fields on the contact and applies the trigger
 * tag. The email itself is an ActiveCampaign automation keyed on that tag, so
 * marketing can change the wording without touching this codebase.
 *
 * AC addresses custom fields and tags by numeric id, not by name, so names are
 * resolved to ids once and cached for the process lifetime.
 */

const BASE_URL = (process.env.AC_BASE_URL || "").replace(/\/+$/, "").replace(/\/api\/3$/, "");
const API_KEY = process.env.AC_API_KEY || "";
const TIMEOUT_MS = Number(process.env.AC_TIMEOUT_MS || 15000);
const FIELD_URL = process.env.AC_FIELD_HANDOUT_URL || "HANDOUT_URL";
const FIELD_USE_CASE = process.env.AC_FIELD_HANDOUT_USE_CASE || "HANDOUT_USE_CASE";
const READY_TAG = process.env.AC_READY_TAG || "handout-ready";

const AC_ENABLED = Boolean(BASE_URL && API_KEY);

class AcError extends Error {
  constructor(message) {
    super(message);
    this.code = "AC_UPDATE_FAILED";
  }
}

let fieldIdCache = null;
let tagIdCache = {};

async function request(method, pathname, body, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${BASE_URL}/api/3${pathname}`, {
    method,
    headers: {
      "Api-Token": API_KEY,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const detail =
      (json && json.errors && json.errors.map((e) => e.title || e.detail).join("; ")) ||
      (json && json.message) ||
      (text || "").slice(0, 300);
    throw new AcError(`ActiveCampaign ${method} ${pathname} returned HTTP ${res.status}: ${detail}`);
  }
  return json;
}

/** All custom fields, paged. Used by the pre-flight check and by id resolution. */
async function listFields(opts) {
  const all = [];
  for (let offset = 0; offset < 500; offset += 100) {
    const json = await request("GET", `/fields?limit=100&offset=${offset}`, undefined, opts);
    const batch = (json && json.fields) || [];
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

const normName = (s) =>
  String(s == null ? "" : s)
    .toLowerCase()
    .replace(/^%|%$/g, "")
    .replace(/[\s_-]+/g, "");

async function fieldIds(opts) {
  if (fieldIdCache) return fieldIdCache;
  const fields = await listFields(opts);
  const find = (want) => {
    const target = normName(want);
    const match = fields.find((f) => normName(f.perstag) === target || normName(f.title) === target);
    return match ? String(match.id) : null;
  };
  const resolved = { handoutUrl: find(FIELD_URL), handoutUseCase: find(FIELD_USE_CASE) };
  const missing = Object.entries(resolved)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    throw new AcError(
      `ActiveCampaign has no custom field for ${missing.join(" and ")}. Looked for ` +
        `${FIELD_URL} / ${FIELD_USE_CASE}. Create them in AC, or set AC_FIELD_* to the real ` +
        `personalisation tags (npm run check:ac).`
    );
  }
  fieldIdCache = resolved;
  return resolved;
}

async function tagId(name, opts) {
  if (tagIdCache[name]) return tagIdCache[name];
  const search = async () => {
    const json = await request("GET", `/tags?search=${encodeURIComponent(name)}&limit=100`, undefined, opts);
    return ((json && json.tags) || []).find((t) => String(t.tag).toLowerCase().trim() === name.toLowerCase().trim());
  };
  let match = await search();
  if (!match) {
    const created = await request("POST", "/tags", { tag: { tag: name, tagType: "contact" } }, opts).catch(() => null);
    match = (created && created.tag) || (await search());
  }
  if (!match) throw new AcError(`Could not find or create the AC tag "${name}".`);
  tagIdCache[name] = String(match.id);
  return tagIdCache[name];
}

async function listTags(opts) {
  const json = await request("GET", "/tags?limit=100", undefined, opts);
  return (json && json.tags) || [];
}

/**
 * contact/sync upserts by email, so this works whether or not the practitioner
 * is already a contact, and writes both custom fields in the same call.
 */
async function upsertContact({ email, companyName, handoutUrl, useCase }, opts) {
  const ids = await fieldIds(opts);
  const contact = {
    email,
    fieldValues: [
      { field: ids.handoutUrl, value: handoutUrl },
      { field: ids.handoutUseCase, value: useCase },
    ],
  };
  if (companyName) contact.orgname = companyName;
  const json = await request("POST", "/contact/sync", { contact }, opts);
  const id = json && json.contact && json.contact.id ? String(json.contact.id) : null;
  if (!id) throw new AcError(`AC contact/sync for ${email} returned no contact id.`);
  return id;
}

async function listContactTags(contactId, opts) {
  const json = await request("GET", `/contacts/${contactId}/contactTags`, undefined, opts);
  return (json && json.contactTags) || [];
}

/**
 * Re-applies the trigger tag rather than just adding it.
 *
 * AC's "tag is added" trigger only fires on a genuine transition, and adding a
 * tag a contact already has is a no-op. A practitioner requesting a second
 * handout would therefore never get a second email. Removing first guarantees
 * the transition, so the automation fires on every request.
 */
async function applyReadyTag(contactId, opts) {
  const id = await tagId(READY_TAG, opts);
  const existing = await listContactTags(contactId, opts).catch(() => []);
  const stale = existing.filter((ct) => String(ct.tag) === String(id));
  for (const ct of stale) {
    await request("DELETE", `/contactTags/${ct.id}`, undefined, opts).catch(() => {});
  }
  await request("POST", "/contactTags", { contactTag: { contact: contactId, tag: id } }, opts);
  return { tag: READY_TAG, reapplied: stale.length > 0 };
}

/** Writes the fields, then applies the tag the delivery automation triggers on. */
async function deliver({ email, companyName, handoutUrl, useCase }, opts) {
  const contactId = await upsertContact({ email, companyName, handoutUrl, useCase }, opts);
  const tagged = await applyReadyTag(contactId, opts);
  return { contactId, ...tagged };
}

module.exports = { deliver, listFields, listTags, AC_ENABLED, AcError, FIELD_URL, FIELD_USE_CASE, READY_TAG, BASE_URL };
