"use strict";

// Pulls the one executable out of a downloaded release asset. Like Rokit, sof keeps only that
// file: nothing else in the archive is written to disk, so an archive can't place files anywhere.

const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const { archiveFormat } = require("./assets");

// Entries that are never the tool.
const IGNORED_ENTRY_PATTERN = /(^|\/)(__macosx|\.ds_store)(\/|$)|\.(?:md|txt|sha\d*|sig|asc|json|toml|yml|yaml|html|pdf|png|svg)$|(^|\/)(license|licence|readme|changelog|notice|copying)[^/]*$/i;

// No tool is anywhere near this; the limit is only there so a hostile archive (a "zip bomb") can't
// make sof read gigabytes into memory.
const MAX_EXECUTABLE_BYTES = 1024 * 1024 * 1024;

function baseName(entryPath) {
  return path.posix.basename(String(entryPath).replace(/\\/g, "/"));
}

function stripExe(name) {
  return name.replace(/\.exe$/i, "").toLowerCase();
}

function readZipEntries(buffer, limit) {
  const AdmZip = require("adm-zip");
  return new AdmZip(buffer)
    .getEntries()
    .filter((entry) => !entry.isDirectory && entry.header.size <= limit)
    .map((entry) => ({
      path: entry.entryName,
      // Unix mode lives in the top 16 bits of the external attributes; zero when made on Windows.
      executable: ((entry.attr >>> 16) & 0o111) !== 0,
      read: () => entry.getData(),
    }));
}

function readTarEntries(buffer, limit) {
  const { Parser } = require("tar");
  return new Promise((resolve, reject) => {
    const entries = [];
    const parser = new Parser({ strict: false });

    parser.on("entry", (entry) => {
      if (entry.type !== "File" || entry.size > limit) {
        entry.resume();
        return;
      }

      const chunks = [];
      entry.on("data", (chunk) => chunks.push(chunk));
      entry.on("end", () => {
        const data = Buffer.concat(chunks);
        entries.push({ path: entry.path, executable: (entry.mode & 0o111) !== 0, read: () => data });
      });
    });
    parser.on("error", reject);
    parser.on("end", () => resolve(entries));
    parser.end(buffer);
  });
}

function tarProgram() {
  if (process.platform === "win32") {
    const system = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    if (fs.existsSync(system)) {
      return system;
    }
  }
  return "tar";
}

// Node can't read xz, so the system's tar does it (bsdtar ships with Windows 10+ and macOS, and
// nearly every Linux tar reads xz). Its output goes to a scratch folder that only we read from;
// tar itself refuses entries that point outside it, and symlinks are never followed.
function readTarXzEntries(buffer, limit) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sof-xz-"));
  try {
    const output = path.join(directory, "out");
    fs.writeFileSync(path.join(directory, "asset.tar.xz"), buffer);
    fs.mkdirSync(output);

    // Relative names, run from the scratch folder: a GNU tar (Git for Windows puts one on PATH)
    // would read "C:\..." as a file on a host called "C".
    const run = (args) => childProcess.spawnSync(tarProgram(), args, { cwd: directory, encoding: "utf8", windowsHide: true });
    const fail = (result) =>
      new Error(
        `Couldn't open a .tar.xz file: sof uses the tar program for those, and ${
          result.error ? "none was found" : `it failed (${String(result.stderr).trim().split("\n")[0]})`
        }.`
      );

    // The other formats are read in memory and never touch the disk. Here tar does write files, so
    // an archive with symbolic or hard links (which could point a later entry outside the scratch
    // folder) is refused before anything is unpacked.
    const listing = run(["-tvJf", "asset.tar.xz"]);
    if (listing.error || listing.status !== 0) {
      throw fail(listing);
    }
    if (/^[lh]/m.test(listing.stdout)) {
      throw new Error("Refusing to unpack a .tar.xz file that contains symbolic or hard links.");
    }

    const result = run(["-xJf", "asset.tar.xz", "-C", "out"]);
    if (result.error || result.status !== 0) {
      throw fail(result);
    }

    const entries = [];
    const visit = (folder) => {
      for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
        const full = path.join(folder, item.name);
        if (item.isDirectory()) {
          visit(full);
        } else if (item.isFile() && fs.statSync(full).size <= limit) {
          const data = fs.readFileSync(full);
          entries.push({
            path: path.relative(output, full).split(path.sep).join("/"),
            executable: (fs.statSync(full).mode & 0o111) !== 0,
            read: () => data,
          });
        }
      }
    };
    visit(output);
    return entries;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// The entry that is the tool: named like the repository (or the alias), else the only
// executable-looking file, else the only file.
function chooseEntry(entries, wantedNames) {
  const files = entries.filter((entry) => !IGNORED_ENTRY_PATTERN.test(entry.path.replace(/\\/g, "/")));

  for (const wanted of wantedNames) {
    const matches = files
      .filter((entry) => stripExe(baseName(entry.path)) === wanted)
      .sort((a, b) => a.path.split(/[\\/]/).length - b.path.split(/[\\/]/).length);
    if (matches.length > 0) {
      return matches[0];
    }
  }

  const executables = files.filter((entry) => entry.executable || /\.exe$/i.test(entry.path));
  if (executables.length === 1) {
    return executables[0];
  }

  return files.length === 1 ? files[0] : null;
}

// wantedNames: lower-case file names (without .exe) to look for, best first. maxBytes caps how
// large the executable may be once unpacked.
async function extractExecutable(buffer, assetName, wantedNames, { maxBytes = MAX_EXECUTABLE_BYTES } = {}) {
  const format = archiveFormat(assetName);

  let data;
  if (format === "raw") {
    data = buffer;
  } else if (format === "gz") {
    try {
      data = zlib.gunzipSync(buffer, { maxOutputLength: maxBytes });
    } catch (err) {
      throw new Error(
        `Couldn't unpack ${assetName}: ${err.code === "ERR_BUFFER_TOO_LARGE" ? `it expands to more than ${Math.round(maxBytes / 1048576)} MB` : err.message}.`
      );
    }
  } else if (format === "zip" || format === "tar.gz" || format === "tar" || format === "tar.xz") {
    const entries =
      format === "zip"
        ? readZipEntries(buffer, maxBytes)
        : format === "tar.xz"
          ? readTarXzEntries(buffer, maxBytes)
          : await readTarEntries(buffer, maxBytes);
    const entry = chooseEntry(entries, wantedNames);
    if (!entry) {
      const names = entries.map((candidate) => candidate.path).slice(0, 12).join(", ");
      throw new Error(`Couldn't tell which file in ${assetName} is "${wantedNames[0]}" (it holds: ${names || "nothing"}).`);
    }
    data = entry.read();
  } else {
    throw new Error(`sof can't open ${assetName}: only .zip, .tar.gz, .tar.xz, .tar, .gz and plain executables are supported.`);
  }

  if (!Buffer.isBuffer(data) || data.length === 0) {
    throw new Error(`The executable in ${assetName} is empty.`);
  }

  return data;
}

module.exports = {
  chooseEntry,
  extractExecutable,
  tarProgram,
};
