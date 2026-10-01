"use strict";

// Local copy of the rules the registry enforces on every upload, so a bad package fails here
// with a clear list instead of after an upload. The registry stays the authority: it checks
// everything again server-side.

const fs = require("fs");
const tar = require("tar");
const { ADDON_SCOPE } = require("../addons/store");

const MEGABYTE = 1024 * 1024;
const LIMITS = {
  entries: 1000,
  fileBytes: 4 * MEGABYTE,
  expandedBytes: 20 * MEGABYTE,
  uploadBytes: 6 * MEGABYTE,
  pathChars: 240,
  pathDepth: 12,
};

const SCOPE_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}$/;
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ALIAS_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// MAJOR.MINOR.PATCH[-prerelease], no +build metadata.
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
const REALMS = ["shared", "server", "client", "dev", "addon"];

const FILE_EXTENSIONS = [".luau", ".lua", ".json", ".toml", ".md", ".txt", ".yml", ".yaml"];
const ADDON_FILE_EXTENSIONS = [".js", ".mjs", ".cjs"];
const EXTENSIONLESS_FILES = /^(LICENSE|LICENCE|NOTICE|README|CHANGELOG|COPYING)$/i;
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

// Problems with the [[package]] fields that go into the upload's metadata.
function validatePackageMetadata(packageEntry) {
  const problems = [];
  const [scope = "", name = ""] = String(packageEntry.name).split("/");

  if (!SCOPE_PATTERN.test(scope)) {
    problems.push(`scope "${scope}" must match ${SCOPE_PATTERN} (lowercase letters, digits and "-").`);
  }
  if (!NAME_PATTERN.test(name)) {
    problems.push(`package name "${name}" must match ${NAME_PATTERN} (lowercase letters, digits, "-" and "_").`);
  }
  if (!VERSION_PATTERN.test(packageEntry.version)) {
    problems.push(
      `version "${packageEntry.version}" must be MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-prerelease (no +build metadata).`
    );
  }
  if (!REALMS.includes(packageEntry.realm)) {
    problems.push(`realm "${packageEntry.realm}" must be one of: ${REALMS.join(", ")}.`);
  } else if (packageEntry.realm === "addon" && scope !== ADDON_SCOPE) {
    problems.push(`realm "addon" is only accepted in the "${ADDON_SCOPE}" scope.`);
  }
  if (packageEntry.description.length > 1000) {
    problems.push("description is longer than 1000 characters.");
  }
  if (packageEntry.license.length > 100) {
    problems.push("license is longer than 100 characters.");
  }
  if (packageEntry.authors.length > 20) {
    problems.push("more than 20 authors.");
  }
  if (packageEntry.authors.some((author) => author.length > 100)) {
    problems.push("an author entry is longer than 100 characters.");
  }
  for (const dependency of packageEntry.dependencies || []) {
    if (!ALIAS_PATTERN.test(dependency.alias)) {
      problems.push(`dependency alias "${dependency.alias}" must match ${ALIAS_PATTERN}.`);
    }
  }

  return problems;
}

function allowedExtensions(scope) {
  return scope === ADDON_SCOPE ? [...FILE_EXTENSIONS, ...ADDON_FILE_EXTENSIONS] : FILE_EXTENSIONS;
}

function lastSegmentExtension(fileName) {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot).toLowerCase() : "";
}

// Problems with the archive's contents.
async function validateArchive(archivePath, packageEntry) {
  const scope = String(packageEntry.name).split("/")[0];
  const extensions = allowedExtensions(scope);
  const problems = [];
  const seenPaths = new Map();
  let entryCount = 0;
  let expandedBytes = 0;

  if (fs.statSync(archivePath).size > LIMITS.uploadBytes) {
    problems.push(`the upload is larger than ${LIMITS.uploadBytes / MEGABYTE} MB.`);
  }

  const inspectEntry = (entry) => {
    entryCount += 1;
    const entryPath = String(entry.path);
    const isDirectory = entry.type === "Directory";
    const label = `"${entryPath}"`;

    if (entry.type !== "File" && !isDirectory) {
      problems.push(`${label} is a ${entry.type}; only regular files and directories are allowed.`);
      return;
    }

    if (entryPath.includes("\\")) {
      problems.push(`${label} contains a backslash.`);
    }

    const trimmed = entryPath.replace(/\/+$/, "");
    const segments = trimmed.split("/");
    if (trimmed.startsWith("/") || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      problems.push(`${label} is not a plain relative path.`);
      return;
    }
    if (trimmed.length > LIMITS.pathChars) {
      problems.push(`${label} is longer than ${LIMITS.pathChars} characters.`);
    }
    if (segments.length > LIMITS.pathDepth) {
      problems.push(`${label} is nested deeper than ${LIMITS.pathDepth} levels.`);
    }
    if (trimmed !== trimmed.normalize("NFC")) {
      problems.push(`${label} is not Unicode NFC normalized.`);
    }
    if (segments.some((segment) => segment.toLowerCase() === ".git" || segment.toLowerCase() === "node_modules")) {
      problems.push(`${label} is inside .git or node_modules.`);
    }
    if (segments.some((segment) => WINDOWS_RESERVED.test(segment.split(".")[0]))) {
      problems.push(`${label} uses a Windows-reserved name (CON, NUL, COM1, ...).`);
    }

    const folded = trimmed.toLowerCase();
    if (seenPaths.has(folded) && seenPaths.get(folded) !== trimmed) {
      problems.push(`${label} and "${seenPaths.get(folded)}" differ only by case.`);
    }
    seenPaths.set(folded, trimmed);

    if (isDirectory) {
      return;
    }

    const fileName = segments[segments.length - 1];
    const extension = lastSegmentExtension(fileName);
    const allowed = extension ? extensions.includes(extension) : EXTENSIONLESS_FILES.test(fileName);
    if (!allowed) {
      problems.push(`${label} is not an allowed file type (allowed: ${extensions.join(" ")}).`);
    }

    if (entry.size > LIMITS.fileBytes) {
      problems.push(`${label} is larger than ${LIMITS.fileBytes / MEGABYTE} MB.`);
    }
    expandedBytes += entry.size;
  };

  try {
    // strict: node-tar otherwise shrugs at a corrupt archive and reports it as empty.
    await tar.t({ file: archivePath, strict: true, onReadEntry: inspectEntry });
  } catch (err) {
    // Also where node-tar's own decompression-bomb guard ends up.
    problems.push(`the archive could not be read: ${err.message}.`);
  }

  if (entryCount === 0 && problems.length === 0) {
    problems.push("the archive is empty.");
  }
  if (entryCount > LIMITS.entries) {
    problems.push(`the archive has ${entryCount} entries; the limit is ${LIMITS.entries}.`);
  }
  if (expandedBytes > LIMITS.expandedBytes) {
    problems.push(`the files add up to more than ${LIMITS.expandedBytes / MEGABYTE} MB expanded.`);
  }

  return problems;
}

function failWithProblems(packageName, problems) {
  const shown = problems.slice(0, 20).map((problem) => `  - ${problem}`);
  if (problems.length > shown.length) {
    shown.push(`  ...and ${problems.length - shown.length} more`);
  }
  return new Error(`${packageName} would be rejected by the registry:\n${shown.join("\n")}`);
}

module.exports = {
  LIMITS,
  failWithProblems,
  validateArchive,
  validatePackageMetadata,
};
