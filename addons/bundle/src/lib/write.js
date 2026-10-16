"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { writeZip } = require("./zip-writer");
const { writeTarGz } = require("./tar-writer");

function archiveEntries(plan) {
  const reproducible = plan.options.reproducible;
  return plan.files.map((file) => ({
    name: plan.rootFolder ? `${plan.rootFolder}/${file.rel}` : file.rel,
    abs: file.abs,
    mode: reproducible ? (file.mode & 0o111 ? 0o755 : 0o644) : file.mode & 0o777,
    mtime: reproducible ? plan.mtime : new Date(file.mtimeMs),
  }));
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// Writes the archive next to its final name first, then moves it into place.
async function writeArchive(plan) {
  const entries = archiveEntries(plan);
  fs.mkdirSync(path.dirname(plan.outPath), { recursive: true });
  const part = `${plan.outPath}.part`;
  try {
    if (plan.format === "zip") {
      writeZip(entries, part);
    } else {
      await writeTarGz(entries, part);
    }
    fs.rmSync(plan.outPath, { force: true });
    fs.renameSync(part, plan.outPath);
  } catch (err) {
    fs.rmSync(part, { force: true });
    throw err;
  }
  return { size: fs.statSync(plan.outPath).size, sha256: sha256File(plan.outPath) };
}

module.exports = { writeArchive, archiveEntries };
