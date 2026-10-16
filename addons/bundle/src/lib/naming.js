"use strict";

const path = require("path");

const FORMATS = {
  zip: { id: "zip", ext: ".zip" },
  "tar.gz": { id: "tar.gz", ext: ".tar.gz" },
};

function formatFromName(file) {
  const lower = file.toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar.gz";
  return null;
}

function normalizeFormat(format) {
  return format === "tgz" ? "tar.gz" : format;
}

// The extension decides, --format overrides; they may not disagree.
function resolveFormat(out, format) {
  const wanted = format ? normalizeFormat(format) : null;
  const fromName = out ? formatFromName(out) : null;
  if (wanted && fromName && wanted !== fromName) {
    throw new Error(`--format ${wanted} does not match the extension of ${out}.`);
  }
  if (wanted) return wanted;
  if (fromName) return fromName;
  if (out) {
    throw new Error(`Can't tell the archive format from "${out}". End it in .zip, .tar.gz or .tgz, or pass --format.`);
  }
  return "zip";
}

function safeSegment(text) {
  return String(text)
    .replace(/[^A-Za-z0-9._@+-]+/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/-+$/, "");
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function defaultName(folder, name) {
  return safeSegment(name || path.basename(path.resolve(folder))) || "bundle";
}

function defaultFileName({ folder, name, version, date, format }) {
  const base = defaultName(folder, name);
  const tag = safeSegment(version || "") || formatDate(date);
  return `${base}-${tag}${FORMATS[format].ext}`;
}

module.exports = { resolveFormat, formatFromName, defaultName, defaultFileName, safeSegment, formatDate };
