/**
 * storage.js — where generated PDFs live.
 *
 * Two modes, controlled by environment variables:
 *
 *   R2 mode (production): set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
 *     R2_SECRET_ACCESS_KEY, R2_BUCKET, and R2_PUBLIC_URL.
 *     PDFs upload to Cloudflare R2 and the returned links are permanent.
 *
 *   Local mode (development): no R2 vars set. PDFs stay in /output and
 *     are served by Express. Fine on your laptop; on Railway these
 *     disappear on every redeploy, so use R2 there.
 *
 * R2 is S3-compatible, so this uses the standard AWS SDK.
 */

const fs = require("fs");
const path = require("path");

const R2_ENABLED = !!(
  process.env.R2_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  process.env.R2_BUCKET
);

let s3Client = null;

function getClient() {
  if (!s3Client) {
    const { S3Client } = require("@aws-sdk/client-s3");
    s3Client = new S3Client({
      region: "auto",
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return s3Client;
}

/**
 * Stores a generated PDF and returns a URL the doctor can use.
 * @param {string} localPath - path to the PDF on disk
 * @param {string} doctorKey - sanitized email, used as the folder
 * @returns {string} public URL (R2) or local path (dev)
 */
async function storePdf(localPath, doctorKey) {
  const filename = path.basename(localPath);

  if (!R2_ENABLED) {
    // Local dev: file already sits in /output, Express serves it
    return `/output/${doctorKey}/${filename}`;
  }

  const { PutObjectCommand } = require("@aws-sdk/client-s3");
  const key = `${doctorKey}/${filename}`;

  await getClient().send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: fs.readFileSync(localPath),
      ContentType: "application/pdf",
      // Lets the browser open it inline instead of forcing a download
      ContentDisposition: `inline; filename="${filename}"`,
    })
  );

  // R2_PUBLIC_URL is your bucket's public domain,
  // e.g. https://files.simplyo3.com or the r2.dev URL
  const base = (process.env.R2_PUBLIC_URL || "").replace(/\/$/, "");
  return `${base}/${key}`;
}

module.exports = { storePdf, R2_ENABLED };
