/**
 * logo.js — normalizes whatever logo a doctor supplies into a predictable PNG
 * data URI that behaves inside the templates.
 *
 * Handles: oversized files, odd aspect ratios, JPG/PNG/WebP inputs.
 * Output: PNG, max 600x300, aspect ratio preserved, transparent padding.
 *
 * Two intake paths, because the form and the automation differ:
 *   normalizeLogo(pathOrBuffer)   a multipart upload from the built-in form
 *   normalizeLogoFromUrl(url)     a hosted file, which is what Zapier and the
 *                                 form builders hand over instead of bytes
 */

const dns = require("node:dns").promises;
const net = require("node:net");
const sharp = require("sharp");

const MAX_BYTES = Number(process.env.LOGO_MAX_BYTES || 10 * 1024 * 1024);
const FETCH_TIMEOUT_MS = Number(process.env.LOGO_FETCH_TIMEOUT_MS || 15000);
const MAX_REDIRECTS = 3;

class LogoError extends Error {
  constructor(message) {
    super(message);
    this.code = "BAD_LOGO";
  }
}

/**
 * Private, loopback, link-local and unique-local addresses.
 *
 * The URL comes from a form submission, so it is untrusted input that this
 * server is about to request. Without this check a submitted logo_url of
 * http://169.254.169.254/... or http://localhost:3000/ would make the service
 * fetch its own network on a stranger's behalf.
 */
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier NAT
    return false;
  }
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (v6 === "::1" || v6 === "::") return true;
  if (/^f[cd]/.test(v6)) return true; // unique local
  if (v6.startsWith("fe80")) return true; // link local
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return false;
}

async function assertPublicHost(rawHostname) {
  // URL.hostname keeps the brackets on an IPv6 literal, which net.isIP rejects.
  const hostname = rawHostname.replace(/^\[|\]$/g, "");
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new LogoError(`Refusing to fetch a logo from a private address (${hostname}).`);
    }
    return;
  }
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new LogoError(`Could not resolve the logo host "${hostname}".`);
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new LogoError(`Refusing to fetch a logo from a private address (${hostname} → ${address}).`);
    }
  }
}

/**
 * Downloads a logo, following redirects manually so every hop is re-checked —
 * a public URL that redirects to an internal one would otherwise slip through.
 */
async function downloadLogo(rawUrl, depth = 0) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new LogoError(`"${rawUrl}" is not a valid logo URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new LogoError(`Logo URLs must be http or https, got "${url.protocol}".`);
  }
  await assertPublicHost(url.hostname);

  const res = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }).catch((err) => {
    throw new LogoError(`Could not download the logo: ${err.message}`);
  });

  if ([301, 302, 303, 307, 308].includes(res.status)) {
    const location = res.headers.get("location");
    if (!location) throw new LogoError(`Logo URL returned ${res.status} with no location header.`);
    if (depth >= MAX_REDIRECTS) throw new LogoError("Logo URL redirected too many times.");
    return downloadLogo(new URL(location, url).toString(), depth + 1);
  }
  if (!res.ok) {
    throw new LogoError(`Logo URL returned HTTP ${res.status}. Check the file is publicly readable.`);
  }

  const declared = Number(res.headers.get("content-length") || 0);
  if (declared && declared > MAX_BYTES) {
    throw new LogoError(`Logo is ${Math.round(declared / 1024)}KB; the limit is ${Math.round(MAX_BYTES / 1024)}KB.`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new LogoError("The logo URL returned an empty file.");
  if (buffer.length > MAX_BYTES) {
    throw new LogoError(`Logo is ${Math.round(buffer.length / 1024)}KB; the limit is ${Math.round(MAX_BYTES / 1024)}KB.`);
  }
  return buffer;
}

/** @param {string|Buffer} input a file path or the file's bytes */
async function normalizeLogo(input) {
  let buffer;
  try {
    buffer = await sharp(input)
      .resize(600, 300, {
        fit: "inside", // never crop, never distort
        withoutEnlargement: true, // don't upscale tiny logos
      })
      .png()
      .toBuffer();
  } catch (err) {
    // sharp's own message ("unsupported image format") is more useful than a
    // generic failure, but it needs the code so the route answers 4xx not 500.
    throw new LogoError(`That logo could not be read as an image: ${err.message}`);
  }
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

async function normalizeLogoFromUrl(url) {
  return normalizeLogo(await downloadLogo(url));
}

module.exports = { normalizeLogo, normalizeLogoFromUrl, LogoError, isPrivateAddress };
