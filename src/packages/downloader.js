"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const AdmZip = require("adm-zip");
const tar = require("tar");

function createChecksum(buffer) {
  return `sha256:${crypto.createHash("sha256").update(buffer).digest("hex")}`;
}

function sanitizeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, "_");
}

function normalizeArchivePath(archivePath) {
  return String(archivePath || "").replace(/\\/g, "/");
}

function sanitizeArchiveEntryPath(archivePath) {
  const normalized = normalizeArchivePath(archivePath).trim();
  if (!normalized) {
    return {
      reason: "entry path is empty",
      path: "",
    };
  }

  if (normalized.startsWith("/") || normalized.startsWith("\\") || /^[A-Za-z]:/.test(normalized)) {
    return {
      reason: "entry path is absolute",
      path: "",
    };
  }

  const cleanedSegments = [];
  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }

    if (segment === "..") {
      return {
        reason: "entry path contains traversal segment '..'",
        path: "",
      };
    }

    cleanedSegments.push(segment);
  }

  if (cleanedSegments.length === 0) {
    return {
      reason: "entry path resolves to current directory",
      path: "",
    };
  }

  return {
    reason: null,
    path: cleanedSegments.join("/"),
  };
}

function resolveSafeDestination(baseDirectory, archivePath) {
  const sanitized = sanitizeArchiveEntryPath(archivePath);
  if (sanitized.reason) {
    throw new Error(`Unsafe archive entry "${archivePath}": ${sanitized.reason}.`);
  }

  const resolved = path.resolve(baseDirectory, sanitized.path);
  const relative = path.relative(baseDirectory, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe archive entry "${archivePath}": path escapes destination directory.`);
  }

  return {
    archivePath: sanitized.path,
    destinationPath: resolved,
  };
}

function extractZipBuffer(buffer, destinationDirectory) {
  const zip = new AdmZip(buffer);
  for (const entry of zip.getEntries()) {
    const safeEntry = resolveSafeDestination(destinationDirectory, entry.entryName);

    if (entry.isDirectory) {
      fs.mkdirSync(safeEntry.destinationPath, { recursive: true });
      continue;
    }

    fs.mkdirSync(path.dirname(safeEntry.destinationPath), { recursive: true });
    fs.writeFileSync(safeEntry.destinationPath, entry.getData());
  }
}

async function extractTarGzBuffer(buffer, destinationDirectory) {
  const archivePath = path.join(destinationDirectory, "__archive.tar.gz");
  fs.writeFileSync(archivePath, buffer);

  let blockedEntry = null;
  try {
    await tar.x({
      file: archivePath,
      cwd: destinationDirectory,
      preservePaths: false,
      filter: (entryPath) => {
        try {
          resolveSafeDestination(destinationDirectory, entryPath);
          return true;
        } catch (err) {
          blockedEntry = err.message;
          return false;
        }
      },
    });
  } finally {
    if (fs.existsSync(archivePath)) {
      fs.rmSync(archivePath, { force: true });
    }
  }

  if (blockedEntry) {
    throw new Error(`Blocked unsafe tar archive entry: ${blockedEntry}`);
  }
}

async function extractArchiveBuffer(buffer, archiveType, destinationDirectory) {
  if (archiveType === "zip") {
    extractZipBuffer(buffer, destinationDirectory);
    return;
  }

  if (archiveType === "tar.gz") {
    await extractTarGzBuffer(buffer, destinationDirectory);
    return;
  }

  throw new Error(`Unsupported archive type: ${archiveType}`);
}

function determinePackageRoot(extractedDirectory) {
  const entries = fs.readdirSync(extractedDirectory, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory()) {
    return path.join(extractedDirectory, entries[0].name);
  }

  return extractedDirectory;
}

async function downloadPackages(params) {
  const entries = params.entries || [];
  const registry = params.registry;
  if (!registry) {
    throw new Error("downloadPackages requires a registry instance.");
  }

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "sof-install-"));
  const downloadedEntries = [];

  try {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const downloaded = await registry.downloadPackage(entry.source, entry.name, entry.version);
      if (!downloaded || !Buffer.isBuffer(downloaded.buffer)) {
        throw new Error(`Registry returned invalid package data for ${entry.name}@${entry.version}.`);
      }

      const checksum = createChecksum(downloaded.buffer);
      if (
        typeof entry.expectedChecksum === "string" &&
        entry.expectedChecksum.trim() !== "" &&
        entry.expectedChecksum !== checksum
      ) {
        throw new Error(
          `Checksum mismatch for ${entry.name}@${entry.version} from registry metadata: expected ${entry.expectedChecksum}, got ${checksum}.`
        );
      }

      if (
        typeof entry.lockedChecksum === "string" &&
        entry.lockedChecksum.trim() !== "" &&
        entry.lockedChecksum !== checksum
      ) {
        throw new Error(
          `Checksum mismatch for ${entry.name}@${entry.version} from sof.lock: expected ${entry.lockedChecksum}, got ${checksum}.`
        );
      }

      const extractedDirectory = path.join(
        temporaryDirectory,
        `${String(index + 1).padStart(4, "0")}-${sanitizeSegment(entry.alias)}`
      );
      fs.mkdirSync(extractedDirectory, { recursive: true });

      await extractArchiveBuffer(downloaded.buffer, downloaded.archiveType, extractedDirectory);

      downloadedEntries.push({
        ...entry,
        checksum,
        extractedPath: determinePackageRoot(extractedDirectory),
      });
    }
  } catch (err) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    throw err;
  }

  return {
    temporaryDirectory,
    entries: downloadedEntries,
  };
}

function cleanupDownloadedPackages(temporaryDirectory) {
  if (!temporaryDirectory) {
    return;
  }

  fs.rmSync(temporaryDirectory, {
    recursive: true,
    force: true,
  });
}

module.exports = {
  cleanupDownloadedPackages,
  downloadPackages,
};
