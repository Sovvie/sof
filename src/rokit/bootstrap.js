"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const AdmZip = require("adm-zip");

const ROKIT_OWNER = "rojo-rbx";
const ROKIT_REPO = "rokit";
const ROKIT_RELEASES_API = `https://api.github.com/repos/${ROKIT_OWNER}/${ROKIT_REPO}/releases`;
const ROKIT_STORAGE_DIR = path.join(os.homedir(), ".sof", "rokit");
const ROKIT_METADATA_PATH = path.join(ROKIT_STORAGE_DIR, "version.json");

function getRokitBinaryFileName() {
  return process.platform === "win32" ? "rokit.exe" : "rokit";
}

function getRokitBinaryPath() {
  return path.join(ROKIT_STORAGE_DIR, getRokitBinaryFileName());
}

function createGithubHeaders(accept) {
  const headers = {
    Accept: accept || "application/vnd.github+json",
    "User-Agent": "sof-cli",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const token = process.env.GITHUB_TOKEN;
  if (typeof token === "string" && token.trim() !== "") {
    headers.Authorization = `Bearer ${token.trim()}`;
  }

  return headers;
}

async function requestJson(url, allowNotFound) {
  const response = await fetch(url, {
    headers: createGithubHeaders("application/vnd.github+json"),
  });

  if (allowNotFound && response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `GitHub API request failed (${response.status} ${response.statusText}) for ${url}` +
        (body ? `: ${body.slice(0, 200)}` : "")
    );
  }

  return response.json();
}

async function requestBuffer(url) {
  const response = await fetch(url, {
    headers: createGithubHeaders("application/octet-stream"),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Artifact download failed (${response.status} ${response.statusText}) for ${url}` +
        (body ? `: ${body.slice(0, 200)}` : "")
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

function normalizeVersion(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/^v/i, "");
}

function getPlatformSuffix() {
  if (process.platform === "win32") {
    if (process.arch === "x64") {
      return "windows-x86_64";
    }
    if (process.arch === "arm64") {
      return "windows-aarch64";
    }
  }

  if (process.platform === "darwin") {
    if (process.arch === "x64") {
      return "macos-x86_64";
    }
    if (process.arch === "arm64") {
      return "macos-aarch64";
    }
  }

  if (process.platform === "linux") {
    if (process.arch === "x64") {
      return "linux-x86_64";
    }
    if (process.arch === "arm64") {
      return "linux-aarch64";
    }
  }

  throw new Error(
    `Unsupported platform for Rokit bootstrap: ${process.platform}/${process.arch}`
  );
}

function readInstalledMetadata() {
  if (!fs.existsSync(ROKIT_METADATA_PATH)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(ROKIT_METADATA_PATH, "utf8"));
  } catch (_err) {
    return null;
  }
}

function writeInstalledMetadata(metadata) {
  fs.mkdirSync(ROKIT_STORAGE_DIR, { recursive: true });
  fs.writeFileSync(ROKIT_METADATA_PATH, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

async function resolveRequestedRelease() {
  const requestedVersion = normalizeVersion(process.env.ROKIT_VERSION || "");
  if (!requestedVersion) {
    const latest = await requestJson(`${ROKIT_RELEASES_API}/latest`, false);
    return {
      requestedVersion: "",
      release: latest,
    };
  }

  const tagsToTry = Array.from(
    new Set(
      [`v${requestedVersion}`, requestedVersion].filter((entry) => entry && entry.trim() !== "")
    )
  );

  for (const tag of tagsToTry) {
    const release = await requestJson(`${ROKIT_RELEASES_API}/tags/${tag}`, true);
    if (release) {
      return {
        requestedVersion,
        release,
      };
    }
  }

  throw new Error(`Unable to find a Rokit release matching "${requestedVersion}".`);
}

function pickReleaseAsset(release, resolvedVersion) {
  const platformSuffix = getPlatformSuffix();
  const exactAssetName = `rokit-${resolvedVersion}-${platformSuffix}.zip`;
  const assets = Array.isArray(release.assets) ? release.assets : [];

  const exact = assets.find((asset) => asset && asset.name === exactAssetName);
  if (exact) {
    return exact;
  }

  const fallback = assets.find(
    (asset) =>
      asset &&
      typeof asset.name === "string" &&
      asset.name.endsWith(`-${platformSuffix}.zip`) &&
      typeof asset.browser_download_url === "string"
  );
  if (fallback) {
    return fallback;
  }

  throw new Error(
    `Could not find a compatible Rokit release asset (${exactAssetName}) for this platform.`
  );
}

function extractRokitBinary(zipBuffer) {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
  const expectedName = getRokitBinaryFileName().toLowerCase();

  let selectedEntry = entries.find(
    (entry) => path.posix.basename(entry.entryName).toLowerCase() === expectedName
  );

  if (!selectedEntry && entries.length === 1) {
    selectedEntry = entries[0];
  }

  if (!selectedEntry) {
    throw new Error("Downloaded Rokit archive did not contain an executable binary.");
  }

  const binaryBuffer = selectedEntry.getData();
  if (!Buffer.isBuffer(binaryBuffer) || binaryBuffer.length === 0) {
    throw new Error("Downloaded Rokit archive contained an empty executable.");
  }

  return binaryBuffer;
}

function shouldDownloadRokit(forceDownload, binaryPath, requestedVersion, installedVersion) {
  if (forceDownload) {
    return true;
  }

  if (!fs.existsSync(binaryPath)) {
    return true;
  }

  if (!requestedVersion) {
    return false;
  }

  return requestedVersion !== installedVersion;
}

async function ensureRokit(options) {
  const settings = options || {};
  const forceDownload = Boolean(settings.forceDownload);
  const binaryPath = getRokitBinaryPath();
  const installedMetadata = readInstalledMetadata();
  const installedVersion =
    installedMetadata && typeof installedMetadata.version === "string"
      ? normalizeVersion(installedMetadata.version)
      : "";
  const requestedVersion = normalizeVersion(process.env.ROKIT_VERSION || "");

  if (!shouldDownloadRokit(forceDownload, binaryPath, requestedVersion, installedVersion)) {
    return {
      binaryPath,
      version: installedVersion || null,
      didDownload: false,
    };
  }

  const resolved = await resolveRequestedRelease();
  const release = resolved.release || {};
  const resolvedVersion = normalizeVersion(release.tag_name || release.name || "");
  if (!resolvedVersion) {
    throw new Error("Unable to resolve Rokit version from GitHub release metadata.");
  }

  const asset = pickReleaseAsset(release, resolvedVersion);
  if (!asset || typeof asset.browser_download_url !== "string") {
    throw new Error("Release asset metadata is missing a browser download URL.");
  }

  console.log(`Downloading Rokit ${resolvedVersion} (${asset.name})...`);
  const archiveBuffer = await requestBuffer(asset.browser_download_url);
  const binaryBuffer = extractRokitBinary(archiveBuffer);

  fs.mkdirSync(ROKIT_STORAGE_DIR, { recursive: true });
  fs.writeFileSync(binaryPath, binaryBuffer);
  if (process.platform !== "win32") {
    fs.chmodSync(binaryPath, 0o755);
  }

  writeInstalledMetadata({
    version: resolvedVersion,
    requestedVersion: resolved.requestedVersion || null,
    assetName: asset.name || null,
    downloadedAt: new Date().toISOString(),
  });

  return {
    binaryPath,
    version: resolvedVersion,
    didDownload: true,
  };
}

module.exports = {
  ensureRokit,
  getRokitBinaryPath,
};
